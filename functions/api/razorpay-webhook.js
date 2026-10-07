const STORE_NOTE = "AniMinati Collections";

function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
        status: status,
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

    const eventType = payload && payload.event;
    if (eventType !== "order.paid" && eventType !== "payment.failed") {
        return jsonResponse({ received: true, ignored: true }, 200);
    }

    const payment = payload?.payload?.payment?.entity;
    const order = payload?.payload?.order?.entity;

    const paymentId = payment && payment.id;
    const orderId = payment && payment.order_id;
    const amount = payment && payment.amount;
    const currency = payment && payment.currency;

    if (!validId(paymentId, "pay") || !validId(orderId, "order") ||
        !Number.isSafeInteger(amount) || amount < 1 || currency !== "INR") {
        return jsonResponse({ error: "Invalid payment webhook payload." }, 400);
    }

    if (eventType === "order.paid") {
        if (!order || order.id !== orderId || order.currency !== "INR" ||
            order.status !== "paid" || order.amount !== amount ||
            !order.notes || order.notes.store !== STORE_NOTE ||
            payment.status !== "captured" || payment.captured !== true) {
            return jsonResponse({
                error: "Payment webhook does not match an AniMinati Collections order."
            }, 400);
        }
    }

    const storedOrder = await env.DB.prepare(
        "SELECT id, amount, currency FROM orders WHERE razorpay_order_id = ?"
    ).bind(orderId).first();

    if (!storedOrder) {
        return jsonResponse({ error: "Order is not available yet." }, 404);
    }

    if (storedOrder.amount !== amount || storedOrder.currency !== "INR") {
        return jsonResponse({ error: "Webhook amount does not match the stored order." }, 400);
    }

    const alreadyProcessed = await env.DB.prepare(
        "SELECT event_id FROM webhook_events WHERE event_id = ?"
    ).bind(eventId).first();

    if (alreadyProcessed) {
        return jsonResponse({ received: true, duplicate: true }, 200);
    }

    const now = Math.floor(Date.now() / 1000);

    try {
        if (eventType === "order.paid") {
            await env.DB.batch([
                env.DB.prepare(
                    "INSERT INTO webhook_events (event_id, event_type, razorpay_order_id, razorpay_payment_id, received_at) VALUES (?, ?, ?, ?, ?)"
                ).bind(eventId, eventType, orderId, paymentId, now),
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
                ).bind(paymentId, now, now, orderId, amount)
            ]);
        } else {
            const failureReason = typeof payment.error_description === "string"
                ? payment.error_description.slice(0, 500)
                : "Payment failed.";

            await env.DB.batch([
                env.DB.prepare(
                    "INSERT INTO webhook_events (event_id, event_type, razorpay_order_id, razorpay_payment_id, received_at) VALUES (?, ?, ?, ?, ?)"
                ).bind(eventId, eventType, orderId, paymentId, now),
                env.DB.prepare(
                    `UPDATE orders
                     SET status = CASE WHEN status = 'paid' THEN status ELSE 'failed' END,
                         payment_id = COALESCE(payment_id, ?),
                         payment_status = 'failed',
                         failure_reason = ?,
                         updated_at = ?
                     WHERE razorpay_order_id = ?
                       AND amount = ?
                       AND currency = 'INR'`
                ).bind(paymentId, failureReason, now, orderId, amount)
            ]);
        }
    } catch {
        return jsonResponse({
            error: "Webhook processing failed. Razorpay can retry this event."
        }, 500);
    }

    return jsonResponse({ received: true }, 200);
}
