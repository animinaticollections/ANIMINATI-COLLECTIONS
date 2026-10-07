CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    razorpay_order_id TEXT UNIQUE,
    receipt TEXT UNIQUE NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL DEFAULT 'creating'
        CHECK (status IN ('creating', 'created', 'paid', 'failed', 'refunded')),
    payment_id TEXT,
    payment_status TEXT,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    customer_email TEXT,
    address_line1 TEXT NOT NULL,
    address_line2 TEXT,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    postal_code TEXT NOT NULL,
    items_json TEXT NOT NULL,
    failure_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    paid_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_orders_status_created_at
    ON orders (status, created_at);

CREATE INDEX IF NOT EXISTS idx_orders_payment_id
    ON orders (payment_id);

CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_order_id
    ON webhook_events (razorpay_order_id);
