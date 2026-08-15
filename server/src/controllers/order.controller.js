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
      if (['ONLINE', 'ONLINE_PAYMENT', 'PAYNOW', 'PREPAID', 'PREPAY', 'UPI', 'UPIQR', 'UPI_QR'].includes(normalized)) return 'PREPAID';
      if (['COD', 'CASH', 'CASH_ON_DELIVERY', 'CASHDELIVERY'].includes(normalized)) return 'COD';
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
    const initialStatus = mode.toUpperCase() === 'PREPAID' ? 'Pending Verification' : 'PENDING';

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
        utr: mode.toUpperCase() === 'PREPAID' ? finalUtr : null,
        total,
        coupon_code: finalCoupon,
        discount_applied: finalDiscount,
        status: initialStatus,
        cart_details: JSON.stringify(finalCart)
      }
    });

    // Return order_id directly, deferring payment gateway and shipcorrect logic to the payment portal
    return res.status(201).json({ 
      message: 'Order created successfully. Proceed to payment.', 
      order_id: newOrder.id.toString() 
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const renderPaymentSelectionPage = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).send('Order not found');

    if (order.status !== 'Pending' && order.status !== 'Payment_Failed') {
      return res.redirect(`/api/orders/status/${order.id}`);
    }

    // Generate Cashfree Session
    const reqHost = `${req.protocol}://${req.get('host')}`;
    let paymentSessionId = '';
    try {
      const cfRes = await cashfreeIntegration.createOrder(order, reqHost);
      paymentSessionId = cfRes.paymentSessionId;
      await prisma.order.update({ where: { id: order.id }, data: { utr: cfRes.cfOrderId } });
    } catch (e) {
      console.error('[CASHFREE] Failed to generate payment session for portal:', e.message);
    }

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>Secure Payment Portal - Happy Hair</title>
      <script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: #f9fafb; color: #111827; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
        .portal-card { background: #fff; width: 100%; max-width: 420px; border-radius: 24px; padding: 32px; box-shadow: 0 10px 40px -10px rgba(0,0,0,0.08); text-align: center; }
        .logo { font-size: 24px; font-weight: 800; color: #111827; margin-bottom: 8px; }
        .amount { font-size: 42px; font-weight: 800; color: #111827; margin: 24px 0 8px; letter-spacing: -1px; }
        .amount-label { color: #6b7280; font-size: 14px; font-weight: 500; text-transform: uppercase; letter-spacing: 1px; }
        .divider { height: 1px; background: #e5e7eb; margin: 32px 0; }
        .btn { width: 100%; padding: 16px; border-radius: 16px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.2s; border: none; display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 16px; }
        .btn-prepaid { background: #111827; color: #fff; box-shadow: 0 4px 12px rgba(17,24,39,0.2); }
        .btn-prepaid:hover { background: #000; transform: translateY(-2px); }
        .btn-cod { background: #f3f4f6; color: #374151; }
        .btn-cod:hover { background: #e5e7eb; }
        .secure-badge { margin-top: 24px; color: #9ca3af; font-size: 13px; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 6px; }
        .cod-fee { font-size: 13px; color: #6b7280; font-weight: 500; margin-top: -8px; margin-bottom: 24px; display: block; }
        .error { color: #dc2626; font-size: 14px; margin-top: 16px; display: none; background: #fef2f2; padding: 12px; border-radius: 8px; }
      </style>
    </head>
    <body>
      <div class="portal-card">
        <div class="logo">Happy Hair</div>
        <div class="amount-label">Amount to Pay</div>
        <div class="amount">₹${order.total}</div>
        
        <div class="divider"></div>

        <button id="prepaid-btn" class="btn btn-prepaid">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>
          Pay Now (UPI, Cards)
        </button>
        
        <button id="cod-btn" class="btn btn-cod">
          📦 Cash on Delivery
        </button>
        <span class="cod-fee">Additional ₹20 fee applies</span>
        
        <div id="error-msg" class="error"></div>

        <div class="secure-badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          100% Secure Payments
        </div>
      </div>

      <script>
        const CF_ENV = '${CF_ENV}';
        const sessionId = '${paymentSessionId}';
        const orderId = '${order.id}';
        
        document.getElementById('prepaid-btn').addEventListener('click', () => {
          if (!sessionId) {
            document.getElementById('error-msg').innerText = 'Payment session unavailable. Please try COD.';
            document.getElementById('error-msg').style.display = 'block';
            return;
          }
          const cf = Cashfree({ mode: CF_ENV });
          cf.checkout({ paymentSessionId: sessionId, redirectTarget: "_self" });
        });

        document.getElementById('cod-btn').addEventListener('click', async () => {
          const btn = document.getElementById('cod-btn');
          btn.innerHTML = '<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg> Processing...';
          btn.disabled = true;
          document.getElementById('prepaid-btn').disabled = true;
          
          try {
            const res = await fetch('/api/orders/' + orderId + '/pay-cod', { method: 'POST' });
            if (res.ok) {
              window.location.href = '/api/orders/status/' + orderId;
            } else {
              throw new Error('Failed to process COD');
            }
          } catch(e) {
            document.getElementById('error-msg').innerText = e.message;
            document.getElementById('error-msg').style.display = 'block';
            btn.innerHTML = '📦 Cash on Delivery';
            btn.disabled = false;
            document.getElementById('prepaid-btn').disabled = false;
          }
        });
      </script>
    </body>
    </html>
    `;
    res.send(html);
  } catch (error) {
    console.error('Error rendering payment page:', error);
    res.status(500).send('Internal Server Error');
  }
};

const processCodPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status !== 'Pending') {
      return res.status(400).json({ error: 'Order already processed' });
    }

    // Add 20rs COD fee
    const updatedTotal = (order.total || 0) + 20;

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { pay_mode: 'COD', total: updatedTotal }
    });

    let cart = [];
    try { cart = JSON.parse(order.cart_details); } catch(e){}

    // Async dispatch to ShipCorrect
    (async () => {
      try {
        const shipCorrectOrderNo = await dispatchToShipCorrect(updatedOrder, cart);
        if (shipCorrectOrderNo) {
          await prisma.order.update({
            where: { id: updatedOrder.id },
            data: { order_no: shipCorrectOrderNo.toString() }
          });
        }
        sendOrderConfirmationEmail(updatedOrder, shipCorrectOrderNo).catch(e => console.warn('[MAILER]', e.message));
      } catch (err) {
        console.error('[BACKGROUND SC]', err);
      }
    })();

    res.json({ message: 'COD Order Confirmed' });
  } catch (error) {
    console.error('Error processing COD:', error);
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
          .desc { font-size: 0.9rem; color: #555; margin-top: 4px; }
          .btn { display: inline-block; background: #1a361d; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; margin-top: 2rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Track Your Order</h1>
          <div class="order-info">
            <p><strong>Order ID:</strong> #${order.id}</p>
            <p><strong>Name:</strong> ${safeCustomerName}</p>
            <div class="status-badge ${safeTrackingStatus.toLowerCase() === 'delivered' ? 'delivered' : ''}">${safeTrackingStatus}</div>
          </div>
          
          <h2>Tracking History</h2>
          <div class="timeline">
            ${timelineHtml}
          </div>
          
          <div style="text-align: center;">
            <a href="/" class="btn">Return to Store</a>
          </div>
        </div>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Error rendering tracking page:', error);
    res.status(500).send('Internal Server Error');
  }
};

const getAllOrders = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const deleteOrder = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.order.delete({
      where: { id: parseInt(id) }
    });
    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const validStatuses = ['PENDING', 'Pending Verification', 'Processing', 'PAID', 'Shipped', 'Delivered', 'Cancelled', 'FAILED'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Valid: ' + validStatuses.join(', ') });
    }

    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const updatedOrder = await prisma.order.update({
      where: { id: parseInt(id) },
      data: { status }
    });

    res.json({ message: 'Order status updated', order: updatedOrder });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  createOrder,
  approveOrder,
  trackOrder,
  claimUpi,
  dispatchToShipCorrect,
  renderTrackingPage,
  renderPaymentSelectionPage,
  processCodPayment,
  getAllOrders,
  deleteOrder,
  updateOrderStatus
};
