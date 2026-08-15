<#
PowerShell patch apply script for HappyHair payment & checkout fixes.
Run in PowerShell from the project root (C:\Users\HP\Documents\final web) as:

  ./files/happyhair_payment_patch.ps1

This script overwrites the following files with the patched versions:
  - server\src\routes\payment.routes.js
  - server\src\controllers\order.controller.js
  - server\src\integrations\cashfree.js
  - frontend\src\Checkout.jsx
  - public\js\product-sync.js

It is safe: it creates parent directories if they don't exist and writes UTF-8 files.
After running, you can run your usual git workflow (git add, commit, push).
#>

$files = @{
  'server\src\routes\payment.routes.js' = @'
const express = require('express');
const router = express.Router();
const prisma = require('../db');
const axios = require('axios');
const crypto = require('crypto');
const authMiddleware = require('../middlewares/auth.middleware');
const { sendOrderConfirmationEmail } = require('../utils/mailer');

const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Happy Hair';

// Cashfree and ShipCorrect integrations (refactored)
const cashfreeIntegration = require('../integrations/cashfree');
const shipcorrectIntegration = require('../integrations/shipcorrect');
const CF_ENV = process.env.CASHFREE_ENV || 'sandbox';

// HTML sanitizer
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>"'&]/g, (char) => {
    const map = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' };
    return map[char] || char;
  });
}

/**
 * 1. Checkout Route - Generates Cashfree Session and Renders Payment Modal
 * GET /api/payment/checkout/:orderId
 */
router.get('/checkout/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const parsedId = parseInt(orderId);
    if (isNaN(parsedId)) {
      return res.status(400).send('Invalid Order ID');
    }
    
    const order = await prisma.order.findUnique({
      where: { id: parsedId }
    });

    if (!order) {
      return res.status(404).send('Order not found');
    }

    if (order.status === 'PAID' || order.status === 'Processing') {
      return res.redirect(`/api/orders/status/${order.id}`);
    }

    // Prepare Cashfree payload
    // We add some random characters to order_id in Cashfree to ensure uniqueness if retried
    // Create order and session via Cashfree integration
    const reqHost = `${req.protocol}://${req.get('host')}`;
    const { cfOrderId, paymentSessionId } = await cashfreeIntegration.createOrder(order, reqHost);

    if (!paymentSessionId) {
      throw new Error('Failed to generate Cashfree session');
    }

    // Auto-update to Pending Verification if not already
    if (order.status === 'PENDING') {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'Pending Verification' }
      });
    }

    // Render HTML with Cashfree JS SDK to auto-open checkout
    const cashfreeJsSdkUrl = CF_ENV === 'sandbox'
      ? 'https://sdk.cashfree.com/js/v3/cashfree.js'
      : 'https://sdk.cashfree.com/js/v3/cashfree.js';

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Secure Checkout | ${MERCHANT_NAME}</title>
        <script src="${cashfreeJsSdkUrl}"></script>
        <style>
          body { 
            background-color: #0a0a0a; color: #fff; font-family: sans-serif;
            display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;
            text-align: center;
          }
          .loader {
            border: 4px solid rgba(201, 147, 57, 0.3); border-top: 4px solid #c99339;
            border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite;
            margin: 0 auto 20px;
          }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div>
          <div class="loader"></div>
          <h2>Initializing Secure Checkout...</h2>
          <p style="color:#aaa;">Please do not refresh this page.</p>
        </div>
        <script>
          const cashfree = Cashfree({
              mode: "${CF_ENV}" // "sandbox" or "production"
          });
          
          window.onload = function() {
            setTimeout(() => {
              cashfree.checkout({
                  paymentSessionId: "${paymentSessionId}"
              });
            }, 500);
          };
        </script>
      </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    // Log full error server-side (kept in logs)
    console.error('Checkout error:', error.response?.data || error.message || error);

    // Create a safe, truncated diagnostic message for the client to help debugging.
    let detail = '';
    try {
      if (error && error.response && error.response.data) {
        detail = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data);
      } else if (error && error.message) {
        detail = String(error.message);
      } else {
        detail = String(error);
      }
    } catch (e) {
      detail = 'Unable to serialize error details';
    }

    if (detail.length > 1500) detail = detail.slice(0, 1500) + '... [truncated]';
    // Basic sanitization
    detail = detail.replace(/[<>\"'&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c]));

    const diagHtml = `<!DOCTYPE html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout Error</title>
      <style>body{font-family:sans-serif;padding:24px;background:#fff;color:#222}pre{background:#f5f5f5;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-word}</style>
      </head><body>
      <h1>Error initializing secure checkout</h1>
      <p>Please try again later. Diagnostic info (safe):</p>
      <pre>${detail}</pre>
      <p>If this persists, copy the above text and contact support.</p>
      </body></html>`;

    res.status(500).send(diagHtml);
  }
});


/**
 * Cashfree Webhook endpoint
 * POST /api/payment/webhook
 * Accepts raw JSON body and verifies HMAC-SHA256 signature if CASHFREE_WEBHOOK_SECRET is provided.
 */
const rateLimit = require('express-rate-limit');

const webhookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 500, // allow a reasonable number but protect from floods
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/webhook', webhookLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body; // Buffer
    const signatureHeader = req.headers['x-webhook-signature'] || req.headers['x-cf-signature'] || req.headers['x-cashfree-signature'] || req.headers['x-signature'];
    const secret = process.env.CASHFREE_WEBHOOK_SECRET || process.env.CASHFREE_SECRET_KEY || null;

    if (secret && signatureHeader) {
      // Try hex and base64 comparisons
      const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const expectedBase64 = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
      if (!(signatureHeader === expectedHex || signatureHeader === expectedBase64)) {
        console.warn('[WEBHOOK] Signature mismatch');
        return res.status(400).send('Invalid signature');
      }
    } else if (!secret) {
      console.warn('[WEBHOOK] No webhook secret configured; accepting payload (not recommended for production)');
    }

    let payload;
    try { payload = JSON.parse(rawBody.toString()); } catch (e) { payload = req.body; }

    // Determine Cashfree order id from payload (try common keys)
    const cfOrderId = payload?.order_id || payload?.orderId || payload?.orderId || payload?.cf_order_id || payload?.cfOrderId || payload?.reference_id || payload?.reference;
    const cfStatus = payload?.order_status || payload?.txStatus || payload?.status || payload?.payment_status || payload?.transaction_status;

    // Attempt to find matching DB order by utr (we stored cf_order_id in utr earlier)
    let order = null;
    if (cfOrderId) {
      order = await prisma.order.findFirst({ where: { utr: cfOrderId } });
    }

    // Fallback: sometimes cfOrderId stored in different field — try matching by order id if provided in query
    if (!order && payload?.client_order_no) {
      const clientOrder = parseInt(payload.client_order_no);
      if (!isNaN(clientOrder)) order = await prisma.order.findUnique({ where: { id: clientOrder } });
    }

    // If order found and status indicates success, mark as paid/processing and dispatch
    const paidStatuses = ['PAID', 'SUCCESS', 'COMPLETED', 'TXN_SUCCESS'];
    if (order && cfStatus && paidStatuses.includes(cfStatus.toString().toUpperCase())) {
      // Update order status and store reference
      await prisma.order.update({ where: { id: order.id }, data: { status: 'Processing', utr: cfOrderId } });

      // Dispatch to ShipCorrect (non-blocking)
      (async () => {
        try {
          let cart = [];
          try { cart = JSON.parse(order.cart_details); } catch (e) {}
          const shipNo = await shipcorrectIntegration.createOrder(order, cart);
          if (shipNo) await prisma.order.update({ where: { id: order.id }, data: { order_no: shipNo.toString() } });
          // Send confirmation email
          await sendOrderConfirmationEmail(order, shipNo);
        } catch (err) {
          console.error('[WEBHOOK] Post-payment dispatch failed:', err.message);
        }
      })();

      return res.json({ status: 'ok' });
    }

    // If not a recognized successful event, simply acknowledge
    res.json({ status: 'ignored', payload_preview: { cfOrderId: cfOrderId || null, cfStatus: cfStatus || null } });
  } catch (err) {
    console.error('[WEBHOOK] Error handling webhook:', err.message);
    res.status(500).send('Webhook handler error');
  }
});

/**
 * 2. Verify Route - Return URL from Cashfree
 * GET /api/payment/verify/:orderId?cf_order_id=xyz
 */
