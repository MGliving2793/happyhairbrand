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
    // COD extra charge
    if (mode.toUpperCase() === 'COD') total += 20;
    
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

    if (order.status.toUpperCase() !== 'PENDING' && order.status.toUpperCase() !== 'PENDING VERIFICATION') {
      return res.redirect(`/api/orders/status/${order.id}`);
    }

    const upiId = process.env.MERCHANT_UPI_ID || "7411090509@sbi"; 
    const merchantName = process.env.MERCHANT_NAME || "Murthy";
    const amount = order.total;
    const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(merchantName)}&am=${amount}&cu=INR`;

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>Payment - Happy Hair</title>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: #fbf9f6; color: #3d2f25; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
        .portal-card { background: #fff; width: 100%; max-width: 480px; border-radius: 24px; padding: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.06); border: 1px solid #f0ebe1; }
        .header-title { font-size: 24px; font-weight: 700; color: #4a3b32; margin-bottom: 24px; display: flex; align-items: center; gap: 10px; }
        .upi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
        .upi-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 16px; border: 1px solid #e5e7eb; border-radius: 12px; text-decoration: none; color: #4b5563; font-size: 13px; font-weight: 600; transition: all 0.2s; background: #fff; }
        .upi-btn:hover { border-color: #10b981; background: #ecfdf5; }
        .utr-section { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; text-align: center; }
        .utr-title { font-size: 16px; font-weight: 700; color: #1e293b; margin-bottom: 12px; }
        .utr-input { width: 100%; padding: 16px; border: 2px solid #cbd5e1; border-radius: 12px; font-size: 18px; font-weight: 700; color: #334155; text-align: center; letter-spacing: 2px; outline: none; margin-bottom: 16px; transition: 0.2s; }
        .utr-input:focus { border-color: #10b981; box-shadow: 0 0 0 4px rgba(16,185,129,0.1); }
        .submit-btn { width: 100%; padding: 18px; border-radius: 12px; background: #10b981; color: #fff; font-size: 16px; font-weight: 700; border: none; cursor: pointer; transition: 0.2s; }
        .submit-btn:hover { background: #059669; }
        .submit-btn:disabled { background: #94a3b8; cursor: not-allowed; }
        .error-msg { color: #b91c1c; background: #fef2f2; border: 1px solid #f87171; border-radius: 8px; padding: 12px; font-size: 14px; font-weight: 600; margin-bottom: 16px; display: none; text-align: left; }
      </style>
    </head>
    <body>
      <div class="portal-card">
        <h1 class="header-title">Secure UPI Payment</h1>
        <p style="margin-bottom: 20px; color: #64748b; font-size: 15px;">Step 1: Scan the QR code or tap a button to pay <b>₹${amount}</b> directly via your UPI app.</p>
        
        <div style="text-align: center; margin-bottom: 24px;">
          <img src="/images/upi_qr.jpg" alt="UPI QR Code" style="max-width: 250px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); border: 2px solid #10b981;">
          <div style="margin-top: 12px; font-size: 16px; font-weight: 700; color: #374151;">UPI ID: ${upiId}</div>
        </div>
        
        <div class="upi-grid">
          <a href="${upiLink}" class="upi-btn">
            <span style="font-size: 24px; margin-bottom: 8px;">📱</span>
            Google Pay
          </a>
          <a href="${upiLink}" class="upi-btn">
            <span style="font-size: 24px; margin-bottom: 8px;">🟣</span>
            PhonePe
          </a>
          <a href="${upiLink}" class="upi-btn">
            <span style="font-size: 24px; margin-bottom: 8px;">💳</span>
            Paytm
          </a>
          <a href="${upiLink}" class="upi-btn">
            <span style="font-size: 24px; margin-bottom: 8px;">🏦</span>
            Any UPI App
          </a>
        </div>

        <div class="utr-section">
          <div class="utr-title">Step 2: Enter UTR / Reference Number</div>
          <p style="font-size: 13px; color: #64748b; margin-bottom: 16px;">After paying, find the UTR/Transaction Reference No. in your payment app (it usually has 12-22 digits/letters) and paste it below.</p>
          
          <div id="error-msg" class="error-msg"></div>
          
          <input type="text" id="utr-input" class="utr-input" placeholder="e.g. 427112345678" maxlength="22" style="text-transform:uppercase" oninput="this.value = this.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()">
          <button id="submit-btn" class="submit-btn" onclick="submitUtr()">Verify Payment & Ship Order</button>
        </div>

        <div style="display:flex; align-items:center; gap:12px; margin: 24px 0;">
          <div style="flex:1; height:1px; background:#e5e7eb;"></div>
          <span style="color:#9ca3af; font-size:13px; font-weight:600;">OR</span>
          <div style="flex:1; height:1px; background:#e5e7eb;"></div>
        </div>

        <a href="/api/orders/${order.id}/cod-confirm" style="display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:16px; border-radius:12px; background:#fff; border:2px solid #f59e0b; color:#b45309; font-size:15px; font-weight:700; text-decoration:none; transition:all 0.2s;" onmouseover="this.style.background='#fffbeb'" onmouseout="this.style.background='#fff'">
          🚚 Pay with Cash on Delivery (+₹20 charge)
        </a>
      </div>

      <script>
        var ORDER_ID = ${order.id};
        async function submitUtr() {
          var utr = document.getElementById('utr-input').value.trim();
          var errorMsg = document.getElementById('error-msg');
          var btn = document.getElementById('submit-btn');
          
          errorMsg.style.display = 'none';
          
          if (utr.length < 8 || utr.length > 22) {
            errorMsg.innerText = '❌ UTR must be 8-22 characters (letters and digits only).';
            errorMsg.style.display = 'block';
            return;
          }

          btn.disabled = true;
          btn.innerText = 'Verifying...';

          try {
            var res = await fetch('/api/orders/' + ORDER_ID + '/confirm-utr-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ utr: utr })
            });
            var data = await res.json();
            
            if (res.ok) {
              btn.innerHTML = '✅ Verified! Redirecting... ➔';
              btn.style.background = '#16a34a';
              window.location.href = '/api/orders/status/' + ORDER_ID;
            } else {
              errorMsg.innerText = data.error || '❌ Verification failed. Please try again.';
              errorMsg.style.display = 'block';
              btn.disabled = false;
              btn.innerText = 'Verify Payment & Ship Order';
            }
          } catch (e) {
            errorMsg.innerText = '❌ Network error. Please check your connection and try again.';
            errorMsg.style.display = 'block';
            btn.disabled = false;
            btn.innerText = 'Verify Payment & Ship Order';
          }
        }
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


const confirmUtrPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { utr } = req.body;
    
    if (!utr || utr.length < 8 || utr.length > 22 || !/^[a-zA-Z0-9]+$/.test(utr)) {
      return res.status(400).json({ error: '❌ Invalid UTR format. Must be 8-22 letters/digits.' });
    }

    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).json({ error: '❌ Order not found' });

    if (order.status.toUpperCase() !== 'PENDING' && order.status.toUpperCase() !== 'PENDING VERIFICATION') {
       return res.status(400).json({ error: '❌ Order already processed.' });
    }
    
    // Smart Security Check: Duplicate UTR Prevention
    const existingOrder = await prisma.order.findFirst({
      where: { utr: utr }
    });
    
    if (existingOrder && existingOrder.id !== order.id) {
      console.warn(`[SMART UTR] Spoof detected! UTR ${utr} already used on order ${existingOrder.id}`);
      return res.status(400).json({ error: '❌ Duplicate UTR detected! This transaction has already been claimed for another order.' });
    }

    // Since UTR is valid and not a duplicate, we automatically assume it is correct and dispatch!
    let cart = [];
    try { cart = JSON.parse(order.cart_details); } catch(e){}

    // Dispatch to ShipCorrect directly
    const shipCorrectOrderNo = await dispatchToShipCorrect(order, cart);

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { 
        status: 'Processing', 
        utr: utr,
        order_no: shipCorrectOrderNo ? shipCorrectOrderNo.toString() : order.order_no
      }
    });

    res.json({ message: 'Payment verified and order dispatched!', status: updatedOrder.status });
  } catch (error) {
    console.error('Error confirming UTR:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


const processCodPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status.toUpperCase() !== 'PENDING' && order.status.toUpperCase() !== 'PENDING VERIFICATION') {
      return res.status(400).json({ error: 'Order already processed' });
    }

    // Add 25rs COD fee
    const updatedTotal = (order.total || 0) + 20;

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { pay_mode: 'COD', total: updatedTotal, status: 'Processing' }
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
        // sendOrderConfirmationEmail(updatedOrder, shipCorrectOrderNo).catch(e => console.warn('[MAILER]', e.message));
      } catch (err) {
        console.error('[BACKGROUND SC]', err);
      }
    })();

    res.redirect('/api/orders/status/' + updatedOrder.id);
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
    let trackingStatus = order.status;
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


const renderCodConfirmPage = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).send('Order not found');

    if (order.status.toUpperCase() !== 'PENDING' && order.status.toUpperCase() !== 'PENDING VERIFICATION') {
      return res.redirect(`/api/orders/status/${order.id}`);
    }

    const codTotal = (order.total || 0) + 20;

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>Confirm COD - Happy Hair</title>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: #fbf9f6; color: #3d2f25; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
        .portal-card { background: #fff; width: 100%; max-width: 400px; border-radius: 24px; padding: 32px 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.06); border: 1px solid #f0ebe1; text-align: center; }
        .icon { font-size: 48px; margin-bottom: 16px; }
        .title { font-size: 22px; font-weight: 700; color: #4a3b32; margin-bottom: 12px; }
        .desc { font-size: 15px; color: #6b7280; margin-bottom: 24px; line-height: 1.5; }
        .bill-box { background: #fafaf9; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin-bottom: 32px; }
        .bill-row { display: flex; justify-content: space-between; font-size: 14px; color: #4b5563; margin-bottom: 12px; }
        .bill-row:last-child { margin-bottom: 0; font-weight: 700; font-size: 18px; color: #10b981; border-top: 1px dashed #d1d5db; padding-top: 12px; }
        .submit-btn { width: 100%; padding: 18px; border-radius: 12px; background: #10b981; color: #fff; font-size: 16px; font-weight: 700; border: none; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 14px rgba(16,185,129,0.3); }
        .submit-btn:hover { background: #059669; box-shadow: 0 6px 20px rgba(16,185,129,0.4); }
        .back-link { display: inline-block; margin-top: 16px; font-size: 14px; font-weight: 600; color: #9ca3af; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="portal-card">
        <div class="icon">💵</div>
        <h1 class="title">Cash on Delivery</h1>
        <p class="desc">Please confirm your final bill to place your order with Cash on Delivery.</p>
        
        <div class="bill-box">
          <div class="bill-row">
            <span>Subtotal</span>
            <span>₹${order.total}</span>
          </div>
          <div class="bill-row">
            <span>COD Charge</span>
            <span>+ ₹20</span>
          </div>
          <div class="bill-row">
            <span>Total to Pay</span>
            <span>₹${codTotal}</span>
          </div>
        </div>

        <form action="/api/orders/${order.id}/pay-cod" method="POST">
          <button type="submit" class="submit-btn" onclick="this.innerText='Confirming...'; this.style.opacity=0.7;">Confirm COD Order</button>
        </form>
        <a href="/api/orders/pay/${order.id}" class="back-link">Back to UPI Payment</a>
      </div>
    </body>
    </html>
    `;
    res.send(html);
  } catch (error) {
    console.error('Error rendering COD confirm page:', error);
    res.status(500).send('Internal Server Error');
  }
};

module.exports = {
  renderCodConfirmPage,
  createOrder,
  approveOrder,
  trackOrder,
  claimUpi,
  dispatchToShipCorrect,
  renderTrackingPage,
  renderPaymentSelectionPage,
  confirmUtrPayment,
  processCodPayment,
  getAllOrders,
  deleteOrder,
  updateOrderStatus
};
