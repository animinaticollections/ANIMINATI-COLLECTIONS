const CATALOG = Object.freeze({
    1: { price: 899, sizes: ["S", "M", "L", "XL"] },
    2: { price: 1199, sizes: ["S", "M", "L", "XL"] },
    3: { price: 1399, sizes: ["30", "32", "34", "36"] },
    4: { price: 699, sizes: ["S", "M", "L"] },
    5: { price: 1099, sizes: ["S", "M", "L", "XL"] },
    6: { price: 1299, sizes: ["S", "M", "L"] },
    7: { price: 899, sizes: ["S", "M", "L", "XL", "XXL"] },
    8: { price: 1499, sizes: ["S", "M", "L", "XL", "XXL"] },
    9: { price: 1299, sizes: ["S", "M", "L", "XL"] },
    10: { price: 1999, sizes: ["6", "7", "8", "9", "10"] },
    11: { price: 799, sizes: ["6", "7", "8", "9", "10"] },
    12: { price: 999, sizes: ["One Size"] }
});

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

function cleanText(value, maximum, required) {
    if (typeof value !== "string") return "";
    const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (required && !result) return "";
    if (result.length > maximum) return "";
    return result;
}

function sameOrigin(request) {
    const origin = request.headers.get("Origin");
    return !origin || origin === new URL(request.url).origin;
}

function authHeader(env) {
    return "Basic " + btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET);
}

export async function onRequestPost(context) {
    const request = context.request;
    const env = context.env;

    if (!sameOrigin(request)) {
        return jsonResponse({ error: "Checkout requests must come from this website." }, 403);
    }

    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.DB) {
        return jsonResponse({ error: "Online payment is not configured yet. Please contact the store." }, 503);
    }

    if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) {
        return jsonResponse({ error: "Invalid checkout request." }, 415);
    }

    let payload;
    try {
        const rawBody = await request.text();
        if (rawBody.length > 12000) {
            return jsonResponse({ error: "Checkout details are too large." }, 413);
        }
        payload = JSON.parse(rawBody);
    } catch {
        return jsonResponse({ error: "Invalid checkout request." }, 400);
    }

    if (!payload || !Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 15) {
        return jsonResponse({ error: "Your bag could not be validated. Refresh the page and try again." }, 400);
    }

    const customer = payload.customer;
    if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
        return jsonResponse({ error: "Please enter valid delivery details." }, 400);
    }

    const name = cleanText(customer.name, 80, true);
    const phone = typeof customer.phone === "string" ? customer.phone.replace(/\D/g, "") : "";
    const email = cleanText(customer.email, 120, false);
    const addressLine1 = cleanText(customer.addressLine1, 100, true);
    const addressLine2 = cleanText(customer.addressLine2, 100, false);
    const city = cleanText(customer.city, 60, true);
    const state = cleanText(customer.state, 60, true);
    const postalCode = typeof customer.postalCode === "string" ? customer.postalCode.trim() : "";

    if (!name || !/^[6-9][0-9]{9}$/.test(phone) ||
        (customer.email && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) ||
        !addressLine1 || !city || !state || !/^[1-9][0-9]{5}$/.test(postalCode) ||
        (customer.addressLine2 && !addressLine2)) {
        return jsonResponse({ error: "Please check your name, mobile number and delivery address." }, 400);
    }

    const lines = new Map();
    let totalRupees = 0;

    for (const item of payload.items) {
        const id = Number(item && item.id);
        const product = CATALOG[id];
        const size = item && typeof item.size === "string" ? item.size : "";
        const quantity = Number(item && item.quantity);

        if (!product || !product.sizes.includes(size) ||
            !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
            return jsonResponse({ error: "A product or size in your bag is no longer valid. Refresh the page and try again." }, 400);
        }

        const lineKey = id + ":" + size;
        const current = lines.get(lineKey);
        const combinedQuantity = (current ? current.quantity : 0) + quantity;

        if (combinedQuantity > 10) {
            return jsonResponse({ error: "A bag item cannot have more than 10 of the same size." }, 400);
        }

        lines.set(lineKey, { id: id, size: size, quantity: combinedQuantity, price: product.price });
    }

    if (lines.size > 15) {
        return jsonResponse({ error: "Please reduce the number of different sizes in your bag to continue." }, 400);
    }

    const orderItems = Array.from(lines.values());
    for (const item of orderItems) {
        totalRupees += item.price * item.quantity;
    }

    const amount = totalRupees * 100;
    const itemSummary = orderItems.map(item =>
        item.id + ":" + item.size + "x" + item.quantity
    ).join(", ");

    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000000 || itemSummary.length > 256) {
        return jsonResponse({ error: "Your bag total is outside the supported checkout range." }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const internalOrderId = crypto.randomUUID();

    const notes = {
        store: STORE_NOTE,
        customer_name: name,
        customer_phone: phone,
        shipping_address_1: addressLine1,
        shipping_city: city,
        shipping_state: state,
        shipping_pincode: postalCode,
        items: itemSummary
    };

    if (addressLine2) notes.shipping_address_2 = addressLine2;
    if (email) notes.customer_email = email;

    const receipt = "ANI" + crypto.randomUUID().replace(/-/g, "").slice(0, 32);

    try {
        await env.DB.prepare(
            `INSERT INTO orders (
                id, razorpay_order_id, receipt, amount, currency, status,
                customer_name, customer_phone, customer_email, address_line1,
                address_line2, city, state, postal_code, items_json,
                created_at, updated_at
            ) VALUES (?, NULL, ?, ?, 'INR', 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            internalOrderId,
            receipt,
            amount,
            name,
            phone,
            email || null,
            addressLine1,
            addressLine2 || null,
            city,
            state,
            postalCode,
            JSON.stringify(orderItems),
            now,
            now
        ).run();
    } catch {
        return jsonResponse({ error: "We could not save your order. Please try again." }, 503);
    }

    let gatewayResponse;
    try {
        gatewayResponse = await fetch("https://api.razorpay.com/v1/orders", {
            method: "POST",
            headers: {
                "Authorization": authHeader(env),
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                amount: amount,
                currency: "INR",
                receipt: receipt,
                partial_payment: false,
                notes: notes
            })
        });
    } catch {
        return jsonResponse({ error: "Razorpay could not be reached. Please try again." }, 502);
    }

    if (!gatewayResponse.ok) {
        try {
            await env.DB.prepare(
                "UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?"
            ).bind("Razorpay order creation failed", Math.floor(Date.now() / 1000), internalOrderId).run();
        } catch {}
        return jsonResponse({ error: "Razorpay could not create your order. Please try again." }, 502);
    }

    let order;
    try {
        order = await gatewayResponse.json();
    } catch {
        return jsonResponse({ error: "Razorpay returned an invalid order response." }, 502);
    }

    if (!order || typeof order.id !== "string" || order.amount !== amount || order.currency !== "INR") {
        try {
            await env.DB.prepare(
                "UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?"
            ).bind("Invalid Razorpay order response", Math.floor(Date.now() / 1000), internalOrderId).run();
        } catch {}
        return jsonResponse({ error: "Razorpay returned an invalid order response." }, 502);
    }

    try {
        await env.DB.prepare(
            "UPDATE orders SET razorpay_order_id = ?, status = 'created', updated_at = ? WHERE id = ?"
        ).bind(order.id, Math.floor(Date.now() / 1000), internalOrderId).run();
    } catch {
        return jsonResponse({ error: "We could not finalize your order. Please try again." }, 502);
    }

    return jsonResponse({
        keyId: env.RAZORPAY_KEY_ID,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency
    }, 200);
}