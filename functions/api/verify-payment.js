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

function sameOrigin(request) {
    const origin = request.headers.get("Origin");
    return !origin || origin === new URL(request.url).origin;
}

function authHeader(env) {
    return "Basic " + btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET);
}

async function hmacHex(secret, message) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
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

export async function onRequestPost(context) {
    const request = context.request;
    const env = context.env;

    if (!sameOrigin(request)) {
        return jsonResponse({ error: "Payment verification requests must come from this website." }, 403);
    }

    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
        return jsonResponse({ error: "Online payment is not configured yet." }, 503);
    }

    if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) {
        return jsonResponse({ error: "Invalid payment response." }, 415);
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return jsonResponse({ error: "Invalid payment response." }, 400);
    }

    const orderId = payload && payload.razorpay_order_id;
    const paymentId = payload && payload.razorpay_payment_id;
    const suppliedSignature = payload && payload.razorpay_signature;

    if (typeof orderId !== "string" || !/^order_[A-Za-z0-9]+$/.test(orderId) ||
        typeof paymentId !== "string" || !/^pay_[A-Za-z0-9]+$/.test(paymentId) ||
        typeof suppliedSignature !== "string" || !/^[A-Fa-f0-9]{64}$/.test(suppliedSignature)) {
        return jsonResponse({ error: "The payment response was incomplete." }, 400);
    }

    const expectedSignature = await hmacHex(
        env.RAZORPAY_KEY_SECRET,
        orderId + "|" + paymentId
    );

    if (!timingSafeEqual(expectedSignature, suppliedSignature.toLowerCase())) {
        return jsonResponse({ error: "We could not verify this payment response." }, 400);
    }

    const headers = { "Authorization": authHeader(env) };
    let orderResponse;
    let paymentResponse;

    try {
        [orderResponse, paymentResponse] = await Promise.all([
            fetch("https://api.razorpay.com/v1/orders/" + encodeURIComponent(orderId), { headers: headers }),
            fetch("https://api.razorpay.com/v1/payments/" + encodeURIComponent(paymentId), { headers: headers })
        ]);
    } catch {
        return jsonResponse({
            success: false,
            pending: true,
            message: "We could not reach Razorpay to confirm the payment. Please do not pay again until you check its status."
        }, 202);
    }

    if (!orderResponse.ok || !paymentResponse.ok) {
        return jsonResponse({
            success: false,
            pending: true,
            message: "Razorpay is still confirming the payment. Please do not pay again until you check its status."
        }, 202);
    }

    let order;
    let payment;
    try {
        [order, payment] = await Promise.all([
            orderResponse.json(),
            paymentResponse.json()
        ]);
    } catch {
        return jsonResponse({
            success: false,
            pending: true,
            message: "Razorpay returned an incomplete confirmation. Please do not pay again until you check its status."
        }, 202);
    }

    if (!order || order.id !== orderId || !order.notes ||
        order.notes.store !== STORE_NOTE ||
        order.currency !== "INR" ||
        !payment || payment.id !== paymentId ||
        payment.order_id !== orderId ||
        payment.currency !== "INR" ||
        payment.amount !== order.amount) {
        return jsonResponse({ error: "This payment does not match an AniMinati Collections order." }, 400);
    }

    if (order.status !== "paid" || order.amount_paid !== order.amount ||
        payment.status !== "captured" || payment.captured !== true) {
        return jsonResponse({
            success: false,
            pending: true,
            orderId: orderId,
            paymentId: paymentId,
            message: "Payment is still being confirmed. Please do not pay again. Check its status in Razorpay before retrying."
        }, 202);
    }

    return jsonResponse({
        success: true,
        orderId: orderId,
        paymentId: paymentId
    }, 200);
}