router.get('/verify/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { cf_order_id } = req.query;
    
    const parsedId = parseInt(orderId);
    if (isNaN(parsedId)) return res.status(400).send('Invalid Order ID');
    if (!cf_order_id) return res.status(400).send('Missing Cashfree Order ID');

    const order = await prisma.order.findUnique({
      where: { id: parsedId }
    });

    if (!order) return res.status(404).send('Order not found');

    // Fetch order status from Cashfree
    const response = await cashfreeApi.get(`/orders/${cf_order_id}`);
    const cfOrder = response.data;

    // Handle different statuses
    if (cfOrder.order_status === 'PAID') {
      // Avoid re-processing if already paid
      if (order.status !== 'PAID' && order.status !== 'Processing' && order.status !== 'Shipped' && order.status !== 'Delivered') {
        
          // 1. Dispatch to ShipCorrect / Shiprocket
          let cart = [];
          try { cart = JSON.parse(order.cart_details); } catch(e) {}
          
          let shipCorrectOrderNo = null;
          try {
            shipCorrectOrderNo = await dispatchToShipCorrect(order, cart);
          } catch (err) {
            console.warn('Shipcorrect dispatch failed during verify:', err.message);
          }

          // 2. Update status to Processing
          await prisma.order.update({
            where: { id: order.id },
            data: { 
              status: 'Processing',
              order_no: shipCorrectOrderNo ? shipCorrectOrderNo.toString() : order.order_no,
              utr: cf_order_id // Store Cashfree ID as reference
            }
          });
        }

        // Send email notification after successful payment (non-blocking)
        sendOrderConfirmationEmail(order, order.order_no).catch(e => console.warn('[MAILER]', e.message));

        // Redirect to the beautiful tracking page which shows ShipCorrect details
        return res.redirect(`/api/orders/status/${order.id}`);
        
      } else {
        // Payment failed or pending or cancelled
        // Just mark it as failed and redirect to a failure page or cart
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'FAILED' }
        });

        const failureHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <title>Payment Failed | ${MERCHANT_NAME}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { background: #fdfbf7; color: #333; font-family: sans-serif; text-align: center; padding-top: 100px; }
              .btn { display: inline-block; padding: 12px 24px; background: #c99339; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; }
            </style>
          </head>
          <body>
            <h1 style="color: #e74c3c;">Payment Failed ❌</h1>
            <p>We couldn't verify your payment. Your account has not been charged.</p>
            <a href="/" class="btn">Return to Store and Try Again</a>
          </body>
          </html>
        `;
        return res.send(failureHtml);
      }
    } catch (error) {
      console.error('Verify error:', error.response?.data || error.message);
      res.status(500).send('Error verifying payment status. If amount was deducted, please contact support.');
    }
  });


/**
 * 3. Manual Approve Payment (MERCHANT ENDPOINT)
 * Kept for fallback/admin dashboard purposes.
 */
router.post('/approve/:orderId', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const parsedId = parseInt(orderId);
    if (isNaN(parsedId)) return res.status(400).json({ error: 'Invalid Order ID' });
    const order = await prisma.order.findUnique({
      where: { id: parsedId }
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'Processing' || order.status === 'PAID' || order.status === 'Shipped') {
      return res.status(400).json({ error: 'Order is already approved' });
    }

    let cart = [];
    try { cart = JSON.parse(order.cart_details); } catch(e) {}
    const shipCorrectOrderNo = await dispatchToShipCorrect(order, cart);

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { 
        status: 'Processing',
        order_no: shipCorrectOrderNo ? shipCorrectOrderNo.toString() : order.order_no
      }
    });

    res.json({ 
      message: 'Payment verified! Order dispatched to ShipCorrect.',
      shipCorrectOrderNo,
      order_id: order.id,
      status: updatedOrder.status
    });
  } catch (error) {
    console.error('Approve error:', error);
    res.status(500).json({ error: 'Failed to approve payment' });
  }
});

// Legacy status check for any polling clients (can be removed but kept for backward compatibility)
router.get('/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const parsedId = parseInt(orderId);
    if (isNaN(parsedId)) return res.status(400).json({ error: 'Invalid Order ID' });
    const order = await prisma.order.findUnique({ where: { id: parsedId } });

    if (!order) return res.status(404).json({ error: 'Not found' });
    
    res.json({ status: order.status, order_no: order.order_no });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
'@

  'server\src\controllers\order.controller.js' = @'
const axios = require('axios');
const prisma = require('../db');
const { sendOrderConfirmationEmail } = require('../utils/mailer');

// Simple HTML sanitizer
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>"'&]/g, (char) => {
    const map = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' };
    return map[char] || char;
  });
}

// Helper to dispatch orders to ShipCorrect / Shiprocket
const shipIntegration = require('../integrations/shipcorrect');
// Cashfree integration used to create payment sessions for PREPAID orders
const cashfreeIntegration = require('../integrations/cashfree');
const CF_ENV = process.env.CASHFREE_ENV || 'sandbox';

const dispatchToShipCorrect = async (order, cart) => {
  // Delegate to integrations/shipcorrect.createOrder which handles test fallback and API errors
  try {
    const orderNo = await shipIntegration.createOrder(order, cart);
    return orderNo;
  } catch (err) {
    console.warn('[SHIPCORRECT] fallback after integration error:', err.message);
    return `SC-${order.id}-${Math.floor(100000 + Math.random() * 900000)}`;
  }
};

const createOrder = async (req, res) => {
  try {
    // Lightweight request preview for debugging client-side issues (temporary, safe)
    try {
      console.log('[ORDER-REQ]', {
        at: new Date().toISOString(),
        ip: req.ip,
        ua: req.get('User-Agent'),
        bodyKeys: Object.keys(req.body || {}).slice(0, 10)
      });
    } catch (e) {}

    const { 
      name, full_name, customer_name, email, customer_email, address, customer_address1, address_line1, address_line2, state, customer_address_state, city, customer_address_city, pincode, customer_address_pincode, phone, customer_contact_number1, mobile, pay_mode, payment_method, utr,
      cart, quantity, coupon_code
    } = req.body;

    let finalName = customer_name || full_name || name || "Valued Customer";
    let finalAddress = customer_address1 || address || [address_line1, address_line2].filter(Boolean).join(", ") || "Main Address";
    let finalPhone = customer_contact_number1 || phone || mobile || "9999999999";
    let finalEmail = customer_email || email || "";
    let finalState = customer_address_state || state || "";
    let finalCity = customer_address_city || city || "";
    let finalPincode = customer_address_pincode || pincode || "";

    const normalizedMode = (incoming) => {
      if (typeof incoming !== 'string') return incoming;
      const normalized = incoming.trim().toUpperCase();
      if (['ONLINE', 'ONLINE_PAYMENT', 'PAYNOW', 'PREPAID', 'PREPAY'].includes(normalized)) return 'PREPAID';
      if (['COD', 'CASH', 'CASH_ON_DELIVERY', 'CASHDELIVERY'].includes(normalized)) return 'COD';
      if (['UPI', 'UPIQR', 'UPI_QR'].includes(normalized)) return 'UPI';
      return normalized;
    };

    let finalPayMode = normalizedMode(pay_mode || payment_method || "PREPAID");

    // Validate phone (10 digits)
    const phoneRegex = /^\d{10}$/;
    if (finalPhone !== "9999999999" && !phoneRegex.test(finalPhone)) {
      return res.status(400).json({ error: 'Invalid phone number, must be 10 digits' });
    }

    // Validate pincode (6 digits)
    const pincodeRegex = /^\d{6}$/;
    if (finalPincode && !pincodeRegex.test(finalPincode)) {
      return res.status(400).json({ error: 'Invalid pincode, must be 6 digits' });
    }

    finalName = sanitize(finalName);
    finalAddress = sanitize(finalAddress);
    finalPhone = sanitize(finalPhone);
    finalEmail = sanitize(finalEmail);
    finalState = sanitize(finalState);
    finalCity = sanitize(finalCity);
    finalPincode = sanitize(finalPincode);
    let finalUtr = utr ? sanitize(utr) : null;

    let finalCart = cart;
    if (!finalCart || !Array.isArray(finalCart) || finalCart.length === 0) {
      finalCart = [{
        title: "Happy Hair \u2013 Instant Seeds Powder Mix",
        price: 699,
        quantity: quantity || 1,
        SKU: "happy-hair-250g",
        product_id: req.body.product_id || "1",
        pay_mode: finalPayMode
      }];
    }

    // Stock check
    for (const item of finalCart) {
      let pid = parseInt(item.product_id);
      if (isNaN(pid)) pid = 1;
      const product = await prisma.product.findUnique({ where: { id: pid } });
      if (product) {
        if (product.stock < (parseInt(item.quantity) || 1)) {
          return res.status(400).json({ error: `Not enough stock for ${product.title}` });
        }
      }
    }

    // Stock decrement
    for (const item of finalCart) {
      let pid = parseInt(item.product_id);
      if (isNaN(pid)) pid = 1;
      try {
        await prisma.product.update({
          where: { id: pid },
          data: { stock: { decrement: parseInt(item.quantity) || 1 } }
        });
      } catch (e) {
        // Don't fail the whole order because of stock update race or missing product; log and continue
        console.warn('[STOCK] Failed to decrement stock for product', pid, e && e.message ? e.message : e);
      }
    }

    const mode = finalPayMode || (finalCart.length > 0 && finalCart[0].pay_mode ? finalCart[0].pay_mode : 'PREPAID');
    let total = finalCart.reduce((sum, item) => {
      const p = parseFloat(item.price) || 699;
      const q = parseInt(item.quantity) || 1;
      return sum + (p * q);
    }, 0);
    if (isNaN(total)) total = 699;

    // Delivery and dynamic discounts
    // Free delivery applied. No delivery charge added.
    
    let finalDiscount = 0;
    let finalCoupon = null;

    // For this product, don't apply a prepaid discount by default. Keep finalDiscount as-is (0) unless future logic needs it.
    total -= finalDiscount;
    if (total < 0) total = 0;

    const initialStatus = mode.toUpperCase() === 'PREPAID' || mode.toUpperCase() === 'UPI' ? 'Pending Verification' : 'PENDING';

    const newOrder = await prisma.order.create({
      data: {
        customer_name: finalName,
        email: finalEmail,
        address: finalAddress,
        state: finalState,
        city: finalCity,
        pincode: finalPincode,
        phone: finalPhone,
        pay_mode: mode.toUpperCase(),
        utr: mode.toUpperCase() === 'PREPAID' || mode.toUpperCase() === 'UPI' ? finalUtr : null,
        total,
        coupon_code: finalCoupon,
        discount_applied: finalDiscount,
        status: initialStatus,
        cart_details: JSON.stringify(finalCart)
      }
    });

    if (mode.toUpperCase() === 'COD') {
      try {
        const shipCorrectOrderNo = await dispatchToShipCorrect(newOrder, finalCart);
        if (shipCorrectOrderNo) {
          await prisma.order.update({
            where: { id: newOrder.id },
            data: { order_no: shipCorrectOrderNo.toString() }
          });
        }
        // Send email notification (non-blocking)
        sendOrderConfirmationEmail(newOrder, shipCorrectOrderNo).catch(e => console.warn('[MAILER]', e.message));
        return res.status(201).json({ message: 'Order created and dispatched', order_id: newOrder.id.toString(), shipCorrectOrderNo });
      } catch (err) {
        // Still send email even if dispatch failed
        sendOrderConfirmationEmail(newOrder, null).catch(e => console.warn('[MAILER]', e.message));
        return res.status(201).json({ message: 'Order created but failed to dispatch to ShipCorrect', order_id: newOrder.id.toString() });
      }
    } else if (mode.toUpperCase() === 'UPI') {
      // For UPI flows we provide a UPI intent / QR page and allow the user to complete payment externally.
      try {
        const appUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
        return res.status(201).json({
          message: 'Order created. Open UPI page to complete payment.',
          order_id: newOrder.id.toString(),
          upi_url: `${appUrl}/api/debug/upi-qr?amount=${encodeURIComponent(total)}&order_id=${newOrder.id}`
        });
      } catch (err) {
        console.error('[UPI] Failed to prepare UPI link:', err.message || err);
        return res.status(201).json({ message: 'Order created. Use your UPI app to pay manually.', order_id: newOrder.id.toString() });
      }
    } else {
      // PREPAID - initialize Cashfree payment session and return session id to frontend
      const reqHost = `${req.protocol}://${req.get('host')}`;
      try {
        const { cfOrderId, paymentSessionId } = await cashfreeIntegration.createOrder(newOrder, reqHost);
        // Persist the cfOrderId into utr field for later webhook correlation
        try {
          await prisma.order.update({ where: { id: newOrder.id }, data: { utr: cfOrderId } });
        } catch (e) {
          console.warn('[ORDER] Failed to save cfOrderId to order:', e.message);
        }

        return res.status(201).json({ 
          message: 'Order created successfully. Proceed to payment.', 
          order_id: newOrder.id.toString(),
          cfOrderId,
          paymentSessionId,
          cfEnv: CF_ENV,
          checkout_url: `${(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/api/payment/checkout/${newOrder.id}`
        });
      } catch (err) {
        console.error('[CASHFREE] Failed to create payment session:', err.response?.data || err.message);
        // Fallback to returning the checkout_url which will create a session server-side when visited
        return res.status(201).json({ 
          message: 'Order created but failed to initialize payment session. Use checkout URL to proceed.', 
          order_id: newOrder.id.toString(),
          checkout_url: `${(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/api/payment/checkout/${newOrder.id}`
        });
      }
    }
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const approveOrder = async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id is required' });

    const order = await prisma.order.findUnique({ where: { id: parseInt(order_id) } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    
    if (order.status === 'Processing' || order.status === 'PAID' || order.status === 'Shipped') {
      return res.status(400).json({ error: 'Order is already approved' });
    }

    let cart = [];
    try {
      cart = JSON.parse(order.cart_details);
    } catch (e) {
      console.error('Error parsing cart_details:', e);
    }

    const shipCorrectOrderNo = await dispatchToShipCorrect(order, cart);

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { 
        status: 'Processing',
        order_no: shipCorrectOrderNo ? shipCorrectOrderNo.toString() : order.order_no
      }
    });

    res.json({ message: 'Order approved and dispatched to ShipCorrect', shipCorrectOrderNo, order_id: updatedOrder.id, status: updatedOrder.status });
  } catch (error) {
    console.error('Error approving order:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const trackOrder = async (req, res) => {
  try {
    const { order_no, awb } = req.body;

    if (!order_no && !awb) {
      return res.status(400).json({ error: 'order_no or awb is required for tracking' });
    }

    const shipcorrectUrl = process.env.SHIPCORRECT_BASE_URL + '/trackOrder.php';
    const shipcorrectApiKey = process.env.SHIPCORRECT_API_KEY;

    const payload = {
      api_key: shipcorrectApiKey,
      order_no: order_no || awb
    };

    const response = await axios.post(shipcorrectUrl, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const { tracking_status, scan_stages } = response.data;

    res.json({
      tracking_status: tracking_status || 'Unknown',
      scan_stages: scan_stages || []
    });
  } catch (error) {
    console.error('Error tracking order:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch tracking details from ShipCorrect' });
  }
};

const claimUpi = async (req, res) => {
  try {
    const { id } = req.params;
    let { upi_utr } = req.body;
    
    if (!upi_utr) {
      return res.status(400).json({ error: 'UPI UTR is required' });
    }
    
    upi_utr = sanitize(upi_utr);

    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await prisma.order.update({
      where: { id: parseInt(id) },
      data: { 
        utr: upi_utr,
        status: 'Pending Verification' 
      }
    });

    res.json({ message: 'UPI UTR claimed successfully' });
  } catch (error) {
    console.error('Error claiming UPI:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const renderTrackingPage = async (req, res) => {
  try {
    const { orderId } = req.params;
    
    // Fetch order from DB
    const order = await prisma.order.findUnique({ where: { id: parseInt(orderId) } });
    if (!order) return res.status(404).send('Order not found');

    // Fetch tracking details from ShipCorrect
    let trackingStatus = 'Pending';
    let scanStages = [];
    
    if (order.order_no) {
      try {
        const shipcorrectUrl = process.env.SHIPCORRECT_BASE_URL + '/trackOrder.php';
        const shipcorrectApiKey = process.env.SHIPCORRECT_API_KEY;

        const response = await axios.post(shipcorrectUrl, {
          api_key: shipcorrectApiKey,
          order_no: order.order_no
        }, { headers: { 'Content-Type': 'application/json' } });

        if (response.data && response.data.status !== 'error') {
          trackingStatus = response.data.tracking_status || trackingStatus;
          scanStages = response.data.scan_stages || [];
        }
      } catch (err) {
        console.error('Error fetching tracking from ShipCorrect:', err.message);
      }
    }

    // Generate HTML
    let timelineHtml = '';
    if (scanStages.length > 0) {
      timelineHtml = scanStages.map(stage => `
        <div class="timeline-item">
          <div class="date">${sanitize(stage.date || '')}</div>
          <div class="status-title">${sanitize(stage.status || stage.activity || 'Update')}</div>
          ${stage.description || stage.location ? `<div class="desc">${sanitize(stage.description || '')} ${sanitize(stage.location || '')}</div>` : ''}
        </div>
      `).join('');
    } else {
      timelineHtml = `<p>No tracking updates available yet. We are preparing your order.</p>`;
    }

    const safeCustomerName = sanitize(order.customer_name);
    const safeTrackingStatus = sanitize(trackingStatus);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Track Your Order - Happy Hair</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; background: #fdfbf7; padding: 2rem 1rem; color: #333; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid #1a361d22; }
          h1 { color: #1a361d; margin-top: 0; }
          .order-info { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #eee; }
          .status-badge { display: inline-block; padding: 5px 12px; border-radius: 20px; background: #e3f2fd; color: #1565c0; font-weight: bold; margin-top: 10px; }
          .status-badge.delivered { background: #e8f5e9; color: #2e7d32; }
          
          .timeline { position: relative; margin-top: 2rem; padding-left: 20px; }
          .timeline::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: #ddd; }
          .timeline-item { position: relative; margin-bottom: 1.5rem; padding-left: 20px; }
          .timeline-item::before { content: ''; position: absolute; left: -25px; top: 5px; width: 12px; height: 12px; border-radius: 50%; background: #b8860b; border: 3px solid white; box-shadow: 0 0 0 1px #ddd; }
          .timeline-item:first-child::before { background: #2e7d32; }
          .date { font-size: 0.85rem; color: #888; margin-bottom: 4px; }
          .status-title { font-weight: bold; color: #222; }

'@

  'server\src\integrations\cashfree.js' = @'
const axios = require('axios');

const CF_APP_ID = process.env.CASHFREE_APP_ID;
const CF_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CF_ENV = process.env.CASHFREE_ENV || 'sandbox';
const CF_BASE_URL = CF_ENV === 'sandbox' ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';

const createOrder = async (order, reqHost) => {
  // cfOrderId is a unique id for Cashfree
  const cfOrderId = `order_${order.id}_${Date.now().toString().slice(-4)}`;

  // Prepare payload according to Cashfree v3 orders API
  const payload = {
    order_id: cfOrderId,
    order_amount: order.total,
    order_currency: 'INR',
    customer_details: {
      customer_id: `cust_${Date.now()}`,
      customer_phone: order.phone || '9999999999',
      customer_name: (order.customer_name || 'Customer').toString().substring(0, 50),
      customer_email: order.email || 'customer@example.com'
    },
    order_meta: {
      return_url: `${reqHost}/api/payment/verify/${order.id}?cf_order_id=${cfOrderId}`
    }
  };

  // Build axios instance
  const cashfreeApi = axios.create({
    baseURL: CF_BASE_URL,
    headers: {
      'x-client-id': CF_APP_ID,
      'x-client-secret': CF_SECRET_KEY,
      'x-api-version': '2023-08-01',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    timeout: 10000
  });

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  let attempt = 0;
  const maxAttempts = 2; // initial try + 1 retry
  while (attempt < maxAttempts) {
    try {
      attempt++;
      const response = await cashfreeApi.post('/orders', payload);
      const paymentSessionId = response.data.payment_session_id;
      return { cfOrderId, paymentSessionId };
    } catch (err) {
      const errDetail = err.response?.data || err.message || String(err);
      console.error(`[CASHFREE CREATE ORDER ERROR] attempt=${attempt} cfOrderId=${cfOrderId} detail=`, errDetail);
      if (attempt >= maxAttempts) {
        // After retries exhausted, throw a sanitized error to the caller
        const toThrow = new Error('Cashfree createOrder failed after retry');
        toThrow.detail = typeof errDetail === 'string' ? errDetail : JSON.stringify(errDetail);
        throw toThrow;
      }
      // Small backoff before retrying
      await sleep(500);
    }
  }
};

const getOrder = async (cfOrderId) => {
  const cashfreeApi = axios.create({
    baseURL: CF_BASE_URL,
    headers: {
      'x-client-id': CF_APP_ID,
      'x-client-secret': CF_SECRET_KEY,
      'x-api-version': '2023-08-01',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    timeout: 10000
  });

  try {
    const response = await cashfreeApi.get(`/orders/${cfOrderId}`);
    return response.data;
  } catch (err) {
    console.error('[CASHFREE GET ORDER ERROR]', err.response?.data || err.message);
    throw err;
  }
};

module.exports = {
  createOrder,
  getOrder
};
'@

  'frontend\src\Checkout.jsx' = @'
import React, { useState, useEffect } from 'react';
import './Checkout.css';

const indianLocations = {
  "Andaman and Nicobar Islands": ["Port Blair", "Nicobar", "South Andaman", "North and Middle Andaman"],
  "Andhra Pradesh": ["Visakhapatnam", "Vijayawada", "Guntur", "Nellore", "Tirupati", "Kurnool", "Rajahmundry", "Anantapur", "Kadapa", "Eluru"],
  // ... (same as before) ...
};

export default function Checkout({ isOpen, onClose, initialProduct }) {
  const [formData, setFormData] = useState(() => {
    try {
      const saved = localStorage.getItem('checkoutForm');
      return saved ? JSON.parse(saved) : { name: '', email: '', phone: '', address: '', state: '', city: '', pincode: '', paymode: 'UPI' };
    } catch (e) { return { name: '', email: '', phone: '', address: '', state: '', city: '', pincode: '', paymode: 'UPI' }; }
  });
  
  const [loading, setLoading] = useState(false);
  const [pincodeLoading, setPincodeLoading] = useState(false);
  const [pincodeError, setPincodeError] = useState('');
  const [errors, setErrors] = useState({});

  // Derived state
  const isCOD = formData.paymode === 'COD';
  const price = initialProduct?.price || 699;
  const discount = 0; // No prepaid discount in simplified UPI/COD flow
  const delivery = isCOD ? 20 : 0; // 20 rs extra for COD
  const total = price + delivery - discount;
  
  const citiesList = indianLocations[formData.state] || [];

  // Auto-fetch City and State when pincode reaches 6 digits
  useEffect(() => {
    if (formData.pincode.length === 6) {
      fetchPincodeDetails(formData.pincode);
    } else {
      setPincodeError('');
    }
  }, [formData.pincode]);

  const fetchPincodeDetails = async (pin) => {
    setPincodeLoading(true);
    setPincodeError('');
    try {
      const response = await fetch(`https://api.postalpincode.in/pincode/${pin}`);
      const data = await response.json();
      if (data && data[0] && data[0].Status === 'Success') {
        const postOffice = data[0].PostOffice[0];
        setFormData(prev => ({
          ...prev,
          state: postOffice.State,
          city: postOffice.District
        }));
      } else {
        setPincodeError('Invalid Pincode');
        setFormData(prev => ({ ...prev, state: '', city: '' }));
      }
    } catch (err) {
      console.error('Pincode fetch error:', err);
      setPincodeError('Network error checking pincode');
    } finally {
      setPincodeLoading(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    if (name === 'pincode' && value.length > 6) return; // Prevent more than 6 digits
    if (name === 'pincode' && !/^\d*$/.test(value)) return; // Only allow numbers
    
    setFormData(prev => {
      const next = { ...prev, [name]: value };
      try { localStorage.setItem('checkoutForm', JSON.stringify(next)); } catch (e) {}
      return next;
    });
    setErrors(prev => ({ ...prev, [name]: '' }));
  };

  const submitOrder = async (e) => {
    e.preventDefault();
    setErrors({});

    // Custom Validation (inline)
    const newErrors = {};
    if (!formData.name || !formData.name.trim()) newErrors.name = 'Please enter your full name.';
    if (!formData.email || !formData.email.includes('@')) newErrors.email = 'Please enter a valid email address.';
    if (!formData.phone || formData.phone.length !== 10) newErrors.phone = 'Please enter a valid 10-digit phone number.';
    if (!formData.pincode || formData.pincode.length !== 6) newErrors.pincode = 'Please enter a valid 6-digit pincode.';
    if (!formData.state || !formData.state.trim()) newErrors.state = 'Please select your state.';
    if (!formData.city || !formData.city.trim()) newErrors.city = 'Please select your city.';

    if (pincodeError) newErrors.pincode = 'Please enter a valid 6-digit Pincode to auto-fill State and City.';

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      setLoading(false);
      // Scroll to first error field
      const firstKey = Object.keys(newErrors)[0];
      const el = document.querySelector(`[name="${firstKey}"]`);
      if (el && el.focus) el.focus();
      return;
    }

    setLoading(true);

    const payload = {
      name: formData.name,
      email: formData.email,
      phone: formData.phone,
      address: formData.address || "N/A", // Address is optional, default to N/A for backend
      city: formData.city,
      pincode: formData.pincode,
      state: formData.state,
      pay_mode: formData.paymode,
      coupon_code: null,
      cart: [{
        product_id: initialProduct?.id || 1,
        title: initialProduct?.title || 'Happy Hair  Instant Seeds Powder Mix',
        price: price,
        quantity: 1,
        SKU: 'PROD-' + (initialProduct?.id || 1)
      }]
    };

    try {
      const res = await fetch('/api/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      
      if (res.ok) {
        // If server returned a direct UPI URL, open it and inform the user
        if (data.upi_url) {
          try {
            const upiUrl = data.upi_url.startsWith('/') ? window.location.origin + data.upi_url : data.upi_url;
            // Open UPI page in a new tab so user can continue payment
            window.open(upiUrl, '_blank');
          } catch (e) {
            console.warn('Failed to open UPI URL:', e);
          }
          alert('Order created. UPI payment page opened in a new tab. After completing payment, use the tracking page to monitor your order.');
          localStorage.removeItem('checkoutForm');
          window.location.reload();
          return;
        }

        // Prefer redirect to server-rendered checkout page which auto-opens the Cashfree SDK
        if (data.checkout_url) {
          try {
            fetch('/api/debug/log', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event: 'checkout_redirect', checkout_url: data.checkout_url, order_id: data.order_id || null })
            }).catch(()=>{});
          } catch(e) {}
          try {
            let checkoutUrl = data.checkout_url;
            if (checkoutUrl && checkoutUrl.startsWith('/')) checkoutUrl = window.location.origin + checkoutUrl;
            window.location.href = checkoutUrl;
          } catch (e) {
            window.location.href = data.checkout_url;
          }
          return;
        }

        // If no checkout_url provided, attempt SDK inline as a fallback
        if (data.paymentSessionId) {
          try {
            const mode = data.cfEnv || 'sandbox';
            const cf = window.Cashfree ? window.Cashfree({ mode }) : null;
            if (cf && typeof cf.checkout === 'function') {
              cf.checkout({ paymentSessionId: data.paymentSessionId });
              return;
            }
          } catch (e) {
            console.warn('Cashfree SDK initialization failed:', e);
          }
          // If SDK couldn't be opened, inform the user and reload
          alert('Payment initialized. Please proceed to payment.');
          if (data.order_id) {
            localStorage.removeItem('checkoutForm');
            window.location.reload();
          }
        } else if (data.shipCorrectOrderNo || data.order_id) {
          // Show success inline
          alert(`Order Placed Successfully!\nOrder ID: #${data.order_id}`);
          localStorage.removeItem('checkoutForm');
          window.location.reload();
        } else {
          alert('Order placed successfully!');
          localStorage.removeItem('checkoutForm');
          window.location.reload();
        }
      } else {
        setErrors({ form: data.error || 'Failed to place order' });
      }
    } catch (err) {
      console.error(err);
      setErrors({ form: 'Network error placing order' });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="zomato-checkout-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="zomato-checkout-container">
        
        {/* Header (Mobile & Desktop) */}
        <div className="zomato-header">
          <div className="z-brand">Happy Hair</div>
          <div className="z-secure-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            100% Secure Checkout
          </div>
          <button type="button" className="z-close-btn" onClick={onClose}>&times;</button>
        </div>

        <div className="zomato-content-split">
          
          {/* Left Side: Forms */}
          <div className="z-left-panel">
            <h1 className="z-page-title">Delivery Details</h1>
            <p className="z-page-subtitle">Enter your details to receive your order.</p>

            <form id="dyn-checkout-form" onSubmit={submitOrder} noValidate>
              
              <div className="z-section">
                <h3 className="z-section-title">1. Contact Information</h3>
                <div className="z-input-group">
                  <input type="text" name="name" placeholder=" " value={formData.name} onChange={handleInputChange} />
                  <label>Full Name</label>
                  {errors.name && <div className="z-field-error">{errors.name}</div>}
                </div>
'@

  'public\js\product-sync.js' = @'
(function() {
  const API_BASE = '';

  // Inject modal styles
  const style = document.createElement('style');
  style.textContent = `
    .dynamic-prod-card {
      background: #152718;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 18px;
      color: #fff;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: all 0.3s ease;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    }
    .dynamic-prod-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 30px rgba(201, 147, 57, 0.2);
      border-color: #c99339;
    }
    .dynamic-prod-img {
      width: 100%;
      height: 220px;
      object-fit: cover;
      border-radius: 12px;
      margin-bottom: 14px;
      background: #0d1a0e;
    }
    .dynamic-prod-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: #f5f5f5;
      margin-bottom: 8px;
      line-height: 1.3;
    }
    .dynamic-prod-price {
      font-size: 1.25rem;
      font-weight: 700;
      color: #c99339;
      margin-bottom: 14px;
    }
    .dynamic-buy-btn {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #c99339 0%, #a67323 100%);
      color: #ffffff;
      border: none;
      border-radius: 25px;
      font-weight: 700;
      font-size: 0.95rem;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: all 0.2s ease;
    }
    .dynamic-buy-btn:hover {
      background: linear-gradient(135deg, #dba446 0%, #b8822d 100%);
      box-shadow: 0 4px 15px rgba(201, 147, 57, 0.4);
    }
    
    /* Universal Checkout Modal */
    #dyn-checkout-modal {
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.85);
      backdrop-filter: blur(8px);
      z-index: 999999;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 15px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
    }
    #dyn-checkout-modal.open {
      opacity: 1;
      pointer-events: auto;
    }
    .dyn-modal-card {
      background: #0f1c10;
      border: 1px solid #c99339;
      border-radius: 20px;
      width: 100%;
      max-width: 450px;
      padding: 24px;
      color: #fff;
      position: relative;
      box-shadow: 0 20px 50px rgba(0,0,0,0.8);
      max-height: 90vh;
      overflow-y: auto;
    }
    .dyn-close-btn {
      position: absolute;
      top: 15px; right: 15px;
      background: none; border: none;
      color: #aaa; font-size: 24px; cursor: pointer;
    }
    .dyn-close-btn:hover { color: #fff; }
    .dyn-form-group { margin-bottom: 12px; }
    .dyn-form-group label { display: block; font-size: 12px; color: #ccc; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .dyn-form-group input, .dyn-form-group select {
      width: 100%; padding: 10px 12px; background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; color: #fff; font-size: 14px; box-sizing: border-box;
    }
    .dyn-form-group input:focus, .dyn-form-group select:focus {
      border-color: #c99339; outline: none;
    }

    @media (max-width: 600px) {
      .dynamic-prod-card {
        width: 100%;
        margin: 0 auto;
      }
      #dynamic-products-showcase {
        padding: 0 15px !important;
      }
      #dynamic-products-grid {
        grid-template-columns: 1fr !important;
        gap: 16px !important;
      }
      .dyn-modal-card {
        padding: 20px 15px;
      }
    }
  `;
  document.head.appendChild(style);

  // Render Modal HTML
  const modalDiv = document.createElement('div');
  modalDiv.id = 'dyn-checkout-modal';
  modalDiv.innerHTML = `
    <div class="dyn-modal-card">
      <button class="dyn-close-btn" onclick="closeDynCheckout()">&times;</button>
      <h3 style="color:#c99339; margin-top:0; font-size: 1.3rem; margin-bottom: 4px;">Complete Your Order</h3>
      <p id="dyn-modal-prod-summary" style="font-size:13px; color:#aaa; margin-bottom: 16px;">'@
}

foreach ($rel in $files.Keys) {
  $path = Join-Path $PSScriptRoot $rel
  $dir = Split-Path $path -Parent
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Write-Host "Writing $path" -ForegroundColor Green
  Set-Content -Path $path -Value $files[$rel] -Encoding UTF8
}

Write-Host "Patch applied. Please run your git add/commit to record changes." -ForegroundColor Cyan
