const STORE_NOTE = "AniMinati Collections";

function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        }
    });
}

async function hmacHex(secret, message) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(message)
    );
    return Array.from(new Uint8Array(signature), byte =>
        byte.toString(16).padStart(2, "0")
    ).join("");
}

function timingSafeEqual(left, right) {
    if (left.length !== right.length) return false;
    let mismatch = 0;
    for (let i = 0; i < left.length; i++) {
        mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
    }
    return mismatch === 0;
}

function validId(value, prefix) {
    return typeof value === "string" &&
        new RegExp("^" + prefix + "_[A-Za-z0-9]+$").test(value);
}

export async function onRequestPost(context) {
    const request = context.request;
    const env = context.env;

    if (!env.DB || !env.RAZORPAY_WEBHOOK_SECRET) {
        return jsonResponse({ error: "Webhook processing is not configured." }, 503);
    }

    const signature = request.headers.get("X-Razorpay-Signature") || "";
    const eventId = request.headers.get("X-Razorpay-Event-Id") || "";

    if (!/^[A-Fa-f0-9]{64}$/.test(signature) || !eventId || eventId.length > 200) {
        return jsonResponse({ error: "Invalid webhook request." }, 400);
    }

    let rawBody;
    try {
        rawBody = await request.text();
        if (rawBody.length > 100000) {
            return jsonResponse({ error: "Webhook payload is too large." }, 413);
        }
    } catch {
        return jsonResponse({ error: "Invalid webhook request." }, 400);
    }

    const expectedSignature = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, rawBody);
    if (!timingSafeEqual(expectedSignature, signature.toLowerCase())) {
        return jsonResponse({ error: "Invalid webhook signature." }, 401);
    }

    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return jsonResponse({ error: "Invalid webhook payload." }, 400);
    }

    if (payload?.event !== "order.paid") {
        return jsonResponse({ received: true, ignored: true }, 200);
    }

    const order = payload?.payload?.order?.entity;
    const payment = payload?.payload?.payment?.entity;

    if (!order || !payment ||
        !validId(order.id, "order") ||
        !validId(payment.id, "pay") ||
        payment.order_id !== order.id ||
        order.currency !== "INR" ||
        payment.currency !== "INR" ||
        order.amount !== payment.amount ||
        order.status !== "paid" ||
        payment.status !== "captured" ||
        payment.captured !== true ||
        !order.notes ||
        order.notes.store !== STORE_NOTE) {
        return jsonResponse({ error: "Webhook does not match an AniMinati Collections payment." }, 400);
    }

    const notes = order.notes;
    const name = typeof notes.customer_name === "string" ? notes.customer_name.slice(0, 80) : "";
    const phone = typeof notes.customer_phone === "string" ? notes.customer_phone.slice(0, 20) : "";
    const email = typeof notes.customer_email === "string" ? notes.customer_email.slice(0, 120) : null;
    const addressLine1 = typeof notes.shipping_address_1 === "string" ? notes.shipping_address_1.slice(0, 100) : "";
    const addressLine2 = typeof notes.shipping_address_2 === "string" ? notes.shipping_address_2.slice(0, 100) : null;
    const city = typeof notes.shipping_city === "string" ? notes.shipping_city.slice(0, 60) : "";
    const state = typeof notes.shipping_state === "string" ? notes.shipping_state.slice(0, 60) : "";
    const postalCode = typeof notes.shipping_pincode === "string" ? notes.shipping_pincode.slice(0, 10) : "";
    const itemSummary = typeof notes.items === "string" ? notes.items.slice(0, 256) : "";

    if (!name || !phone || !addressLine1 || !city || !state || !postalCode || !itemSummary) {
        return jsonResponse({ error: "Webhook order details are incomplete." }, 400);
    }

    const alreadyProcessed = await env.DB.prepare(
        "SELECT event_id FROM webhook_events WHERE event_id = ?"
    ).bind(eventId).first();

    if (alreadyProcessed) {
        return jsonResponse({ received: true, duplicate: true }, 200);
    }

    const now = Math.floor(Date.now() / 1000);
    const createdAt = Number.isSafeInteger(order.created_at) ? order.created_at : now;
    const internalOrderId = crypto.randomUUID();

    try {
        await env.DB.batch([
            env.DB.prepare(
                `INSERT OR IGNORE INTO orders (
                    id, razorpay_order_id, receipt, amount, currency, status,
                    payment_id, payment_status, customer_name, customer_phone,
                    customer_email, address_line1, address_line2, city, state,
                    postal_code, items_json, created_at, updated_at, paid_at
                ) VALUES (?, ?, ?, ?, 'INR', 'paid', ?, 'captured', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
                internalOrderId,
                order.id,
                typeof order.receipt === "string" ? order.receipt : order.id,
                order.amount,
                payment.id,
                name,
                phone,
                email,
                addressLine1,
                addressLine2,
                city,
                state,
                postalCode,
                JSON.stringify({ summary: itemSummary }),
                createdAt,
                now,
                now
            ),
            env.DB.prepare(
                "INSERT INTO webhook_events (event_id, event_type, razorpay_order_id, razorpay_payment_id, received_at) VALUES (?, 'order.paid', ?, ?, ?)"
            ).bind(eventId, order.id, payment.id, now),
            env.DB.prepare(
                `UPDATE orders
                 SET status = 'paid',
                     payment_id = ?,
                     payment_status = 'captured',
                     paid_at = COALESCE(paid_at, ?),
                     updated_at = ?
                 WHERE razorpay_order_id = ?
                   AND amount = ?
                   AND currency = 'INR'`
            ).bind(payment.id, now, now, order.id, order.amount)
        ]);
    } catch {
        return jsonResponse({
            error: "Webhook processing failed. Razorpay can retry this event."
        }, 500);
    }

    return jsonResponse({ received: true }, 200);
}
