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

    if (order.status.toUpperCase() !== 'PENDING' && order.status.toUpperCase() !== 'PAYMENT_FAILED') {
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
      <title>Select Payment Method - Happy Hair</title>
      <script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: #fbf9f6; color: #3d2f25; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
        .portal-card { background: #fff; width: 100%; max-width: 600px; border-radius: 12px; padding: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.04); border: 1px solid #f0ebe1; }
        
        .header-title { font-size: 16px; font-weight: 700; color: #4a3b32; margin-bottom: 20px; }
        
        .payment-options { display: flex; gap: 16px; margin-bottom: 32px; }
        @media (max-width: 500px) { .payment-options { flex-direction: column; } }
        
        .radio-card { flex: 1; border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; cursor: pointer; transition: all 0.2s; position: relative; background: #fafaf9; display: flex; flex-direction: column; }
        .radio-card.active { border-color: #d4af37; background: #fffdf7; }
        
        .radio-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .custom-radio { width: 22px; height: 22px; border-radius: 50%; border: 2px solid #cbd5e1; display: flex; align-items: center; justify-content: center; }
        .radio-card.active .custom-radio { border-color: #d4af37; background: #d4af37; }
        .custom-radio::after { content: ''; width: 10px; height: 10px; border-radius: 50%; background: #fff; transform: scale(0); transition: transform 0.2s; }
        .radio-card.active .custom-radio::after { transform: scale(1); }
        
        .icon { font-size: 20px; }
        .title { font-size: 16px; font-weight: 600; color: #4a3b32; }
        
        .desc { font-size: 13px; color: #6b7280; margin-bottom: 12px; line-height: 1.4; }
        
        .badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; width: fit-content; }
        .badge-green { background: #dcfce7; color: #166534; }
        .badge-orange { background: #ffedd5; color: #9a3412; }
        
        .continue-btn { width: 100%; padding: 18px; border-radius: 12px; background: #523b31; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; border: none; transition: background 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
        .continue-btn:hover { background: #3f2d25; }
        .continue-btn:disabled { opacity: 0.7; cursor: not-allowed; }
        
        .error { color: #dc2626; font-size: 14px; margin-top: 16px; display: none; background: #fef2f2; padding: 12px; border-radius: 8px; text-align: center; }
        
        /* Order Summary visual */
        .summary-box { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #e5e7eb; }
        .summary-title { font-size: 22px; font-weight: 600; color: #4a3b32; margin-bottom: 20px; }
        .summary-row { display: flex; justify-content: space-between; font-size: 15px; color: #4b5563; margin-bottom: 12px; }
        .summary-row.total { font-size: 20px; font-weight: 700; color: #4a3b32; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
        .gold-text { color: #d4af37; font-size: 28px; }
      </style>
    </head>
    <body>
      <div class="portal-card">
        
        <div class="summary-box">
          <h2 class="summary-title">Order Summary</h2>
          <div class="summary-row">
            <span>Subtotal</span>
            <span>₹${order.total}</span>
          </div>
          <div class="summary-row">
            <span>Shipping</span>
            <span>FREE</span>
          </div>
          <div class="summary-row total">
            <span>Total</span>
            <span class="gold-text">₹<span id="display-total">${order.total}</span></span>
          </div>
        </div>

        <div class="header-title">Select Payment Method *</div>
        
        <div class="payment-options">
          <div class="radio-card active" id="card-prepaid" onclick="selectPayment('PREPAID')">
            <div class="radio-header">
              <div class="custom-radio"></div>
              <span class="icon">💳</span>
              <span class="title">Online Payment</span>
            </div>
            <div class="desc">Pay now via UPI, Cards, Net Banking</div>
            <div class="badge badge-green">✓ Instant Confirmation</div>
          </div>
          
          <div class="radio-card" id="card-cod" onclick="selectPayment('COD')">
            <div class="radio-header">
              <div class="custom-radio"></div>
              <span class="icon">📦</span>
              <span class="title">Cash on Delivery</span>
            </div>
            <div class="desc">Pay when you receive your order</div>
            <div class="badge badge-orange">+₹25 COD Charges</div>
          </div>
        </div>
        
        <div id="error-msg" class="error"></div>
        
        <button id="continue-btn" class="continue-btn">Continue to Payment</button>
      </div>

      <script>
        const CF_ENV = '${CF_ENV}';
        const sessionId = '${paymentSessionId}';
        const orderId = '${order.id}';
        const baseTotal = ${order.total};
        let selectedMethod = 'PREPAID';
        
        function selectPayment(method) {
          selectedMethod = method;
          document.getElementById('card-prepaid').classList.remove('active');
          document.getElementById('card-cod').classList.remove('active');
          
          if (method === 'PREPAID') {
            document.getElementById('card-prepaid').classList.add('active');
            document.getElementById('display-total').innerText = baseTotal;
          } else {
            document.getElementById('card-cod').classList.add('active');
            document.getElementById('display-total').innerText = baseTotal + 25;
          }
        }

        document.getElementById('continue-btn').addEventListener('click', async () => {
          const btn = document.getElementById('continue-btn');
          
          if (selectedMethod === 'PREPAID') {
            if (!sessionId) {
              document.getElementById('error-msg').innerText = 'Payment session unavailable. Please try COD.';
              document.getElementById('error-msg').style.display = 'block';
              return;
            }
            btn.innerHTML = 'Processing...';
            btn.disabled = true;
            const cf = Cashfree({ mode: CF_ENV });
            cf.checkout({ paymentSessionId: sessionId, redirectTarget: "_self" });
          } else {
            btn.innerHTML = 'Processing...';
            btn.disabled = true;
            
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
              btn.innerHTML = 'Continue to Payment';
              btn.disabled = false;
            }
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

    if (order.status.toUpperCase() !== 'PENDING') {
      return res.status(400).json({ error: 'Order already processed' });
    }

    // Add 25rs COD fee
    const updatedTotal = (order.total || 0) + 25;

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
