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
            background-color: #0a0a0a; color: #fff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;
            text-align: center;
          }
          .container {
            background: #111; border: 1px solid #333; padding: 40px; border-radius: 16px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5); max-width: 400px; width: 90%;
          }
          .loader {
            border: 4px solid rgba(201, 147, 57, 0.2); border-top: 4px solid #c99339;
            border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite;
            margin: 0 auto 24px;
          }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          h2 { color: #f5f5f5; margin-top: 0; font-size: 1.5rem; }
          p { color: #aaa; line-height: 1.5; font-size: 0.95rem; }
          .logo { height: 30px; opacity: 0.8; margin-top: 30px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="loader"></div>
          <h2>Secure Payment Gateway</h2>
          <p>Please wait while we securely connect you to Cashfree. Do not refresh or close this page.</p>
          <img src="https://cashfreelogo.cashfree.com/cashfree-monochrome-white.svg" alt="Cashfree Payments" class="logo">
        </div>
        <script>
          const cashfree = Cashfree({
              mode: "${CF_ENV}" // "sandbox" or "production"
          });
          
          window.onload = function() {
            setTimeout(() => {
              try {
                cashfree.checkout({
                    paymentSessionId: "${paymentSessionId}",
                    redirectTarget: "_self"
                });
              } catch(e) { console.error(e); }
            }, 800);
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
    const cfOrderId = payload?.data?.order?.order_id || payload?.order_id || payload?.orderId || payload?.cf_order_id || payload?.reference_id;
    const cfStatus = payload?.data?.order?.order_status || payload?.order_status || payload?.txStatus || payload?.status || payload?.payment_status;
    const cfAmount = payload?.data?.order?.order_amount || payload?.order_amount || 0;

    let order = null;

    // We generate cfOrderId as "order_{ID}_{RANDOM}"
    // Securely extract the ID from it:
    if (cfOrderId && cfOrderId.startsWith('order_')) {
      const parts = cfOrderId.split('_');
      if (parts.length >= 2) {
        const extractedId = parseInt(parts[1]);
        if (!isNaN(extractedId)) {
          order = await prisma.order.findUnique({ where: { id: extractedId } });
        }
      }
    }

    // If order found and status indicates success, mark as paid/processing and dispatch
    const paidStatuses = ['PAID', 'SUCCESS', 'COMPLETED', 'TXN_SUCCESS'];
    if (order && cfStatus && paidStatuses.includes(cfStatus.toString().toUpperCase())) {
      
      // STRICT SECURITY VERIFICATION: Ensure amounts match!
      if (parseFloat(cfAmount) > 0 && parseFloat(cfAmount) < parseFloat(order.total)) {
        console.error(`[WEBHOOK SECURITY] Partial payment spoof attempt! Paid ${cfAmount} but expected ${order.total} for order ${order.id}`);
        return res.status(400).send('Security verification failed. Amount mismatch.');
      }

      // Avoid duplicate dispatch
      if (order.status !== 'PAID' && order.status !== 'Processing' && order.status !== 'Shipped' && order.status !== 'Delivered') {
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
      }

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
    const cfOrder = await cashfreeIntegration.getOrder(cf_order_id);

    // Handle different statuses
    if (cfOrder.order_status === 'PAID' || cfOrder.order_status === 'SUCCESS') {
      
      // STRICT SECURITY VERIFICATION:
      // 1. Ensure the Cashfree order truly belongs to THIS local order (prevent cross-order spoofing)
      if (!cfOrder.order_id.startsWith(`order_${order.id}_`)) {
        console.error(`[SECURITY] Spoof attempt! Tried to apply CF Order ${cfOrder.order_id} to local Order ${order.id}`);
        return res.status(400).send('Security verification failed. Order ID mismatch.');
      }
      
      // 2. Ensure the paid amount matches the requested total
      if (parseFloat(cfOrder.order_amount) < parseFloat(order.total)) {
        console.error(`[SECURITY] Partial payment spoof! Paid ${cfOrder.order_amount} but expected ${order.total}`);
        return res.status(400).send('Security verification failed. Amount mismatch.');
      }

      // Avoid re-processing if already paid
      if (order.status !== 'PAID' && order.status !== 'Processing' && order.status !== 'Shipped' && order.status !== 'Delivered') {
        
        // 1. Dispatch to ShipCorrect / Shiprocket
        let cart = [];
        try { cart = JSON.parse(order.cart_details); } catch(e) {}
        
        let shipCorrectOrderNo = null;
        try {
          shipCorrectOrderNo = await shipcorrectIntegration.createOrder(order, cart);
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
    const order = await prisma.order.findUnique({
      where: { id: parsedId }
    });

    if (!order) return res.status(404).json({ error: 'Not found' });
    
    res.json({ status: order.status, order_no: order.order_no });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
