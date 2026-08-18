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

    if (order.status.toUpperCase() !== 'PENDING' && order.status.toUpperCase() !== 'PAYMENT_FAILED') {
      return res.redirect(`/api/orders/status/${order.id}`);
    }

    const upiId = "murthyjio71@ybl"; 
    const merchantName = "Happy Hair";
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
        .header-title svg { color: #d4af37; }
        
        .section-title { font-size: 16px; font-weight: 700; color: #4a3b32; margin-bottom: 16px; margin-top: 24px; }
        
        .upi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
        .upi-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 16px; border: 1px solid #e5e7eb; border-radius: 12px; text-decoration: none; color: #4b5563; font-size: 13px; font-weight: 600; transition: all 0.2s; background: #fff; }
        .upi-btn:hover { border-color: #d4af37; background: #fffdf7; }
        .upi-icon { width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 20px; font-weight: bold; margin-bottom: 8px; }
        
        .qr-section { background: #fdfbf7; border: 1px solid #f0ebe1; border-radius: 16px; padding: 24px 16px; text-align: center; margin-bottom: 24px; }
        .qr-section img { max-width: 200px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        .qr-hint { font-size: 14px; color: #6b7280; margin-top: 16px; font-weight: 500; }
        
        .upi-id-box { display: flex; align-items: center; gap: 8px; margin-bottom: 32px; }
        .upi-input { flex: 1; padding: 16px; border: 1px solid #e5e7eb; border-radius: 12px; font-size: 14px; font-weight: 600; color: #374151; background: #fafaf9; outline: none; }
        .copy-btn { padding: 16px; background: #4a3b32; color: white; border: none; border-radius: 12px; cursor: pointer; transition: 0.2s; display: flex; align-items: center; justify-content: center; }
        .copy-btn:hover { background: #322822; }
        
        .upload-box { border: 2px dashed #cbd5e1; border-radius: 12px; padding: 24px 16px; text-align: center; cursor: pointer; transition: 0.2s; margin-bottom: 24px; background: #f8fafc; position: relative; }
        .upload-box:hover { border-color: #d4af37; background: #fffdf7; }
        .upload-box.has-file { border-style: solid; border-color: #10b981; background: #ecfdf5; }
        .upload-icon { font-size: 24px; color: #d4af37; margin-bottom: 8px; }
        .upload-text { font-size: 14px; font-weight: 600; color: #475569; }
        .file-input { position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
        
        .submit-btn { width: 100%; padding: 18px; border-radius: 12px; background: #10b981; color: #fff; font-size: 16px; font-weight: 700; border: none; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 14px rgba(16,185,129,0.3); }
        .submit-btn:hover { background: #059669; box-shadow: 0 6px 20px rgba(16,185,129,0.4); }
        .submit-btn:disabled { background: #94a3b8; cursor: not-allowed; box-shadow: none; }

        .error-msg { color: #ef4444; font-size: 13px; font-weight: 600; margin-bottom: 16px; text-align: center; display: none; }
      </style>
    </head>
    <body>
      <div class="portal-card">
        <h1 class="header-title">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>
          Payment
        </h1>
        
        <div class="section-title">Pay via UPI</div>
        <div class="upi-grid">
          <a href="${upiLink}" class="upi-btn" onclick="openApp()">
            <img src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9Im5vIj8+CjxzdmcKICAgd2lkdGg9IjY0IgogICBoZWlnaHQ9IjIzLjk5OTk5OCIKICAgdmlld0JveD0iMCAwIDY0IDIzLjk5OTk5OCIKICAgZmlsbD0ibm9uZSIKICAgdmVyc2lvbj0iMS4xIgogICBpZD0ic3ZnNCIKICAgc29kaXBvZGk6ZG9jbmFtZT0iZ29vZ2xlLXBheS1ncmFkaWVudC5zdmciCiAgIGlua3NjYXBlOnZlcnNpb249IjEuNC4zICgwZDE1Zjc1LCAyMDI1LTEyLTI1KSIKICAgeG1sbnM6aW5rc2NhcGU9Imh0dHA6Ly93d3cuaW5rc2NhcGUub3JnL25hbWVzcGFjZXMvaW5rc2NhcGUiCiAgIHhtbG5zOnNvZGlwb2RpPSJodHRwOi8vc29kaXBvZGkuc291cmNlZm9yZ2UubmV0L0RURC9zb2RpcG9kaS0wLmR0ZCIKICAgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiCiAgIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIKICAgeG1sbnM6c3ZnPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPHNvZGlwb2RpOm5hbWVkdmlldwogICAgIGlkPSJuYW1lZHZpZXc0IgogICAgIHBhZ2Vjb2xvcj0iI2ZmZmZmZiIKICAgICBib3JkZXJjb2xvcj0iIzAwMDAwMCIKICAgICBib3JkZXJvcGFjaXR5PSIwLjI1IgogICAgIGlua3NjYXBlOnNob3dwYWdlc2hhZG93PSIyIgogICAgIGlua3NjYXBlOnBhZ2VvcGFjaXR5PSIwLjAiCiAgICAgaW5rc2NhcGU6cGFnZWNoZWNrZXJib2FyZD0iMCIKICAgICBpbmtzY2FwZTpkZXNrY29sb3I9IiNkMWQxZDEiCiAgICAgaW5rc2NhcGU6em9vbT0iMjIuNjI3NDE3IgogICAgIGlua3NjYXBlOmN4PSIzMC4yOTUxMDYiCiAgICAgaW5rc2NhcGU6Y3k9IjI2Ljk1ODQ0NiIKICAgICBpbmtzY2FwZTp3aW5kb3ctd2lkdGg9IjI0OTYiCiAgICAgaW5rc2NhcGU6d2luZG93LWhlaWdodD0iMTU1OCIKICAgICBpbmtzY2FwZTp3aW5kb3cteD0iLTExIgogICAgIGlua3NjYXBlOndpbmRvdy15PSItMTEiCiAgICAgaW5rc2NhcGU6d2luZG93LW1heGltaXplZD0iMSIKICAgICBpbmtzY2FwZTpjdXJyZW50LWxheWVyPSJnMSIgLz4KICA8bWFzawogICAgIGlkPSJtYXNrMF83MzMyXzI1NjkiCiAgICAgbWFza1VuaXRzPSJ1c2VyU3BhY2VPblVzZSIKICAgICB4PSIyIgogICAgIHk9IjIiCiAgICAgd2lkdGg9IjIwIgogICAgIGhlaWdodD0iMjAiPgogICAgPHBhdGgKICAgICAgIGQ9Im0gMjEuMjk5MywxMC4xNzY1IGggLTkuMzYwNSB2IDMuNjM4IGggNS4zODUgYyAtMC4xNzE3LDEuMzM2OSAtMC45NzU4LDIuNTM3NSAtMi4wMzI5LDMuMjQ2OSAtMC44ODU1LDAuNjAwMyAtMi4wMTQ5LDAuOTY0MSAtMy4zNTIxLDAuOTY0MSAtMi41ODQxMSwwIC00Ljc3OTY3LC0xLjc1NTQgLTUuNTY1NzQsLTQuMTIwMSAtMC4xOTg3NywtMC42MDAyIC0wLjMxNjIzLC0xLjIzNjkgLTAuMzE2MjMsLTEuOTAwOCAwLC0wLjY2NCAwLjExNzQ2LC0xLjMwMDYgMC4zMTYyMywtMS45MDA5IDAuNzg2MDcsLTIuMzY0NzEgMi45ODE2MywtNC4xMjAwNSA1LjU2NTc0LC00LjEyMDA1IDEuNDYzNywwIDIuNzY0OCwwLjUwOTMyIDMuODAzOCwxLjQ5MTU5IEwgMTguNTg4Nyw0LjYxMDMgQyAxNi44NjMsMi45OTEzOSAxNC42MjIyLDIuMDAwMDMgMTEuOTM4OCwyLjAwMDAzIDguMDUzNjIsMS45OTA5MyA0LjcwMTU0LDQuMjM3NDEgMy4wNjYxNiw3LjUxMTYyIDIuMzg4NTIsOC44NTc2OCAyLDEwLjM3NjYgMiwxMS45OTU1IDIsMTMuNjE0NCAyLjM4ODUyLDE1LjEzMzMgMy4wNjYxNiwxNi40NzkzIDQuNzAxNTQsMTkuNzUzNSA4LjA1MzYyLDIyIDExLjkzODgsMjIgYyAyLjY4MzQsMCA0LjkzMzIsLTAuODkxMyA2LjU3NzYsLTIuNDE5MyAxLjg3OTQsLTEuNzQ2MiAyLjk2MzYsLTQuMzExIDIuOTYzNiwtNy4zNTc5IDAsLTAuNzA5NCAtMC4wNjMyLC0xLjM5MTUgLTAuMTgwNywtMi4wNDYzIHoiCiAgICAgICBmaWxsPSIjZmZmZmZmIgogICAgICAgaWQ9InBhdGgxIiAvPgogIDwvbWFzaz4KICA8ZwogICAgIG1hc2s9InVybCgjbWFzazBfNzMzMl8yNTY5KSIKICAgICBpZD0iZzEiCiAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTIsLTIuMDAwMDAyNSkiPgogICAgPHJlY3QKICAgICAgIHg9IjEuMDk2NjgiCiAgICAgICB5PSIxLjA4MTU0IgogICAgICAgd2lkdGg9IjIxLjY4NDYwMSIKICAgICAgIGhlaWdodD0iMjEuODI4MSIKICAgICAgIGZpbGw9InVybCgjcGF0dGVybjBfNzMzMl8yNTY5KSIKICAgICAgIGlkPSJyZWN0MSIgLz4KICA8L2c+CiAgPHBhdGgKICAgICBkPSJNIDI2LDE4LjY2OTQ5OCBWIDAuOTk5OTk3NTUgaCA1Ljk5OCBjIDEuMDU2NiwwIDIuMDE1NiwwLjIzMDMyOTk1IDIuODc3MSwwLjY5MDk4OTk1IDAuODYxNSwwLjQ0NDIgMS41NDQyLDEuMDc3NjEgMi4wNDgxLDEuOTAwMjEgMC41MjAyLDAuODA2MTUgMC43ODAyLDEuNzQzOTIgMC43ODAyLDIuODEzMzEgMCwxLjA1MjkzIC0wLjI2LDEuOTkwNjkgLTAuNzgwMiwyLjgxMzI5IC0wLjUwMzksMC44MjI2MDA1IC0xLjE4NjYsMS40NjQyMDA1IC0yLjA0ODEsMS45MjQ5MDA1IC0wLjg2MTUsMC40NDQyIC0xLjgyMDUsMC42NjYzIC0yLjg3NzEsMC42NjYzIGggLTMuMzE2IHYgNi44NjA1IHogbSAyLjY4MiwtOS40MjcwMDA1IGggMy4zODkyIGMgMC42MzM5LDAgMS4xNzAzLC0wLjEzMTYgMS42MDkyLC0wLjM5NDkgMC40Mzg5LC0wLjI3OTYgMC43NzIxLC0wLjYzMzQgMC45OTk3LC0xLjA2MTEyIDAuMjQzOCwtMC40NDQyMSAwLjM2NTcsLTAuOTA0ODYgMC4zNjU3LC0xLjM4MTk3IDAsLTAuNDc3MTEgLTAuMTIxOSwtMC45Mjk1NSAtMC4zNjU3LC0xLjM1NzMgLTAuMjI3NiwtMC40Mjc3NSAtMC41NjA4LC0wLjc4MTQ3IC0wLjk5OTcsLTEuMDYxMTYgLTAuNDM4OSwtMC4yNzk2OCAtMC45NzUzLC0wLjQxOTUzIC0xLjYwOTIsLTAuNDE5NTMgSCAyOC42ODIgWiIKICAgICBmaWxsPSIjMjAyMTI0IgogICAgIGlkPSJwYXRoMiIgLz4KICA8cGF0aAogICAgIGQ9Im0gNDMuNDQwMywxOS4wNjQzOTggYyAtMC45MTAzLDAgLTEuNzA2NywtMC4xODEgLTIuMzg5NSwtMC41NDI5IC0wLjY4MjcsLTAuMzYyIC0xLjIyNzIsLTAuODU1NiAtMS42MzM2LC0xLjQ4MDcgLTAuMzkwMSwtMC42NDE3IC0wLjU4NTEsLTEuMzczOCAtMC41ODUxLC0yLjE5NjQgMCwtMC45MDQ4IDAuMjI3NSwtMS42Njk5IDAuNjgyNywtMi4yOTUgMC40NzE0LC0wLjYyNTIgMS4wODksLTEuMTAyMyAxLjg1MywtMS40MzE0IDAuNzgwMiwtMC4zMjkgMS42NDE4LC0wLjQ5MzUgMi41ODQ1LC0wLjQ5MzUgMC41MzY0LDAgMS4wMjQxLDAuMDQxMSAxLjQ2MywwLjEyMzQgMC40Mzg4LDAuMDY1OCAwLjgyOSwwLjE0OCAxLjE3MDMsMC4yNDY3IDAuMzQxNCwwLjA5ODcgMC42MDk2LDAuMjA1NyAwLjgwNDYsMC4zMjA5IHYgLTAuNjY2NCBjIDAsLTAuODIyNjAwNSAtMC4yOTI2LC0xLjQ4MDYwMDUgLTAuODc3NywtMS45NzQyMDA1IC0wLjU4NTIsLTAuNDkzNiAtMS4zNDExLC0wLjc0MDM1IC0yLjI2NzYsLTAuNzQwMzUgLTAuNjMzOSwwIC0xLjIzNTMsMC4xNDgwNSAtMS44MDQzLDAuNDQ0MjUgLTAuNTY4OSwwLjI3OTYgLTEuMDMyMSwwLjY2NjMgLTEuMzg5OCwxLjE1OTggbCAtMS43Nzk4LC0xLjQwNjYgYyAwLjM1NzYsLTAuNTEwMDQgMC43ODgzLC0wLjk0NjAyIDEuMjkyMiwtMS4zMDc5NyAwLjUyMDIsLTAuMzYxOTQgMS4wOTcyLC0wLjY0MTYzIDEuNzMxMSwtMC44MzkwNSAwLjYzNCwtMC4xOTc0MyAxLjMwODYsLTAuMjk2MTQgMi4wMjM4LC0wLjI5NjE0IDEuNzg4LDAgMy4xNjk2LDAuNDUyNDMgNC4xNDQ5LDEuMzU3MyAwLjk3NTMsMC44ODg0MSAxLjQ2MywyLjEzODc2IDEuNDYzLDMuNzUxMDYwNSB2IDcuODcyMyBoIC0yLjUzNTggdiAtMS41NTQ3IGggLTAuMTQ2MyBjIC0wLjIyNzUsMC4zMjkgLTAuNTI4MywwLjY0MTYgLTAuOTAyMSwwLjkzNzggLTAuMzU3NiwwLjI5NjEgLTAuNzgwMiwwLjUzNDcgLTEuMjY3OSwwLjcxNTYgLTAuNDg3NiwwLjE5NzUgLTEuMDMyMiwwLjI5NjIgLTEuNjMzNiwwLjI5NjIgeiBtIDAuNDYzMywtMi4xNzE3IGMgMC42ODI3LDAgMS4yODQxLC0wLjE2NDUgMS44MDQyLC0wLjQ5MzYgMC41MjAyLC0wLjMyOSAwLjkyNjYsLTAuNzU2OCAxLjIxOTIsLTEuMjgzMiAwLjMwODgsLTAuNTQyOSAwLjQ2MzIsLTEuMTI3IDAuNDYzMiwtMS43NTIyIC0wLjM3MzgsLTAuMjEzOCAtMC44MTI3LC0wLjM4NjYgLTEuMzE2NiwtMC41MTgyIC0wLjUwMzksLTAuMTQ4MSAtMS4wNDg1LC0wLjIyMjEgLTEuNjMzNiwtMC4yMjIxIC0xLjA1NjYsMCAtMS44MTI0LDAuMjEzOSAtMi4yNjc2LDAuNjQxNiAtMC40NTUxLDAuNDI3OCAtMC42ODI3LDAuOTYyNSAtMC42ODI3LDEuNjA0MSAwLDAuNTkyMyAwLjIxMTMsMS4wNzc2IDAuNjM0LDEuNDU2IDAuNDM4OCwwLjM3ODQgMS4wMzIxLDAuNTY3NiAxLjc3OTksMC41Njc2IHoiCiAgICAgZmlsbD0iIzIwMjEyNCIKICAgICBpZD0icGF0aDMiIC8+CiAgPHBhdGgKICAgICBkPSJtIDU2LjU4NzgsMjMuMzgyOTk4IGMgLTAuMDQ4NywwLjExNTIgLTAuMTA1NiwwLjIzMDQgLTAuMTcwNywwLjM0NTUgLTAuMDQ4NywwLjEzMTcgLTAuMDgxMiwwLjIyMjEgLTAuMDk3NSwwLjI3MTUgaCAtMi44MDM5IGMgMC4wODEyLC0wLjE4MSAwLjE5NSwtMC40MzYgMC4zNDEzLC0wLjc2NSAwLjE2MjYsLTAuMzI5MSAwLjMxNywtMC42NTgxIDAuNDYzMywtMC45ODcxIDAuMDk3NSwtMC4yMTM5IDAuMTk1LC0wLjQ0NDMgMC4yOTI2LC0wLjY5MSAwLjExMzcsLTAuMjQ2OCAwLjIyNzUsLTAuNTAxOCAwLjM0MTMsLTAuNzY1MSAwLjEzMDEsLTAuMjYzMiAwLjI1MiwtMC41MTgyIDAuMzY1NywtMC43NjUgbCAwLjkyNjYsLTIuMDQ4MyAtNS4xOTM0LC0xMS44OTQ4MTA1IGggMi45MjU4IGwgMy41NTk4LDguNTg4MDEwNSBoIDAuMTIxOSBMIDYxLjA5ODUsNi4wODM2ODc1IEggNjQgTCA1Ny41NjMxLDIxLjA4Nzk5OCBjIC0wLjExMzgsMC4yNzk3IC0wLjI0MzgsMC41NzU4IC0wLjM5MDEsMC44ODg0IC0wLjEzLDAuMzEyNiAtMC4yNTIsMC41OTIzIC0wLjM2NTcsMC44MzkgLTAuMDk3NiwwLjI2MzMgLTAuMTcwNywwLjQ1MjUgLTAuMjE5NSwwLjU2NzYgeiIKICAgICBmaWxsPSIjMjAyMTI0IgogICAgIGlkPSJwYXRoNCIgLz4KICA8ZGVmcwogICAgIGlkPSJkZWZzNCI+CiAgICA8cGF0dGVybgogICAgICAgaWQ9InBhdHRlcm4wXzczMzJfMjU2OSIKICAgICAgIHBhdHRlcm5Db250ZW50VW5pdHM9Im9iamVjdEJvdW5kaW5nQm94IgogICAgICAgd2lkdGg9IjEiCiAgICAgICBoZWlnaHQ9IjEiPgogICAgICA8dXNlCiAgICAgICAgIHhsaW5rOmhyZWY9IiNpbWFnZTBfNzMzMl8yNTY5IgogICAgICAgICB0cmFuc2Zvcm09InNjYWxlKDAuMDQxNjY2NykiCiAgICAgICAgIGlkPSJ1c2U0IiAvPgogICAgPC9wYXR0ZXJuPgogICAgPGltYWdlCiAgICAgICBpZD0iaW1hZ2UwXzczMzJfMjU2OSIKICAgICAgIHdpZHRoPSIyNCIKICAgICAgIGhlaWdodD0iMjQiCiAgICAgICBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJub25lIgogICAgICAgeGxpbms6aHJlZj0iZGF0YTppbWFnZS9wbmc7YmFzZTY0LGlWQk9SdzBLR2dvQUFBQU5TVWhFVWdBQUFCZ0FBQUFZQ0FZQUFBRGdkejM0QUFBQUNYQklXWE1BQUFzU0FBQUxFZ0hTM1g3OEFBQUQva2xFUVZSSWlZV1ZUMjhjUlJERmY5WGRzenV6WHNkMkhNbE9pQ1VRQWlGdUhMam55a2ZpZy9FSk9DRXUvQkVTUWtBZ0N0aHgvTis3TzdzejAvVTR6SHAzSGNtaHBOYlV6UFM4cW5yMXFzZjA5Y2ZpdW9RbVFqYTRxYUFMdmQ4a0VJREIzVVVBQVRBVUJrQkdHRmlBV0dIS3lCS1dHd1FrOXVmOXgzV0NlWUt5NllIYkNObEJCbTVMY091aldBUWlSc0JqaVN6MEFRQlp4RENVS29TUjJKdURBKzBXN0MyRFhRVW92QWZPb2M5NEJiN00xaUpZZ3BENmIwTEJuUWtRaHJrVFZ1VnZMMVlicU5xMWYvZitmYmJNL2wxVFNDU2V6Q0MxUFQxMWhPZ3dHOERNbDMxUXY5cTQ0aDdyQzlJS2VKMkVWdmVHTEJCNDNNTEJISkxEMHhvT2FraUNKM040MUVBVVZMbC90bVJKSzFpeDBmblZjNEJzQVJGWTE3YS9RZEZkTHdES2J1MEgzV2RNNzhMZXQyeEdZaFFoQVNOQm15SFZNR3VncmlHMitNa1QzcVpEVHFwblhHb1hwMWVRTFBKUi9XYWxvSmZWMFVaVkFBRlpJSkVTQkljT0dBRzVneUpEVThDakJXM252Rnc4NTV2QlYvd1dQcUZoc09LNHozOHBZWXdnRVhCTUlpbHowRnlTVnZXTWdBYW9CRkdvenN4dmgzVGJOZGZEeE90d3lGOTJSR1BEQnlreENhTmZ5VE92eXFja2ViUFVNMWhwNEtBaFhFd2U4MGY1T2Q4dFhuQVNQK1NNUFRyaWcrQjMzZEN5dWh3Q0JuMEFDNmt2MlFJS2dpeXV5MTErTHI3Z3gvQWxwenpua3YwbC8rOHhlMmRtcEEyS05zeVRZYU9XNDNURTIzVElhWDVHNnc5VDgyQkZaaVFCcGc0UmNEa05RZ3FjeTZoMmYySXZCdXJacDF6ZmZrYmJQRVlxbG5RNG14Tmg5L1M3OXBNQWwrT0ltY1NOWUNhWUZjZU1kcjdsZyszdm1WKytZTjVXdE8wT3FOZ0FGLzkzbENTQVRrNjNJVDJBZWJoaHU1eXk3eVhIMVZOaW1HSG93Ykc2SDJwOWx5WnVUQ1ZxeEZ4d0lpTVQrTVdIWEdqSWhWZWNxdVJtL0RzVEcrQmVrbjBBU2xnZVlWNWdLdWpNS1hMRklBOEJFZFMzTjUwNlhFaVVCbjg3VEFWWEdITmwvdldTUzkvaVpERGhZdmNIYm5kL0pXdEFiZzZnMjhZV2gxZzNKblpqWXQ0aStJU3R4UzZZR0xaYkJJVzFpczU4ZVZYZ1VwRXJDczY4NUVvbEY3R2hIcjJpMDZoZjBhRzdoY0V0Vmg4UjI0YllaYXI1UGsycUdlU3liN1VDNmFXTE04RkV4aFRqbFZkY01lUmFKU2Q2eE5USFpDVmF5cjVsS2docGlwUWd6c0dINUxEQTQ0SWlENGs0MHpqSHphbWFNZWxQd1ptTUljWnJEZmxIWTBUZ2pYYTU4aDFFcEdHTU5FUkVVbWpKYnVTd0lKamo2UWJhSFJoY1VxdEFZWS9PQWprNFFiWStyaSswbnRLSjFrUFZiUGhoUTBNaGJCenB4ZFY2ZjVxdmR0WEZoSFRzeGprRHBpcVlxZUJNWTZZYUxkY1dMU1dkQmt2VkJ5UXc2N0Fna0tPd0FOdUNPRU94UmtxNFRlaHlRY0JKNXlUT05VUUVyaGh6bzIxYUZkUjZ4RUlWSWkzUG9QN1BaU1pNd2trRXk1QW11Q0pTUWRZQXpHbVZ5QmplanZrUFdQa1hqbldMbFhnQUFBQUFTVVZPUks1Q1lJST0iIC8+CiAgPC9kZWZzPgo8L3N2Zz4K" alt="GPay" style="height:24px; margin-bottom:8px;">
            Google Pay
          </a>
          <a href="${upiLink}" class="upi-btn" onclick="openApp()">
            <img src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9Im5vIj8+CjxzdmcKICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICB4bWxuczpjYz0iaHR0cDovL2NyZWF0aXZlY29tbW9ucy5vcmcvbnMjIgogICB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiCiAgIHhtbG5zOnN2Zz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciCiAgIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIKICAgeG1sbnM6c29kaXBvZGk9Imh0dHA6Ly9zb2RpcG9kaS5zb3VyY2Vmb3JnZS5uZXQvRFREL3NvZGlwb2RpLTAuZHRkIgogICB4bWxuczppbmtzY2FwZT0iaHR0cDovL3d3dy5pbmtzY2FwZS5vcmcvbmFtZXNwYWNlcy9pbmtzY2FwZSIKICAgdmVyc2lvbj0iMS4xIgogICBpZD0iTGF5ZXJfMiIKICAgeD0iMCIKICAgeT0iMCIKICAgdmlld0JveD0iMCAwIDIzMCA2OS43NDYyOTIiCiAgIHhtbDpzcGFjZT0icHJlc2VydmUiCiAgIHNvZGlwb2RpOmRvY25hbWU9IlBob25lUGUuc3ZnIgogICB3aWR0aD0iMjMwIgogICBoZWlnaHQ9IjY5Ljc0NjI5MiIKICAgaW5rc2NhcGU6dmVyc2lvbj0iMS4wLjEgKDNiYzJlODEzZjUsIDIwMjAtMDktMDcpIj48bWV0YWRhdGEKICAgICBpZD0ibWV0YWRhdGEzOCI+PHJkZjpSREY+PGNjOldvcmsKICAgICAgICAgcmRmOmFib3V0PSIiPjxkYzpmb3JtYXQ+aW1hZ2Uvc3ZnK3htbDwvZGM6Zm9ybWF0PjxkYzp0eXBlCiAgICAgICAgICAgcmRmOnJlc291cmNlPSJodHRwOi8vcHVybC5vcmcvZGMvZGNtaXR5cGUvU3RpbGxJbWFnZSIgLz48ZGM6dGl0bGU+PC9kYzp0aXRsZT48L2NjOldvcms+PC9yZGY6UkRGPjwvbWV0YWRhdGE+PGRlZnMKICAgICBpZD0iZGVmczM2IiAvPjxzb2RpcG9kaTpuYW1lZHZpZXcKICAgICBwYWdlY29sb3I9IiNmZmZmZmYiCiAgICAgYm9yZGVyY29sb3I9IiM2NjY2NjYiCiAgICAgYm9yZGVyb3BhY2l0eT0iMSIKICAgICBvYmplY3R0b2xlcmFuY2U9IjEwIgogICAgIGdyaWR0b2xlcmFuY2U9IjEwIgogICAgIGd1aWRldG9sZXJhbmNlPSIxMCIKICAgICBpbmtzY2FwZTpwYWdlb3BhY2l0eT0iMCIKICAgICBpbmtzY2FwZTpwYWdlc2hhZG93PSIyIgogICAgIGlua3NjYXBlOndpbmRvdy13aWR0aD0iMTkyMCIKICAgICBpbmtzY2FwZTp3aW5kb3ctaGVpZ2h0PSIxMDAxIgogICAgIGlkPSJuYW1lZHZpZXczNCIKICAgICBzaG93Z3JpZD0iZmFsc2UiCiAgICAgbG9jay1tYXJnaW5zPSJ0cnVlIgogICAgIGZpdC1tYXJnaW4tdG9wPSI1IgogICAgIGZpdC1tYXJnaW4tbGVmdD0iNSIKICAgICBmaXQtbWFyZ2luLXJpZ2h0PSI1IgogICAgIGZpdC1tYXJnaW4tYm90dG9tPSI1IgogICAgIGlua3NjYXBlOnpvb209IjMuNTU2OTYxNCIKICAgICBpbmtzY2FwZTpjeD0iMTAxLjEyNDIyIgogICAgIGlua3NjYXBlOmN5PSI2My42NTQwODgiCiAgICAgaW5rc2NhcGU6d2luZG93LXg9Ii05IgogICAgIGlua3NjYXBlOndpbmRvdy15PSItOSIKICAgICBpbmtzY2FwZTp3aW5kb3ctbWF4aW1pemVkPSIxIgogICAgIGlua3NjYXBlOmN1cnJlbnQtbGF5ZXI9IkxheWVyXzIiIC8+PHN0eWxlCiAgICAgaWQ9InN0eWxlMjUiPi5zdDB7ZmlsbDojNWYyNTlmfTwvc3R5bGU+PGNpcmNsZQogICAgIHRyYW5zZm9ybT0icm90YXRlKC03Ni43MTQpIgogICAgIGNsYXNzPSJzdDAiCiAgICAgY3g9Ii0yNS45MjU1MDMiCiAgICAgY3k9IjQxLjk1NDAzMyIKICAgICByPSIyOS44NzMxNDYiCiAgICAgaWQ9ImNpcmNsZTI3IgogICAgIHN0eWxlPSJzdHJva2Utd2lkdGg6MS42Njg4OSIgLz48cGF0aAogICAgIGNsYXNzPSJzdDAiCiAgICAgZD0iTSAxNTYuMDc0ODEsNTEuOTQzMjc0IFYgNDEuMDk1NDgzIGMgMCwtMi42NzAyMjYgLTEuMDAxMzMsLTQuMDA1MzM4IC0zLjUwNDY3LC00LjAwNTMzOCAtMS4wMDEzNCwwIC0yLjE2OTU2LDAuMTY2ODg5IC0yLjgzNzEyLDAuMzMzNzc4IHYgMTUuODU0NDY0IGMgMCwwLjUwMDY2NyAtMC41MDA2NywxLjAwMTMzNCAtMS4wMDEzMywxLjAwMTMzNCBoIC0zLjgzODQ1IGMgLTAuNTAwNjYsMCAtMS4wMDEzMywtMC41MDA2NjcgLTEuMDAxMzMsLTEuMDAxMzM0IFYgMzQuNzUzNjk4IGMgMCwtMC42Njc1NTYgMC41MDA2NywtMS4xNjgyMjMgMS4wMDEzMywtMS4zMzUxMTMgMi41MDMzNCwtMC44MzQ0NDYgNS4wMDY2NywtMS4zMzUxMTMgNy42NzY5LC0xLjMzNTExMyA2LjAwODAxLDAgOS4zNDU3OSwzLjE3MDg5MyA5LjM0NTc5LDkuMDEyMDExIHYgMTIuMzQ5NzkzIGMgMCwwLjUwMDY2NyAtMC41MDA2NywxLjAwMTMzNCAtMS4wMDEzMywxLjAwMTMzNCBoIC0yLjMzNjQ1IGMgLTEuNTAyLDAgLTIuNTAzMzQsLTEuMTY4MjIzIC0yLjUwMzM0LC0yLjUwMzMzNiB6IG0gMTUuMDIwMDIsLTYuNTA4Njc1IC0wLjE2Njg5LDEuNTAyMDAyIGMgMCwyLjAwMjY2OSAxLjMzNTExLDMuMTcwODkzIDMuNTA0NjcsMy4xNzA4OTMgMS42Njg4OSwwIDMuMTcwOSwtMC41MDA2NjggNC44Mzk3OSwtMS4zMzUxMTMgMC4xNjY4OCwwIDAuMzMzNzcsLTAuMTY2ODg5IDAuNTAwNjYsLTAuMTY2ODg5IDAuMzMzNzgsMCAwLjUwMDY3LDAuMTY2ODg5IDAuNjY3NTYsMC4zMzM3NzggMC4xNjY4OCwwLjE2Njg4OSAwLjUwMDY3LDAuNjY3NTU2IDAuNTAwNjcsMC42Njc1NTYgMC4zMzM3NywwLjUwMDY2OCAwLjY2NzU1LDEuMTY4MjI1IDAuNjY3NTUsMS42Njg4OTIgMCwwLjgzNDQ0NSAtMC41MDA2NywxLjY2ODg5IC0xLjE2ODIyLDIuMDAyNjY5IC0xLjgzNTc4LDEuMDAxMzM0IC00LjAwNTM0LDEuNTAyMDAxIC02LjM0MTc4LDEuNTAyMDAxIC0yLjY3MDI0LDAgLTQuODM5NzksLTAuNjY3NTU2IC02LjUwODY4LC0yLjAwMjY2OSAtMS42Njg4OSwtMS41MDIwMDEgLTIuNjcwMjMsLTMuNTA0NjcxIC0yLjY3MDIzLC02LjAwODAwNyB2IC02LjUwODY3NSBjIDAsLTUuMTczNTYxIDMuMzM3NzgsLTguMzQ0NDU0IDkuMDEyMDEsLTguMzQ0NDU0IDUuNTA3MzQsMCA4LjY3ODI0LDMuMDA0MDA0IDguNjc4MjQsOC4zNDQ0NTQgdiA0LjAwNTMzOSBjIDAsMC41MDA2NjcgLTAuNTAwNjcsMS4wMDEzMzQgLTEuMDAxMzQsMS4wMDEzMzQgaCAtMTAuNTE0MDEgeiBtIC0wLjE2Njg5LC0zLjY3MTU1OSBoIDYuMzQxNzggdiAtMS42Njg4OTIgYyAwLC0yLjAwMjY2OSAtMS4xNjgyMiwtMy4zMzc3ODEgLTMuMTcwODgsLTMuMzM3NzgxIC0yLjAwMjY4LDAgLTMuMTcwOSwxLjE2ODIyMyAtMy4xNzA5LDMuMzM3NzgxIHogbSA0Mi41NTY3MiwzLjY3MTU1OSAtMC4xNjY4OSwxLjUwMjAwMiBjIDAsMi4wMDI2NjkgMS4zMzUxMSwzLjE3MDg5MyAzLjUwNDY3LDMuMTcwODkzIDEuNjY4ODksMCAzLjE3MDg5LC0wLjUwMDY2OCA0LjgzOTc4LC0xLjMzNTExMyAwLjE2Njg5LDAgMC4zMzM3OSwtMC4xNjY4ODkgMC41MDA2NywtMC4xNjY4ODkgMC4zMzM3OCwwIDAuNTAwNjYsMC4xNjY4ODkgMC42Njc1NiwwLjMzMzc3OCAwLjE2Njg5LDAuMTY2ODg5IDAuNTAwNjYsMC42Njc1NTYgMC41MDA2NiwwLjY2NzU1NiAwLjMzMzc5LDAuNTAwNjY4IDAuNjY3NTYsMS4xNjgyMjUgMC42Njc1NiwxLjY2ODg5MiAwLDAuODM0NDQ1IC0wLjUwMDY3LDEuNjY4ODkgLTEuMTY4MjIsMi4wMDI2NjkgLTEuODM1NzksMS4wMDEzMzQgLTQuMDA1MzQsMS41MDIwMDEgLTYuMzQxNzksMS41MDIwMDEgLTIuNjcwMjIsMCAtNC44Mzk3OCwtMC42Njc1NTYgLTYuNTA4NjcsLTIuMDAyNjY5IC0xLjY2ODg5LC0xLjUwMjAwMSAtMi42NzAyMywtMy41MDQ2NzEgLTIuNjcwMjMsLTYuMDA4MDA3IHYgLTYuNTA4Njc1IGMgMCwtNS4xNzM1NjEgMy4zMzc3OCwtOC4zNDQ0NTQgOS4wMTIwMiwtOC4zNDQ0NTQgNS41MDczMywwIDguNjc4MjIsMy4wMDQwMDQgOC42NzgyMiw4LjM0NDQ1NCB2IDQuMDA1MzM5IGMgMCwwLjUwMDY2NyAtMC41MDA2NiwxLjAwMTMzNCAtMS4wMDEzMywxLjAwMTMzNCBoIC0xMC41MTQwMSB6IG0gLTAuMTY2ODksLTMuNjcxNTU5IGggNi4zNDE3OSB2IC0xLjY2ODg5MiBjIDAsLTIuMDAyNjY5IC0xLjE2ODIzLC0zLjMzNzc4MSAtMy4xNzA5LC0zLjMzNzc4MSAtMi4wMDI2NywwIC0zLjE3MDg5LDEuMTY4MjIzIC0zLjE3MDg5LDMuMzM3NzgxIHogbSAtOTguMTMwNzksMTIuNjgzNTcgaCAyLjMzNjQ1IGMgMC41MDA2NywwIDEuMDAxMzMsLTAuNTAwNjY3IDEuMDAxMzMsLTEuMDAxMzM0IFYgNDEuMDk1NDgzIGMgMCwtNS42NzQyMjkgLTMuMDAzOTksLTkuMDEyMDExIC04LjAxMDY3LC05LjAxMjAxMSAtMS41MDIsMCAtMy4xNzA4OSwwLjMzMzc3OCAtNC4xNzIyMiwwLjY2NzU1NiB2IC02LjE3NDg5NSBjIDAsLTEuMzM1MTEzIC0xLjE2ODIzLC0yLjUwMzMzNyAtMi41MDMzNSwtMi41MDMzMzcgaCAtMi4zMzY0NCBjIC0wLjUwMDY3LDAgLTEuMDAxMzQsMC41MDA2NjcgLTEuMDAxMzQsMS4wMDEzMzUgdiAyOC4zNzExNDUgYyAwLDAuNTAwNjY3IDAuNTAwNjcsMS4wMDEzMzQgMS4wMDEzNCwxLjAwMTMzNCBoIDMuODM4NDQgYyAwLjUwMDY4LDAgMS4wMDEzNSwtMC41MDA2NjcgMS4wMDEzNSwtMS4wMDEzMzQgViAzNy43NTc3MDEgYyAwLjgzNDQ0LC0wLjMzMzc3OCAyLjAwMjY2LC0wLjUwMDY2NyAyLjgzNzExLC0wLjUwMDY2NyAyLjUwMzMzLDAgMy41MDQ2NywxLjE2ODIyMyAzLjUwNDY3LDQuMDA1MzM4IHYgMTAuODQ3NzkxIGMgMC4xNjY4OCwxLjE2ODIyNCAxLjE2ODIzLDIuMzM2NDQ3IDIuNTAzMzMsMi4zMzY0NDcgeiBtIDI1LjIwMDI2LC0xNC4wMTg2ODQgdiA2LjE3NDg5NyBjIDAsNS4xNzM1NjIgLTMuNTA0NjgsOC4zNDQ0NTQgLTkuMzQ1OCw4LjM0NDQ1NCAtNS42NzQyMiwwIC05LjM0NTc4LC0zLjE3MDg5MiAtOS4zNDU3OCwtOC4zNDQ0NTQgdiAtNi4xNzQ4OTcgYyAwLC01LjE3MzU2MSAzLjUwNDY3LC04LjM0NDQ1NCA5LjM0NTc4LC04LjM0NDQ1NCA1Ljg0MTEyLDAgOS4zNDU4LDMuMTcwODkzIDkuMzQ1OCw4LjM0NDQ1NCB6IG0gLTUuODQxMTIsMCBjIDAsLTIuMDAyNjY5IC0xLjE2ODIzLC0zLjMzNzc4MSAtMy4zMzc3OCwtMy4zMzc3ODEgLTIuMTY5NTYsMCAtMy4zMzc3OCwxLjE2ODIyMyAtMy4zMzc3OCwzLjMzNzc4MSB2IDYuMTc0ODk3IGMgMCwyLjAwMjY2OSAxLjE2ODIyLDMuMTcwODkyIDMuMzM3NzgsMy4xNzA4OTIgMi4xNjk1NSwwIDMuMzM3NzgsLTEuMTY4MjIzIDMuMzM3NzgsLTMuMTcwODkyIHogTSA5Ny4zMjk4NSwzNy41OTA4MTIgYyAwLDUuMzQwNDUxIC00LjAwNTMzNyw5LjAxMjAxMSAtOS4zNDU3ODgsOS4wMTIwMTEgLTEuMzM1MTEzLDAgLTIuNTAzMzM2LC0wLjE2Njg4OSAtMy42NzE1NiwtMC42Njc1NTYgdiA3LjUxMDAwOSBjIDAsMC41MDA2NjcgLTAuNTAwNjY3LDEuMDAxMzM0IC0xLjAwMTMzNCwxLjAwMTMzNCBoIC0zLjgzODQ1IGMgLTAuNTAwNjY3LDAgLTEuMDAxMzM0LC0wLjUwMDY2NyAtMS4wMDEzMzQsLTEuMDAxMzM0IFYgMjYuOTA5OTExIGMgMCwtMC42Njc1NTYgMC41MDA2NjcsLTEuMTY4MjI0IDEuMDAxMzM0LC0xLjMzNTExMyAyLjUwMzMzNiwtMC44MzQ0NDYgNS4wMDY2NzMsLTEuMzM1MTEzIDcuNjc2ODk4LC0xLjMzNTExMyA2LjAwODAwOCwwIDEwLjE4MDIzNCwzLjY3MTU2IDEwLjE4MDIzNCw5LjM0NTc5IHogbSAtNi4wMDgwMDYsLTQuMzM5MTE2IGMgMCwtMi42NzAyMjYgLTEuODM1NzgxLC00LjAwNTMzOCAtNC4zMzkxMTcsLTQuMDA1MzM4IC0xLjUwMjAwMSwwIC0yLjUwMzMzNiwwLjUwMDY2NyAtMi41MDMzMzYsMC41MDA2NjcgdiAxMS4wMTQ2NzkgYyAxLjAwMTMzNSwwLjUwMDY2OCAxLjUwMjAwMiwwLjY2NzU1NyAyLjY3MDIyNSwwLjY2NzU1NyAyLjUwMzMzNiwwIDQuMzM5MTE3LC0xLjUwMjAwMiA0LjMzOTExNywtNC4wMDUzMzggViAzMy4yNTE2OTYgWiBNIDIwNS4xNDAyLDM3LjU5MDgxMiBjIDAsNS4zNDA0NTEgLTQuMDA1MzQsOS4wMTIwMTEgLTkuMzQ1NzgsOS4wMTIwMTEgLTEuMzM1MTIsMCAtMi41MDMzNCwtMC4xNjY4ODkgLTMuNjcxNTcsLTAuNjY3NTU2IHYgNy41MTAwMDkgYyAwLDAuNTAwNjY3IC0wLjUwMDY2LDEuMDAxMzM0IC0xLjAwMTMzLDEuMDAxMzM0IGggLTMuODM4NDUgYyAtMC41MDA2NywwIC0xLjAwMTM0LC0wLjUwMDY2NyAtMS4wMDEzNCwtMS4wMDEzMzQgViAyNi45MDk5MTEgYyAwLC0wLjY2NzU1NiAwLjUwMDY3LC0xLjE2ODIyNCAxLjAwMTM0LC0xLjMzNTExMyAyLjUwMzM0LC0wLjgzNDQ0NiA1LjAwNjY4LC0xLjMzNTExMyA3LjY3NjksLTEuMzM1MTEzIDYuMDA4LDAgMTAuMTgwMjMsMy42NzE1NiAxMC4xODAyMyw5LjM0NTc5IHogbSAtNi4wMDgsLTQuMzM5MTE2IGMgMCwtMi42NzAyMjYgLTEuODM1NzgsLTQuMDA1MzM4IC00LjMzOTEyLC00LjAwNTMzOCAtMS41MDIsMCAtMi41MDMzMywwLjUwMDY2NyAtMi41MDMzMywwLjUwMDY2NyB2IDExLjAxNDY3OSBjIDEuMDAxMzMsMC41MDA2NjggMS41MDE5OSwwLjY2NzU1NyAyLjY3MDIyLDAuNjY3NTU3IDIuNTAzMzQsMCA0LjMzOTExLC0xLjUwMjAwMiA0LjMzOTExLC00LjAwNTMzOCB2IC00LjE3MjIyNyB6IgogICAgIGlkPSJwYXRoMjkiCiAgICAgc3R5bGU9InN0cm9rZS13aWR0aDoxLjY2ODg5IiAvPjxwYXRoCiAgICAgZD0ibSA0OC40MzEzNDcsMjcuMDc2OCBjIDAsLTEuMTY4MjI0IC0xLjAwMTMzNCwtMi4xNjk1NTggLTIuMTY5NTU3LC0yLjE2OTU1OCBoIC00LjAwNTMzOCBsIC05LjE3ODksLTEwLjUxNDAxMyBjIC0wLjgzNDQ0NiwtMS4wMDEzMzUgLTIuMTY5NTU5LC0xLjMzNTExMyAtMy41MDQ2NzEsLTEuMDAxMzM1IGwgLTMuMTcwODkzLDEuMDAxMzM1IGMgLTAuNTAwNjY3LDAuMTY2ODg5IC0wLjY2NzU1NiwwLjgzNDQ0NSAtMC4zMzM3NzgsMS4xNjgyMjMgbCAxMC4wMTMzNDUsOS41MTI2NzkgSCAyMC44OTQ2NDggYyAtMC41MDA2NjcsMCAtMC44MzQ0NDUsMC4zMzM3NzggLTAuODM0NDQ1LDAuODM0NDQ1IHYgMS42Njg4OTEgYyAwLDEuMTY4MjI0IDEuMDAxMzM0LDIuMTY5NTU4IDIuMTY5NTU4LDIuMTY5NTU4IGggMi4zMzY0NDggdiA4LjAxMDY3NiBjIDAsNi4wMDgwMDggMy4xNzA4OTIsOS41MTI2NzggOC41MTEzNDMsOS41MTI2NzggMS42Njg4OTEsMCAzLjAwNDAwMywtMC4xNjY4ODkgNC42NzI4OTQsLTAuODM0NDQ1IHYgNS4zNDA0NTEgYyAwLDEuNTAyMDAyIDEuMTY4MjI0LDIuNjcwMjI1IDIuNjcwMjI1LDIuNjcwMjI1IGggMi4zMzY0NDggYyAwLjUwMDY2NywwIDEuMDAxMzM1LC0wLjUwMDY2NyAxLjAwMTMzNSwtMS4wMDEzMzQgdiAtMjMuODY1MTQgaCAzLjgzODQ0OCBjIDAuNTAwNjY3LDAgMC44MzQ0NDUsLTAuMzMzNzc4IDAuODM0NDQ1LC0wLjgzNDQ0NSB6IE0gMzcuNzUwNDQ2LDQxLjQyOTI2MSBjIC0xLjAwMTMzNCwwLjUwMDY2OCAtMi4zMzY0NDcsMC42Njc1NTcgLTMuMzM3NzgxLDAuNjY3NTU3IC0yLjY3MDIyNiwwIC00LjAwNTMzOSwtMS4zMzUxMTQgLTQuMDA1MzM5LC00LjMzOTExNyB2IC04LjAxMDY3NiBoIDcuMzQzMTIgeiIKICAgICBmaWxsPSIjZmZmZmZmIgogICAgIGlkPSJwYXRoMzEiCiAgICAgc3R5bGU9InN0cm9rZS13aWR0aDoxLjY2ODg5IiAvPjwvc3ZnPgo=" alt="PhonePe" style="height:24px; margin-bottom:8px;">
            PhonePe
          </a>
          <a href="${upiLink}" class="upi-btn" onclick="openApp()">
            <img src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9Im5vIj8+CjxzdmcKICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICB4bWxuczpjYz0iaHR0cDovL2NyZWF0aXZlY29tbW9ucy5vcmcvbnMjIgogICB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiCiAgIHhtbG5zOnN2Zz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciCiAgIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIKICAgeG1sbnM6c29kaXBvZGk9Imh0dHA6Ly9zb2RpcG9kaS5zb3VyY2Vmb3JnZS5uZXQvRFREL3NvZGlwb2RpLTAuZHRkIgogICB4bWxuczppbmtzY2FwZT0iaHR0cDovL3d3dy5pbmtzY2FwZS5vcmcvbmFtZXNwYWNlcy9pbmtzY2FwZSIKICAgc29kaXBvZGk6ZG9jbmFtZT0iUGF5dG0gbG9nby5zdmciCiAgIGlua3NjYXBlOnZlcnNpb249IjEuMCAoNDAzNWE0ZmI0OSwgMjAyMC0wNS0wMSkiCiAgIGlkPSJzdmczOTgiCiAgIHZlcnNpb249IjEuMSIKICAgdmlld0JveD0iMCAwIDE2LjgzNzk5OCA1LjI4NDk5OTgiCiAgIGhlaWdodD0iNS4yODQ5OTk4bW0iCiAgIHdpZHRoPSIxNi44Mzc5OTltbSI+CiAgPGRlZnMKICAgICBpZD0iZGVmczM5MiIgLz4KICA8c29kaXBvZGk6bmFtZWR2aWV3CiAgICAgaW5rc2NhcGU6d2luZG93LW1heGltaXplZD0iMCIKICAgICBpbmtzY2FwZTp3aW5kb3cteT0iMCIKICAgICBpbmtzY2FwZTp3aW5kb3cteD0iMTgzIgogICAgIGlua3NjYXBlOndpbmRvdy1oZWlnaHQ9IjEwMzAiCiAgICAgaW5rc2NhcGU6d2luZG93LXdpZHRoPSIxMzc1IgogICAgIHNob3dncmlkPSJmYWxzZSIKICAgICBpbmtzY2FwZTpkb2N1bWVudC1yb3RhdGlvbj0iMCIKICAgICBpbmtzY2FwZTpjdXJyZW50LWxheWVyPSJsYXllcjEiCiAgICAgaW5rc2NhcGU6ZG9jdW1lbnQtdW5pdHM9Im1tIgogICAgIGlua3NjYXBlOmN5PSI4Ljk3MjAwNzkiCiAgICAgaW5rc2NhcGU6Y3g9IjQxLjg5OTk5OSIKICAgICBpbmtzY2FwZTp6b29tPSI4IgogICAgIGlua3NjYXBlOnBhZ2VzaGFkb3c9IjIiCiAgICAgaW5rc2NhcGU6cGFnZW9wYWNpdHk9IjAuMCIKICAgICBib3JkZXJvcGFjaXR5PSIxLjAiCiAgICAgYm9yZGVyY29sb3I9IiM2NjY2NjYiCiAgICAgcGFnZWNvbG9yPSIjZmZmZmZmIgogICAgIGlkPSJiYXNlIiAvPgogIDxtZXRhZGF0YQogICAgIGlkPSJtZXRhZGF0YTM5NSI+CiAgICA8cmRmOlJERj4KICAgICAgPGNjOldvcmsKICAgICAgICAgcmRmOmFib3V0PSIiPgogICAgICAgIDxkYzpmb3JtYXQ+aW1hZ2Uvc3ZnK3htbDwvZGM6Zm9ybWF0PgogICAgICAgIDxkYzp0eXBlCiAgICAgICAgICAgcmRmOnJlc291cmNlPSJodHRwOi8vcHVybC5vcmcvZGMvZGNtaXR5cGUvU3RpbGxJbWFnZSIgLz4KICAgICAgICA8ZGM6dGl0bGU+PC9kYzp0aXRsZT4KICAgICAgPC9jYzpXb3JrPgogICAgPC9yZGY6UkRGPgogIDwvbWV0YWRhdGE+CiAgPGcKICAgICBpZD0ibGF5ZXIxIgogICAgIGlua3NjYXBlOmdyb3VwbW9kZT0ibGF5ZXIiCiAgICAgaW5rc2NhcGU6bGFiZWw9IkxheWVyIDEiPgogICAgPGcKICAgICAgIHRyYW5zZm9ybT0ibWF0cml4KDAuMzUyNzc3NzcsMCwwLC0wLjM1Mjc3Nzc3LDE2Ljc3NzA1NiwxLjU2MTAyODYpIgogICAgICAgaWQ9Imc1MiI+CiAgICAgIDxwYXRoCiAgICAgICAgIGlkPSJwYXRoNTQiCiAgICAgICAgIHN0eWxlPSJmaWxsOiM1NGMxZjA7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgIGQ9Ik0gMCwwIEMgLTAuNDMzLDEuMjM4IC0xLjYxMywyLjEyNyAtMi45OTksMi4xMjcgSCAtMy4wMjggQyAtMy45MjksMi4xMjcgLTQuNzQxLDEuNzUyIC01LjMxOSwxLjE1IC01Ljg5OCwxLjc1MiAtNi43MSwyLjEyNyAtNy42MSwyLjEyNyBoIC0wLjAyOSBjIC0wLjc5MiwwIC0xLjUxNiwtMC4yOSAtMi4wNzIsLTAuNzcgViAxLjYwMSBDIC05LjczLDEuODQ0IC05LjkzLDIuMDM1IC0xMC4xNzcsMi4wMzUgaCAtMi4xMjYgYyAtMC4yNiwwIC0wLjQ3LC0wLjIxIC0wLjQ3LC0wLjQ3MSBWIC05Ljk4MSBjIDAsLTAuMjYxIDAuMjEsLTAuNDcxIDAuNDcsLTAuNDcxIGggMi4xMjYgYyAwLjIzNywwIDAuNDMyLDAuMTc3IDAuNDYzLDAuNDA2IGwgLTEwZS00LDguMjg4IGMgMCwwLjAyOSAxMGUtNCwwLjA1NiAwLjAwNCwwLjA4MyAwLjAzNCwwLjM3IDAuMzA1LDAuNjc0IDAuNzMzLDAuNzEyIGggMC4wNzkgMC4yMjMgMC4wOSBjIDAuMTc5LC0wLjAxNiAwLjMzLC0wLjA3OSAwLjQ0OSwtMC4xNzQgMC4xODUsLTAuMTQ3IDAuMjg4LC0wLjM3MyAwLjI4OCwtMC42MjEgbCAwLjAwOCwtOC4yNDcgYyAwLC0wLjI2MSAwLjIxMSwtMC40NzIgMC40NywtMC40NzIgaCAyLjEyNiBjIDAuMjUxLDAgMC40NTUsMC4yIDAuNDY3LDAuNDQ5IGwgLTAuMDAxLDguMjgxIGMgLTAuMDAxLDAuMjcyIDAuMTI1LDAuNTE4IDAuMzQ2LDAuNjY0IDAuMTA5LDAuMDcgMC4yNCwwLjExNyAwLjM5MSwwLjEzMSBoIDAuMDc5IDAuMjIzIDAuMDkgYyAwLjQ2LC0wLjA0IDAuNzM4LC0wLjM4OSAwLjczNywtMC43OTUgbCAwLjAwOCwtOC4yMzYgYyAwLC0wLjI2MSAwLjIxMSwtMC40NzEgMC40NywtMC40NzEgaCAyLjEyNiBjIDAuMjU5LDAgMC40NywwLjIxIDAuNDcsMC40NzEgdiA4Ljg1OCBDIDAuMTYxLC0wLjUyMSAwLjA5MywtMC4yNjQgMCwwIiAvPgogICAgPC9nPgogICAgPGcKICAgICAgIHRyYW5zZm9ybT0ibWF0cml4KDAuMzUyNzc3NzcsMCwwLC0wLjM1Mjc3Nzc3LDExLjY5OTY3NiwwLjg1Mzc0ODYyKSIKICAgICAgIGlkPSJnNTYiPgogICAgICA8cGF0aAogICAgICAgICBpZD0icGF0aDU4IgogICAgICAgICBzdHlsZT0iZmlsbDojNTRjMWYwO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICBkPSJtIDAsMCBoIC0xLjIxNiB2IDEuOTcgMCBjIDAsMC4wMDIgMCwwLjAwNCAwLDAuMDA2IDAsMC4yMzcgLTAuMTkyLDAuNDI5IC0wLjQyOSwwLjQyOSBDIC0xLjY3MywyLjQwNSAtMS43LDIuNDAxIC0xLjcyNiwyLjM5NiAtMy4wNzQsMi4wMjYgLTIuODA0LDAuMTU5IC01LjI2NSwwIEggLTUuMzIgLTUuNTA0IGMgLTAuMDM2LDAgLTAuMDcsLTAuMDA1IC0wLjEwMywtMC4wMTIgaCAtMC4wMDIgbCAwLjAwMiwtMTBlLTQgQyAtNS44MTcsLTAuMDYgLTUuOTc1LC0wLjI0NiAtNS45NzUsLTAuNDcgdiAtMi4xMjYgYyAwLC0wLjI1OSAwLjIxMSwtMC40NyAwLjQ3MSwtMC40NyBoIDEuMjgzIGwgLTAuMDAyLC05LjAxNSBjIDAsLTAuMjU3IDAuMjA4LC0wLjQ2NSAwLjQ2NSwtMC40NjUgaCAyLjEwMiBjIDAuMjU2LDAgMC40NjQsMC4yMDggMC40NjQsMC40NjUgbCAxMGUtNCw5LjAxNSBIIDAgYyAwLjI1OSwwIDAuNDcsMC4yMTEgMC40NywwLjQ3IFYgLTAuNDcgQyAwLjQ3LC0wLjIxMSAwLjI1OSwwIDAsMCIgLz4KICAgIDwvZz4KICAgIDxnCiAgICAgICB0cmFuc2Zvcm09Im1hdHJpeCgwLjM1Mjc3Nzc3LDAsMCwtMC4zNTI3Nzc3Nyw5LjAwMTIzNjEsMC44NTM3NDg2MikiCiAgICAgICBpZD0iZzYwIj4KICAgICAgPHBhdGgKICAgICAgICAgaWQ9InBhdGg2MiIKICAgICAgICAgc3R5bGU9ImZpbGw6IzIzMzI2NjtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgZD0iTSAwLDAgSCAtMi4xMjYgQyAtMi4zODUsMCAtMi41OTUsLTAuMjExIC0yLjU5NSwtMC40NyBWIC00Ljg2NiBDIC0yLjYsLTUuMTM4IC0yLjgyLC01LjM1NiAtMy4wOTMsLTUuMzU2IGggLTAuODkgYyAtMC4yNzYsMCAtMC40OTksMC4yMjIgLTAuNDk5LDAuNDk4IEwgLTQuNDksLTAuNDcgQyAtNC40OSwtMC4yMTEgLTQuNzAxLDAgLTQuOTYsMCBoIC0yLjEyNiBjIC0wLjI2LDAgLTAuNDcsLTAuMjExIC0wLjQ3LC0wLjQ3IHYgLTQuODE4IGMgMCwtMS44MyAxLjMwNSwtMy4xMzUgMy4xMzYsLTMuMTM1IDAsMCAxLjM3NCwwIDEuNDE2LC0wLjAwOCAwLjI0OCwtMC4wMjggMC40NDEsLTAuMjM2IDAuNDQxLC0wLjQ5MiAwLC0wLjI1MyAtMC4xODksLTAuNDYgLTAuNDM0LC0wLjQ5MSAtMC4wMTIsLTAuMDAyIC0wLjAyMywtMC4wMDUgLTAuMDM2LC0wLjAwNyBsIC0zLjEwOSwtMC4wMTEgYyAtMC4yNiwwIC0wLjQ3LC0wLjIxMSAtMC40NywtMC40NyB2IC0yLjEyNSBjIDAsLTAuMjYgMC4yMSwtMC40NyAwLjQ3LC0wLjQ3IGggMy40NzYgYyAxLjgzMiwwIDMuMTM2LDEuMzA0IDMuMTM2LDMuMTM1IFYgLTAuNDcgQyAwLjQ3LC0wLjIxMSAwLjI2LDAgMCwwIiAvPgogICAgPC9nPgogICAgPGcKICAgICAgIHRyYW5zZm9ybT0ibWF0cml4KDAuMzUyNzc3NzcsMCwwLC0wLjM1Mjc3Nzc3LDEuNzQxNzA3MSwyLjIyNzk4ODYpIgogICAgICAgaWQ9Imc2NCI+CiAgICAgIDxwYXRoCiAgICAgICAgIGlkPSJwYXRoNjYiCiAgICAgICAgIHN0eWxlPSJmaWxsOiMyMzMyNjY7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgIGQ9Im0gMCwwIHYgLTAuOTkyIC0wLjMyIGMgMCwtMC4yNzUgLTAuMjIzLC0wLjQ5OSAtMC40OTgsLTAuNDk5IGwgLTEuMzQ5LC0wLjAwMSB2IDIuNjI5IGggMS4zNDkgQyAtMC4yMjMsMC44MTcgMCwwLjU5NSAwLDAuMzE5IFogTSAwLjE4NywzLjg5NiBIIC00LjQ2IGMgLTAuMjU1LDAgLTAuNDYxLC0wLjIwNyAtMC40NjEsLTAuNDYxIFYgMS4zNTIgYyAwLC0wLjAwNCAwLjAwMSwtMC4wMDggMC4wMDEsLTAuMDEyIDAsLTAuMDEgLTAuMDAxLC0wLjAyIC0wLjAwMSwtMC4wMjkgViAtNS4zNyAtOC4xMTcgYyAwLC0wLjI1NiAwLjE5MiwtMC40NjUgMC40MywtMC40NzEgaCAwLjA0IDIuMTI2IGMgMC4yNTksMCAwLjQ3LDAuMjEgMC40NywwLjQ3IGwgMC4wMDgsMy4yMzEgaCAyLjAzNCBjIDEuNzAyLDAgMi44ODgsMS4xODEgMi44ODgsMi44OSB2IDIuOTk5IGMgMCwxLjcwOSAtMS4xODYsMi44OTQgLTIuODg4LDIuODk0IiAvPgogICAgPC9nPgogICAgPGcKICAgICAgIHRyYW5zZm9ybT0ibWF0cml4KDAuMzUyNzc3NzcsMCwwLC0wLjM1Mjc3Nzc3LDQuODUzNTk0MSwzLjk4ODc2ODYpIgogICAgICAgaWQ9Imc2OCI+CiAgICAgIDxwYXRoCiAgICAgICAgIGlkPSJwYXRoNzAiCiAgICAgICAgIHN0eWxlPSJmaWxsOiMyMzMyNjY7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgIGQ9Ik0gMCwwIFYgLTAuMzMyIEMgMCwtMC4zNTkgLTAuMDA0LC0wLjM4NSAtMC4wMDgsLTAuNDEgLTAuMDEzLC0wLjQzNCAtMC4wMiwtMC40NTcgLTAuMDI4LC0wLjQ3OSAtMC4wOTQsLTAuNjY1IC0wLjI4LC0wLjggLTAuNTAxLC0wLjggaCAtMC44ODUgYyAtMC4yNzYsMCAtMC41MDEsMC4yMSAtMC41MDEsMC40NjggdiAwLjQwMSBjIDAsMC4wMDUgLTEwZS00LDAuMDEgLTEwZS00LDAuMDE1IGwgMTBlLTQsMS4wNjcgdiAwLjAwMiAwLjExOCAwLjIxNCBsIDAuMDAxLDAuMDAzIGMgMTBlLTQsMC4yNTcgMC4yMjQsMC40NjUgMC41LDAuNDY1IGggMC44ODUgQyAtMC4yMjQsMS45NTMgMCwxLjc0NCAwLDEuNDg1IFogbSAtMC4zMzgsOC44NzUgaCAtMi45NSBDIC0zLjU0OSw4Ljg3NSAtMy43Niw4LjY3NyAtMy43Niw4LjQzNCBWIDcuNjA3IGMgMCwtMC4wMDUgMTBlLTQsLTAuMDExIDEwZS00LC0wLjAxNiAwLC0wLjAwNiAtMTBlLTQsLTAuMDEyIC0xMGUtNCwtMC4wMTggViA2LjQ0IGMgMCwtMC4yNTcgMC4yMjQsLTAuNDY3IDAuNSwtMC40NjcgaCAyLjgwOSBjIDAuMjIyLC0wLjAzNSAwLjM5OCwtMC4xOTcgMC40MjMsLTAuNDUgViA1LjI0OSBDIC0wLjA1Myw1LjAwOCAtMC4yMjcsNC44MzIgLTAuNDM5LDQuODEyIEggLTEuODMgYyAtMS44NSwwIC0zLjE2OCwtMS4yMjkgLTMuMTY4LC0yLjk1NSB2IC0yLjQwOSAtMC4wNjMgYyAwLC0xLjcxNiAxLjEzMywtMi45MzcgMi45NywtMi45MzcgaCAzLjg1NSBjIDAuNjkyLDAgMS4yNTMsMC41MjQgMS4yNTMsMS4xNjkgdiA4LjA2NyBjIDAsMS45NTYgLTEuMDA4LDMuMTkxIC0zLjQxOCwzLjE5MSIgLz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPgo=" alt="Paytm" style="height:16px; margin-bottom:8px;">
            Paytm
          </a>
          <a href="${upiLink}" class="upi-btn" onclick="openApp()">
            <img src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9Im5vIj8+CjxzdmcKICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICB4bWxuczpjYz0iaHR0cDovL2NyZWF0aXZlY29tbW9ucy5vcmcvbnMjIgogICB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiCiAgIHhtbG5zOnN2Zz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciCiAgIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIKICAgeG1sbnM6c29kaXBvZGk9Imh0dHA6Ly9zb2RpcG9kaS5zb3VyY2Vmb3JnZS5uZXQvRFREL3NvZGlwb2RpLTAuZHRkIgogICB4bWxuczppbmtzY2FwZT0iaHR0cDovL3d3dy5pbmtzY2FwZS5vcmcvbmFtZXNwYWNlcy9pbmtzY2FwZSIKICAgc29kaXBvZGk6ZG9jbmFtZT0iVVBJIExvZ28uc3ZnIgogICBpbmtzY2FwZTp2ZXJzaW9uPSIxLjAgKDQwMzVhNGZiNDksIDIwMjAtMDUtMDEpIgogICBpZD0ic3ZnMzQ3IgogICB2ZXJzaW9uPSIxLjEiCiAgIHZpZXdCb3g9IjAgMCAxMzAuNTQgNDYuMTE4IgogICBoZWlnaHQ9IjQ2LjExOG1tIgogICB3aWR0aD0iMTMwLjUzOTk5bW0iPgogIDxkZWZzCiAgICAgaWQ9ImRlZnMzNDEiPgogICAgPGNsaXBQYXRoCiAgICAgICBpZD0iY2xpcFBhdGgyOCIKICAgICAgIGNsaXBQYXRoVW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHBhdGgKICAgICAgICAgaWQ9InBhdGgyNiIKICAgICAgICAgZD0iTSAwLDIxNiBIIDQzMiBWIDAgSCAwIFoiIC8+CiAgICA8L2NsaXBQYXRoPgogIDwvZGVmcz4KICA8c29kaXBvZGk6bmFtZWR2aWV3CiAgICAgaW5rc2NhcGU6d2luZG93LW1heGltaXplZD0iMCIKICAgICBpbmtzY2FwZTp3aW5kb3cteT0iMCIKICAgICBpbmtzY2FwZTp3aW5kb3cteD0iMTIyIgogICAgIGlua3NjYXBlOndpbmRvdy1oZWlnaHQ9IjEwMzAiCiAgICAgaW5rc2NhcGU6d2luZG93LXdpZHRoPSIxMzc1IgogICAgIHNob3dncmlkPSJmYWxzZSIKICAgICBpbmtzY2FwZTpkb2N1bWVudC1yb3RhdGlvbj0iMCIKICAgICBpbmtzY2FwZTpjdXJyZW50LWxheWVyPSJsYXllcjEiCiAgICAgaW5rc2NhcGU6ZG9jdW1lbnQtdW5pdHM9Im1tIgogICAgIGlua3NjYXBlOmN5PSI3MDQuNDMxNDgiCiAgICAgaW5rc2NhcGU6Y3g9Ii0yMDUuNzQ3MjYiCiAgICAgaW5rc2NhcGU6em9vbT0iMC41IgogICAgIGlua3NjYXBlOnBhZ2VzaGFkb3c9IjIiCiAgICAgaW5rc2NhcGU6cGFnZW9wYWNpdHk9IjAuMCIKICAgICBib3JkZXJvcGFjaXR5PSIxLjAiCiAgICAgYm9yZGVyY29sb3I9IiM2NjY2NjYiCiAgICAgcGFnZWNvbG9yPSIjZmZmZmZmIgogICAgIGlkPSJiYXNlIiAvPgogIDxtZXRhZGF0YQogICAgIGlkPSJtZXRhZGF0YTM0NCI+CiAgICA8cmRmOlJERj4KICAgICAgPGNjOldvcmsKICAgICAgICAgcmRmOmFib3V0PSIiPgogICAgICAgIDxkYzpmb3JtYXQ+aW1hZ2Uvc3ZnK3htbDwvZGM6Zm9ybWF0PgogICAgICAgIDxkYzp0eXBlCiAgICAgICAgICAgcmRmOnJlc291cmNlPSJodHRwOi8vcHVybC5vcmcvZGMvZGNtaXR5cGUvU3RpbGxJbWFnZSIgLz4KICAgICAgICA8ZGM6dGl0bGU+PC9kYzp0aXRsZT4KICAgICAgPC9jYzpXb3JrPgogICAgPC9yZGY6UkRGPgogIDwvbWV0YWRhdGE+CiAgPGcKICAgICBpZD0ibGF5ZXIxIgogICAgIGlua3NjYXBlOmdyb3VwbW9kZT0ibGF5ZXIiCiAgICAgaW5rc2NhcGU6bGFiZWw9IkxheWVyIDEiPgogICAgPGcKICAgICAgIGlkPSJnMjIiCiAgICAgICB0cmFuc2Zvcm09Im1hdHJpeCgwLjM1Mjc3Nzc3LDAsMCwtMC4zNTI3Nzc3NywtMTAuOTI2MzIxLDYxLjE1ODYzMykiPgogICAgICA8ZwogICAgICAgICBpZD0iZzI0IgogICAgICAgICBjbGlwLXBhdGg9InVybCgjY2xpcFBhdGgyOCkiPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9ImczMCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzMy45NzY2LDYxLjA2NzQpIj4KICAgICAgICAgIDxwYXRoCiAgICAgICAgICAgICBkPSJNIDAsMCBIIDIuNzcgTCAwLjE5NiwtMTAuNzUxIGMgLTAuMzgyLC0xLjU5NSAtMC4zMSwtMi43OTYgMC4yMTgsLTMuNTk3IDAuNTI2LC0wLjgwMiAxLjUwNSwtMS4yMDMgMi45MzYsLTEuMjAzIDEuNDIyLDAgMi41ODgsMC40MDEgMy40OTksMS4yMDMgMC45MTIsMC44MDEgMS41NTksMi4wMDIgMS45NDEsMy41OTcgTCAxMS4zNjMsMCBoIDIuODA2IGwgLTIuNjM3LC0xMS4wMTcgYyAtMC41NzMsLTIuMzk0IC0xLjU5NCwtNC4xODYgLTMuMDU2LC01LjM3NCAtMS40NjMsLTEuMTkgLTMuMzgxLC0xLjc4NCAtNS43NTQsLTEuNzg0IC0yLjM3NSwwIC00LjAwNCwwLjU5MyAtNC44OTEsMS43NzggLTAuODg4LDEuMTg0IC0xLjA0MywyLjk3OCAtMC40NjgsNS4zOCB6IgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoMzIiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9ImczNCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSg0Ny43NzM0LDQzLjM2MzMpIj4KICAgICAgICAgIDxwYXRoCiAgICAgICAgICAgICBkPSJNIDAsMCA0LjQwNiwxOC40MDUgMTIuNzc4LDcuNTgyIEMgMTMuMDAyLDcuMjc3IDEzLjIyOCw2Ljk1IDEzLjQ1MSw2LjYwMyAxMy42NzQsNi4yNTYgMTMuOTAyLDUuODY2IDE0LjEzNiw1LjQzIGwgMi45MzksMTIuMjc0IGggMi41OTMgTCAxNS4yNjUsLTAuNjg3IDYuNzE3LDEwLjMyOSBDIDYuNDg4LDEwLjYyNiA2LjI3NSwxMC45NCA2LjA3NiwxMS4yNzEgNS44NzUsMTEuNjAyIDUuNjk0LDExLjk0OSA1LjUyOCwxMi4zMTEgTCAyLjU4MSwwIFoiCiAgICAgICAgICAgICBzdHlsZT0iZmlsbDojNjk2YTZhO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICAgICAgaWQ9InBhdGgzNiIgLz4KICAgICAgICA8L2c+CiAgICAgICAgPGcKICAgICAgICAgICBpZD0iZzM4IgogICAgICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDY3LjIxMTksNDMuMzYzMykiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Ik0gMCwwIDQuMjM4LDE3LjcwNCBIIDcuMDQyIEwgMi44MDUsMCBaIgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoNDAiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9Imc0MiIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3NC4wNDg4LDQzLjM2MzMpIj4KICAgICAgICAgIDxwYXRoCiAgICAgICAgICAgICBkPSJtIDAsMCA0LjIzOCwxNy43MDQgaCA5LjYzIEwgMTMuMjgzLDE1LjI2MiBIIDYuNDU4IEwgNS40MDEsMTAuODQ4IGggNi44MjUgTCAxMS42MjIsOC4zMjEgSCA0Ljc5NiBMIDIuODA1LDAgWiIKICAgICAgICAgICAgIHN0eWxlPSJmaWxsOiM2OTZhNmE7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgICAgICBpZD0icGF0aDQ0IiAvPgogICAgICAgIDwvZz4KICAgICAgICA8ZwogICAgICAgICAgIGlkPSJnNDYiCiAgICAgICAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoODYuNzY4Niw0My4zNjMzKSI+CiAgICAgICAgICA8cGF0aAogICAgICAgICAgICAgZD0iTSAwLDAgNC4yMzgsMTcuNzA0IEggNy4wNDIgTCAyLjgwNSwwIFoiCiAgICAgICAgICAgICBzdHlsZT0iZmlsbDojNjk2YTZhO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICAgICAgaWQ9InBhdGg0OCIgLz4KICAgICAgICA8L2c+CiAgICAgICAgPGcKICAgICAgICAgICBpZD0iZzUwIgogICAgICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDkzLjYwNTUsNDMuMzYzMykiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Im0gMCwwIDQuMjM4LDE3LjcwNCBoIDkuNjMgTCAxMy4yODMsMTUuMjYyIEggNi40NTggTCA1LjM5NSwxMC44MjQgSCAxMi4yMiBMIDExLjYxNiw4LjI5NiBIIDQuNzkxIGwgLTEuMzcsLTUuNzIgaCA2LjgyNSBMIDkuNjMsMCBaIgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoNTIiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9Imc1NCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMDkuODgxOCw0NS45NjM5KSI+CiAgICAgICAgICA8cGF0aAogICAgICAgICAgICAgZD0ibSAwLDAgaCAyLjM1OCBjIDEuMjk2LDAgMi4yOSwwLjA4OSAyLjk4MSwwLjI2NiAwLjY5MSwwLjE3NyAxLjMyNSwwLjQ3NiAxLjkwNiwwLjg5NSAwLjc4OSwwLjU3MSAxLjQ0OCwxLjI4MyAxLjk3OCwyLjEzNCAwLjUyOSwwLjg1IDAuOTMsMS44NDEgMS4yLDIuOTcgMC4yNjksMS4xMjkgMC4zNDMsMi4xMTcgMC4yMjEsMi45NjYgLTAuMTIzLDAuODUyIC0wLjQ0MSwxLjU2MyAtMC45NTYsMi4xMzYgLTAuMzg3LDAuNDE4IC0wLjg5OCwwLjcxOCAtMS41MzYsMC44OTYgLTAuNjM5LDAuMTc2IC0xLjY3OSwwLjI2NSAtMy4xMjUsMC4yNjUgSCA0LjAxMyAyLjk5OSBaIG0gLTMuNDI3LC0yLjYwMSA0LjIzOCwxNy43MDUgaCAzLjc4MyBjIDIuNDYsMCA0LjE2LC0wLjEyNiA1LjEwMiwtMC4zOCAwLjk0LC0wLjI1NSAxLjcxNywtMC42ODEgMi4zMjgsLTEuMjc3IDAuODExLC0wLjc4MiAxLjMyNywtMS43ODYgMS41NDksLTMuMDEgQyAxMy43OTQsOS4yMTEgMTMuNzE2LDcuODEyIDEzLjM0LDYuMjQgMTIuOTY0LDQuNjY4IDEyLjM3MywzLjI3NSAxMS41NjcsMi4wNjIgMTAuNzYzLDAuODQ4IDkuNzY2LC0wLjE1MyA4LjU4LC0wLjk0MyA3LjY4MywtMS41NCA2LjcyMSwtMS45NjUgNS42OTksLTIuMjIgNC42NzQsLTIuNDczIDMuMTQ2LC0yLjYwMSAxLjExLC0yLjYwMSBIIDAuMzU1IFoiCiAgICAgICAgICAgICBzdHlsZT0iZmlsbDojNjk2YTZhO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICAgICAgaWQ9InBhdGg1NiIgLz4KICAgICAgICA8L2c+CiAgICAgICAgPGcKICAgICAgICAgICBpZD0iZzU4IgogICAgICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDEzNi44Nzk5LDUzLjY2NikiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Ik0gMCwwIEggMC43MiBDIDIuMjc1LDAgMy4zNTQsMC4xNzUgMy45NTYsMC41MjEgNC41NTksMC44NjcgNC45NjQsMS40OCA1LjE3NCwyLjM1OSA1LjQsMy4zMDIgNS4yODMsMy45NjggNC44MjEsNC4zNTQgNC4zNTksNC43NDEgMy4zODcsNC45MzYgMS45MDIsNC45MzYgaCAtMC43MiB6IG0gLTAuNzQxLC0yLjM1NiAtMS45MDIsLTcuOTQ3IEggLTUuMjcxIEwgLTEuMDMyLDcuNDAxIEggMy4yMTEgQyA0LjQ2OCw3LjQwMSA1LjM3Nyw3LjMzMSA1LjkzNyw3LjE5IDYuNDk1LDcuMDUgNi45NTYsNi44MTcgNy4zMiw2LjQ5NCA3Ljc2Myw2LjA4MyA4LjA1NCw1LjUyOSA4LjE5NCw0LjgzMiA4LjMzMyw0LjEzNCA4LjMwMywzLjM2NiA4LjEwMywyLjUyOSA3LjkwMSwxLjY5IDcuNTYzLDAuOTE2IDcuMDg3LDAuMjA2IDYuNjExLC0wLjUwMyA2LjA1MywtMS4wNiA1LjQxNSwtMS40NjIgNC44OTcsLTEuNzg1IDQuMzI2LC0yLjAxNSAzLjcsLTIuMTUxIDMuMDczLC0yLjI4OSAyLjEzMiwtMi4zNTYgMC44NzUsLTIuMzU2IEggMC4zMjIgWiIKICAgICAgICAgICAgIHN0eWxlPSJmaWxsOiM2OTZhNmE7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgICAgICBpZD0icGF0aDYwIiAvPgogICAgICAgIDwvZz4KICAgICAgICA8ZwogICAgICAgICAgIGlkPSJnNjIiCiAgICAgICAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTQ4LjQ0NTgsNTAuMzE2NCkiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Ik0gMCwwIEggNC44MDkgTCA0LjAwNiw0LjA0IEMgMy45NjgsNC4yOTcgMy45MzIsNC41OTMgMy45MDEsNC45MjggMy44NzIsNS4yNjMgMy44NTIsNS42MzYgMy44MzksNi4wNDcgMy42NTMsNS42NiAzLjQ2Niw1LjI5OSAzLjI3OSw0Ljk2NCAzLjA5Myw0LjYzIDIuOTEyLDQuMzIyIDIuNzM0LDQuMDQgWiBNIDYuMDkyLC02Ljk1MyA1LjIyNSwtMi4zOTQgSCAtMS42MTIgTCAtNC43MDcsLTYuOTUzIEggLTcuNjUyIEwgNS4xMDksMTEuNDUyIDkuMDUsLTYuOTUzIFoiCiAgICAgICAgICAgICBzdHlsZT0iZmlsbDojNjk2YTZhO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICAgICAgaWQ9InBhdGg2NCIgLz4KICAgICAgICA8L2c+CiAgICAgICAgPGcKICAgICAgICAgICBpZD0iZzY2IgogICAgICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE2MS41MTYxLDQzLjM2MzMpIj4KICAgICAgICAgIDxwYXRoCiAgICAgICAgICAgICBkPSJtIDAsMCAxLjkzOCw4LjEwMyAtMy41MTIsOS42MDEgaCAyLjk0NyBsIDIuMTgsLTYuMDEgYyAwLjA1LC0wLjE1NCAwLjExLC0wLjM1NSAwLjE3OSwtMC42MDUgMC4wNywtMC4yNSAwLjEzOCwtMC41MTkgMC4yMDIsLTAuODEgMC4xNzYsMC4yODIgMC4zNTcsMC41NSAwLjUzOCwwLjc5OSAwLjE4MSwwLjI1IDAuMzY0LDAuNDc5IDAuNTQ5LDAuNjg5IGwgNS4xMzMsNS45MzcgSCAxMi45NiBMIDQuNzIsOC4xMDMgMi43ODEsMCBaIgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoNjgiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9Imc3MCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxODguMjgwMyw1Mi4xMDc0KSI+CiAgICAgICAgICA8cGF0aAogICAgICAgICAgICAgZD0iTSAwLDAgQyAwLjAwMSwwLjEzNyAwLjA0MSwwLjUxNSAwLjExOSwxLjEzNiAwLjE3OSwxLjY1MiAwLjIyNiwyLjA4IDAuMjYsMi40MTkgMC4wOTMsMi4wMTUgLTAuMTA0LDEuNjExIC0wLjMzLDEuMjA5IC0wLjU1NywwLjgwNiAtMC44MTcsMC4zOTUgLTEuMTE0LC0wLjAyNSBsIC02Ljc3MywtOS40MzMgLTIuMjEsOS42MjYgYyAtMC4wOTQsMC4zOTYgLTAuMTY2LDAuNzc5IC0wLjIxNCwxLjE0OSAtMC4wNDgsMC4zNzEgLTAuMDgxLDAuNzM4IC0wLjA5NywxLjEwMiAtMC4wOTYsLTAuMzcyIC0wLjIxOCwtMC43NiAtMC4zNjcsLTEuMTY4IC0wLjE0OSwtMC40MDcgLTAuMzI3LC0wLjgzMyAtMC41MzYsLTEuMjc2IGwgLTMuOTM4LC04LjcxOSBoIC0yLjU4IGwgOC40OTUsMTguNDU1IDIuNDE4LC0xMS4xNzUgYyAwLjAzNSwtMC4xNzcgMC4wODYsLTAuNDcyIDAuMTQ4LC0wLjg4MyAwLjA2MiwtMC40MTEgMC4xMzUsLTAuOTE5IDAuMjIsLTEuNTIzIDAuMjg2LDAuNTA4IDAuNjk4LDEuMTUyIDEuMjQsMS45MzQgMC4xNDQsMC4yMSAwLjI1NCwwLjM3MSAwLjMyOCwwLjQ4NCBMIDIuNjY3LDkuNzExIDIuNDIyLC04Ljc0NCBoIC0yLjYwNiB6IgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoNzIiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9Imc3NCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxOTIuOTQxOSw0My4zNjMzKSI+CiAgICAgICAgICA8cGF0aAogICAgICAgICAgICAgZD0ibSAwLDAgNC4yMzksMTcuNzA0IGggOS42MyBMIDEzLjI4NCwxNS4yNjIgSCA2LjQ1OCBMIDUuMzk2LDEwLjgyNCBoIDYuODI1IEwgMTEuNjE3LDguMjk2IEggNC43OTEgTCAzLjQyMiwyLjU3NiBoIDYuODI1IEwgOS42MjksMCBaIgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoNzYiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9Imc3OCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgyMDUuNzkxLDQzLjM2MzMpIj4KICAgICAgICAgIDxwYXRoCiAgICAgICAgICAgICBkPSJNIDAsMCA0LjQwNiwxOC40MDUgMTIuNzc4LDcuNTgyIEMgMTMuMDAyLDcuMjc3IDEzLjIyOCw2Ljk1IDEzLjQ1MSw2LjYwMyAxMy42NzQsNi4yNTYgMTMuOTAyLDUuODY2IDE0LjEzNiw1LjQzIGwgMi45MzksMTIuMjc0IGggMi41OTQgTCAxNS4yNjUsLTAuNjg3IDYuNzE3LDEwLjMyOSBDIDYuNDg4LDEwLjYyNiA2LjI3NSwxMC45NCA2LjA3NiwxMS4yNzEgNS44NzUsMTEuNjAyIDUuNjk0LDExLjk0OSA1LjUyOCwxMi4zMTEgTCAyLjU4MSwwIFoiCiAgICAgICAgICAgICBzdHlsZT0iZmlsbDojNjk2YTZhO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICAgICAgaWQ9InBhdGg4MCIgLz4KICAgICAgICA8L2c+CiAgICAgICAgPGcKICAgICAgICAgICBpZD0iZzgyIgogICAgICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDIzNC40MTAyLDU4LjYyNSkiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Ik0gMCwwIC0zLjY1MywtMTUuMjYyIEggLTYuNDU4IEwgLTIuODA2LDAgaCAtNC41ODUgbCAwLjU4NSwyLjQ0MiBIIDUuMTQ2IEwgNC41NjIsMCBaIgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoODQiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9Imc4NiIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgyMzcuMzIxMyw0Ni45MDcyKSI+CiAgICAgICAgICA8cGF0aAogICAgICAgICAgICAgZD0iTSAwLDAgMi40OTQsMS4wNjMgQyAyLjUxOSwwLjI3NCAyLjc2MywtMC4zMjkgMy4yMjksLTAuNzQ0IDMuNjk1LC0xLjE2IDQuMzY4LC0xLjM2NyA1LjI1LC0xLjM2NyBjIDAuODMyLDAgMS41NTIsMC4yMzggMi4xNTYsMC43MTQgMC42MDUsMC40NzUgMS4wMDQsMS4xMTIgMS4xOTUsMS45MSBDIDguODUsMi4yOTggOC4yMjksMy4yMjUgNi43NDQsNC4wMzggNi41MzYsNC4xNTkgNi4zNzYsNC4yNDggNi4yNjYsNC4zMDUgNC41OTEsNS4yNTYgMy41MjksNi4xMTcgMy4wODEsNi44ODcgMi42MzQsNy42NTcgMi41NDIsOC41OTggMi44MDgsOS43MSBjIDAuMzQ1LDEuNDQzIDEuMTAzLDIuNjEyIDIuMjcyLDMuNTA3IDEuMTY5LDAuODk1IDIuNTI3LDEuMzQzIDQuMDc2LDEuMzQzIDEuMjczLDAgMi4yNzgsLTAuMjUyIDMuMDEzLC0wLjc1NiAwLjczNiwtMC41MDUgMS4xNTYsLTEuMjI4IDEuMjYsLTIuMTcxIEwgMTAuOTYsMTAuNDcyIGMgLTAuMjE0LDAuNTU2IC0wLjQ5NiwwLjk2MyAtMC44NDYsMS4yMjIgLTAuMzUxLDAuMjU4IC0wLjc5NSwwLjM4NyAtMS4zMjgsMC4zODcgLTAuNzU0LDAgLTEuNDAyLC0wLjIwMyAtMS45NDMsLTAuNjA0IEMgNi4zMDUsMTEuMDczIDUuOTUyLDEwLjUzMyA1Ljc4OSw5Ljg1NSA1LjUzNSw4Ljc5MSA2LjI3Miw3LjggOC4wMDEsNi44ODEgOC4xMzQsNi44MDkgOC4yMzgsNi43NTEgOC4zMTMsNi43MTEgOS44MjYsNS45MDYgMTAuODEsNS4xMTcgMTEuMjYxLDQuMzQ3IDExLjcxMywzLjU3NiAxMS44MDIsMi42MTUgMTEuNTI1LDEuNDYzIDExLjEyNCwtMC4yMTUgMTAuMjkxLC0xLjU0NyA5LjAyNSwtMi41MzQgNy43NTksLTMuNTIxIDYuMjQ5LC00LjAxNSA0LjQ5OCwtNC4wMTUgYyAtMS40NzEsMCAtMi41OTIsMC4zNDYgLTMuMzY0LDEuMDQgQyAwLjM2LC0yLjI4MiAtMC4wMTgsLTEuMjkxIDAsMCIKICAgICAgICAgICAgIHN0eWxlPSJmaWxsOiM2OTZhNmE7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgICAgICBpZD0icGF0aDg4IiAvPgogICAgICAgIDwvZz4KICAgICAgICA8ZwogICAgICAgICAgIGlkPSJnOTAiCiAgICAgICAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMjU4LjA0NTksNDMuMzYzMykiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Ik0gMCwwIDQuMjM4LDE3LjcwNCBIIDcuMDQzIEwgMi44MDUsMCBaIgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoOTIiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9Imc5NCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgyNjQuODgyOCw0My4zNjMzKSI+CiAgICAgICAgICA8cGF0aAogICAgICAgICAgICAgZD0iTSAwLDAgNC40MDYsMTguNDA1IDEyLjc3OCw3LjU4MiBDIDEzLjAwMiw3LjI3NyAxMy4yMjgsNi45NSAxMy40NTEsNi42MDMgMTMuNjc0LDYuMjU2IDEzLjkwMiw1Ljg2NiAxNC4xMzYsNS40MyBsIDIuOTM5LDEyLjI3NCBoIDIuNTkzIEwgMTUuMjY1LC0wLjY4NyA2LjcxNywxMC4zMjkgYyAtMC4yMjksMC4yOTcgLTAuNDQzLDAuNjExIC0wLjY0MiwwLjk0MiAtMC4yLDAuMzMxIC0wLjM4MiwwLjY3OCAtMC41NDgsMS4wNCBMIDIuNTgxLDAgWiIKICAgICAgICAgICAgIHN0eWxlPSJmaWxsOiM2OTZhNmE7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgICAgICBpZD0icGF0aDk2IiAvPgogICAgICAgIDwvZz4KICAgICAgICA8ZwogICAgICAgICAgIGlkPSJnOTgiCiAgICAgICAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMjkzLjUwMiw1OC42MjUpIj4KICAgICAgICAgIDxwYXRoCiAgICAgICAgICAgICBkPSJNIDAsMCAtMy42NTQsLTE1LjI2MiBIIC02LjQ1OCBMIC0yLjgwNiwwIGggLTQuNTg1IGwgMC41ODUsMi40NDIgSCA1LjE0NiBMIDQuNTYyLDAgWiIKICAgICAgICAgICAgIHN0eWxlPSJmaWxsOiM2OTZhNmE7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgICAgICBpZD0icGF0aDEwMCIgLz4KICAgICAgICA8L2c+CiAgICAgICAgPGcKICAgICAgICAgICBpZD0iZzEwMiIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgyOTYuNTU1Nyw0My4zNjMzKSI+CiAgICAgICAgICA8cGF0aAogICAgICAgICAgICAgZD0ibSAwLDAgNC4yMzgsMTcuNzA0IGggOS42MyBMIDEzLjI4NCwxNS4yNjIgSCA2LjQ1OSBMIDUuMzk2LDEwLjgyNCBoIDYuODI1IEwgMTEuNjE2LDguMjk2IEggNC43OTEgTCAzLjQyMiwyLjU3NiBoIDYuODI1IEwgOS42MywwIFoiCiAgICAgICAgICAgICBzdHlsZT0iZmlsbDojNjk2YTZhO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICAgICAgaWQ9InBhdGgxMDQiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9ImcxMDYiCiAgICAgICAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzE0LjY0MTYsNTMuNTIyNSkiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Ik0gMCwwIEggMC41MDggQyAxLjk5MiwwIDMuMDIxLDAuMTc2IDMuNTkzLDAuNTMxIDQuMTY1LDAuODg2IDQuNTYxLDEuNTE0IDQuNzc1LDIuNDE4IDUuMDA5LDMuMzkzIDQuOTEzLDQuMDgxIDQuNDg0LDQuNDc5IDQuMDU5LDQuODggMy4xMzgsNS4wNzkgMS43MjQsNS4wNzkgSCAxLjIxNiBaIG0gLTAuNzEyLC0yLjIzNyAtMS44OTcsLTcuOTIyIGggLTIuNjI4IGwgNC4yMzksMTcuNzA0IGggMy45MTMgYyAxLjE0NywwIDIuMDE5LC0wLjA3NiAyLjYxNCwtMC4yMyBDIDYuMTI1LDcuMTYyIDYuNjA1LDYuOTA5IDYuOTY4LDYuNTUzIDcuNCw2LjEyNyA3LjY4LDUuNTczIDcuODEsNC44OTYgNy45MzcsNC4yMiA3LjkwNCwzLjQ3OCA3LjcxMiwyLjY3MyA3LjM3MywxLjI1NCA2Ljc3MywwLjE0MyA1LjkxMywtMC42NiA1LjA1MywtMS40NjEgMy45NTEsLTEuOTQ0IDIuNjA4LC0yLjEwNCBsIDQuMDE0LC04LjA1NSBIIDMuNDUgbCAtMy44NDQsNy45MjIgeiIKICAgICAgICAgICAgIHN0eWxlPSJmaWxsOiM2OTZhNmE7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgICAgICBpZD0icGF0aDEwOCIgLz4KICAgICAgICA8L2c+CiAgICAgICAgPGcKICAgICAgICAgICBpZD0iZzExMCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzMjIuOTI1OCw0My4zNjMzKSI+CiAgICAgICAgICA8cGF0aAogICAgICAgICAgICAgZD0ibSAwLDAgNC4yMzgsMTcuNzA0IGggOS42MyBMIDEzLjI4NCwxNS4yNjIgSCA2LjQ1OCBMIDUuNDAxLDEwLjg0OCBoIDYuODI2IEwgMTEuNjIyLDguMzIxIEggNC43OTcgTCAyLjgwNSwwIFoiCiAgICAgICAgICAgICBzdHlsZT0iZmlsbDojNjk2YTZhO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICAgICAgaWQ9InBhdGgxMTIiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9ImcxMTQiCiAgICAgICAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzQwLjA0NDksNTAuMzE2NCkiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Ik0gMCwwIEggNC44MSBMIDQuMDA3LDQuMDQgQyAzLjk2OCw0LjI5NyAzLjkzMyw0LjU5MyAzLjkwMiw0LjkyOCAzLjg3Myw1LjI2MyAzLjg1Myw1LjYzNiAzLjg0LDYuMDQ3IDMuNjUzLDUuNjYgMy40NjYsNS4yOTkgMy4yOCw0Ljk2NCAzLjA5NCw0LjYzIDIuOTEyLDQuMzIyIDIuNzM0LDQuMDQgWiBNIDYuMDkzLC02Ljk1MyA1LjIyNiwtMi4zOTQgSCAtMS42MTEgTCAtNC43MDYsLTYuOTUzIEggLTcuNjUyIEwgNS4xMDksMTEuNDUyIDkuMDUxLC02Ljk1MyBaIgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoMTE2IiAvPgogICAgICAgIDwvZz4KICAgICAgICA8ZwogICAgICAgICAgIGlkPSJnMTE4IgogICAgICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2Ny4zNTU1LDU2Ljc2MjcpIj4KICAgICAgICAgIDxwYXRoCiAgICAgICAgICAgICBkPSJtIDAsMCBjIC0wLjYyNywwLjY5MyAtMS4zNDEsMS4yMTMgLTIuMTQzLDEuNTYgLTAuOCwwLjM0NSAtMS42ODgsMC41MiAtMi42NjMsMC41MiAtMS44ODUsMCAtMy41NjksLTAuNjIxIC01LjA0OCwtMS44NjIgLTEuNDgxLC0xLjI0MiAtMi40NTcsLTIuODUgLTIuOTMsLTQuODI2IC0wLjQ1NywtMS45MTEgLTAuMjU4LC0zLjQ4NiAwLjU5NiwtNC43MjcgMC44NTQsLTEuMjQyIDIuMTU4LC0xLjg2NCAzLjkwOSwtMS44NjQgMS4wMjMsMCAyLjAzOSwwLjE4NiAzLjA1MSwwLjU1NyAxLjAxMiwwLjM3MSAyLjAzMywwLjkzMSAzLjA2LDEuNjgyIGwgLTAuNzc5LC0zLjI1NCBjIC0wLjg4NywtMC41NTYgLTEuODA4LC0wLjk3MiAtMi43NjEsLTEuMjQ1IC0wLjk1NCwtMC4yNzQgLTEuOTQ5LC0wLjQxMSAtMi45ODYsLTAuNDExIC0xLjMyLDAgLTIuNDg4LDAuMjIxIC0zLjUwMSwwLjY2NSAtMS4wMTQsMC40NDMgLTEuODQzLDEuMDk1IC0yLjQ4NCwxLjk1OSAtMC42MzgsMC44NDYgLTEuMDQ3LDEuODQzIC0xLjIyMiwyLjk5MyAtMC4xNzgsMS4xNDggLTAuMTExLDIuMzcyIDAuMTk5LDMuNjcxIDAuMzExLDEuMjk3IDAuODMsMi41MTYgMS41NTUsMy42NTcgMC43MjQsMS4xNDEgMS42MTksMi4xNDMgMi42ODEsMy4wMDUgMS4wNjYsMC44NzEgMi4yMDYsMS41MjkgMy40MiwxLjk3OCAxLjIxNSwwLjQ0NiAyLjQ2OCwwLjY3MSAzLjc1NywwLjY3MSAxLjAxNCwwIDEuOTQ0LC0wLjE1MiAyLjc5MSwtMC40NTUgQyAtMC42NTEsMy45NzMgMC4xMzEsMy41MTYgMC44NSwyLjkwMSBaIgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoMTIwIiAvPgogICAgICAgIDwvZz4KICAgICAgICA8ZwogICAgICAgICAgIGlkPSJnMTIyIgogICAgICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2Ny42MjcsNDMuMzYzMykiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Im0gMCwwIDQuMjM4LDE3LjcwNCBoIDkuNjMgTCAxMy4yODMsMTUuMjYyIEggNi40NTkgTCA1LjM5NiwxMC44MjQgaCA2LjgyNSBMIDExLjYxNiw4LjI5NiBIIDQuNzkxIEwgMy40MjIsMi41NzYgaCA2LjgyNSBMIDkuNjMsMCBaIgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6IzY5NmE2YTtmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoMTI0IiAvPgogICAgICAgIDwvZz4KICAgICAgICA8ZwogICAgICAgICAgIGlkPSJnMTI2IgogICAgICAgICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKDMxNi40NjI5LDc2LjQ5NTEpIj4KICAgICAgICAgIDxwYXRoCiAgICAgICAgICAgICBkPSJNIDAsMCBIIC0xOS4yODMgTCA3LjUzNSw5Ni44NTUgaCAxOS4yODQgeiIKICAgICAgICAgICAgIHN0eWxlPSJmaWxsOiM2NjY4NmM7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgICAgICBpZD0icGF0aDEyOCIgLz4KICAgICAgICA8L2c+CiAgICAgICAgPGcKICAgICAgICAgICBpZD0iZzEzMCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzMDYuNDUyMSwxNzAuMjg4MSkiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Im0gMCwwIGMgLTEuMzM3LDEuODQzIC0zLjM5OSwyLjc3MyAtNi4yLDIuNzczIGggLTEwNi4wMzYgbCAtNS4yNTIsLTE4Ljk3IGggMTkuMjk0IHYgMC4wMTEgaCA3Ny4xNjkgbCAtNS42MTQsLTIwLjI3MiBoIC03Ny4xNzEgbCAwLjAwNywwLjA0MiBoIC0xOS4yODYgbCAtMTYuMDA3LC01Ny43ODcgaCAxOS4yOTYgbCAxMC43NDIsMzguNzg2IGggODYuNzQ2IGMgMi43MDksMCA1LjI1OSwwLjkyNCA3LjY1NywyLjc3MiAyLjM5MywxLjg1IDMuOTY4LDQuMTMxIDQuNzIzLDYuODU1IEwgMC44MDksLTYuOTk2IEMgMS41OTMsLTQuMTgxIDEuMzIyLC0xLjg0NSAwLDAiCiAgICAgICAgICAgICBzdHlsZT0iZmlsbDojNjY2ODZjO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICAgICAgaWQ9InBhdGgxMzIiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9ImcxMzQiCiAgICAgICAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTU2LjExOTYsODIuNTQxKSI+CiAgICAgICAgICA8cGF0aAogICAgICAgICAgICAgZD0ibSAwLDAgYyAtMS4wNjUsLTMuODM1IC00LjU1NywtNi40ODggLTguNTM4LC02LjQ4OCBoIC05OS40OTEgYyAtMi43MTEsMCAtNC43MjYsMC45MjQgLTYuMDUxLDIuNzcgLTEuMzI0LDEuODQ4IC0xLjYwOCw0LjEzNCAtMC44NTEsNi44NTcgbCAyNC4yNzYsODcuMzg3IGggMTkuMzAxIGwgLTIxLjY4MywtNzguMDUgaCA3Ny4yMDYgbCAyMS42ODMsNzguMDUgaCAxOS4yOTcgeiIKICAgICAgICAgICAgIHN0eWxlPSJmaWxsOiM2NjY4NmM7ZmlsbC1vcGFjaXR5OjE7ZmlsbC1ydWxlOm5vbnplcm87c3Ryb2tlOm5vbmUiCiAgICAgICAgICAgICBpZD0icGF0aDEzNiIgLz4KICAgICAgICA8L2c+CiAgICAgICAgPGcKICAgICAgICAgICBpZD0iZzEzOCIKICAgICAgICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzNzYuNTg1OSwxNzMuMTY4OSkiPgogICAgICAgICAgPHBhdGgKICAgICAgICAgICAgIGQ9Im0gMCwwIDI0LjQxNCwtNDguNTUzIC01MS4zMjIsLTQ4LjU0IHoiCiAgICAgICAgICAgICBzdHlsZT0iZmlsbDojMjc4MDNiO2ZpbGwtb3BhY2l0eToxO2ZpbGwtcnVsZTpub256ZXJvO3N0cm9rZTpub25lIgogICAgICAgICAgICAgaWQ9InBhdGgxNDAiIC8+CiAgICAgICAgPC9nPgogICAgICAgIDxnCiAgICAgICAgICAgaWQ9ImcxNDIiCiAgICAgICAgICAgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzU5LjQ3MTcsMTczLjE2ODkpIj4KICAgICAgICAgIDxwYXRoCiAgICAgICAgICAgICBkPSJtIDAsMCAyNC4zOTYsLTQ4LjU1MyAtNTEuMzQzLC00OC41NCB6IgogICAgICAgICAgICAgc3R5bGU9ImZpbGw6I2U5NjYxYztmaWxsLW9wYWNpdHk6MTtmaWxsLXJ1bGU6bm9uemVybztzdHJva2U6bm9uZSIKICAgICAgICAgICAgIGlkPSJwYXRoMTQ0IiAvPgogICAgICAgIDwvZz4KICAgICAgPC9nPgogICAgPC9nPgogIDwvZz4KPC9zdmc+Cg==" alt="BHIM" style="height:16px; margin-bottom:8px;">
            BHIM UPI
          </a>
          <form id="codForm" action="/api/orders/${order.id}/pay-cod" method="POST" style="display: none;"></form>
          <a href="javascript:void(0)" class="upi-btn" onclick="if(confirm('Switching to Cash on Delivery will add a ₹20 charge. Proceed?')) document.getElementById('codForm').submit()" style="background: #fffdf7; border-color: #f59e0b;">
            <div style="font-size: 24px; margin-bottom: 8px;">💵</div>
            Cash on Delivery
          </a>
        </div>
        <div class="qr-section">
          <div class="section-title" style="margin-top: 0;">Scan QR Code</div>
          <img src="/images/scanner.jpg" alt="QR Code" onerror="this.src='https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent('${upiLink}')">
          <div class="qr-hint">Scan with any UPI app to pay ₹${amount}</div>
        </div>
        
        <div class="section-title">UPI ID</div>
        <div class="upi-id-box">
          <input type="text" class="upi-input" id="upi-val" value="${upiId}" readonly>
          <button class="copy-btn" onclick="copyUpi()" title="Copy">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
        </div>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin-bottom: 24px;">
        
        <div class="section-title">Confirm Payment</div>
        
        <div class="upload-box" id="upload-box">
          <input type="file" class="file-input" id="screenshot-input" accept="image/*" onchange="handleFile(this)">
          <div class="upload-icon">↑</div>
          <div class="upload-text" id="upload-text">Payment Screenshot *<br><span style="font-size:12px; font-weight:400; color:#94a3b8; margin-top:4px; display:block;">Click to upload successfully paid receipt</span></div>
        </div>
        
        <div id="error-msg" class="error-msg"></div>
        
        <button id="submit-btn" class="submit-btn" onclick="submitReceipt()">Confirm Payment</button>
      </div>

      <script>
        const orderId = '${order.id}';
        let compressedBase64 = null;

        function copyUpi() {
          const input = document.getElementById('upi-val');
          input.select();
          input.setSelectionRange(0, 99999);
          navigator.clipboard.writeText(input.value);
          const btn = document.querySelector('.copy-btn');
          const originalHtml = btn.innerHTML;
          btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
          setTimeout(() => btn.innerHTML = originalHtml, 2000);
        }

        function openApp() {
          // Do nothing, just let the intent fire
        }

        function handleFile(input) {
          const file = input.files[0];
          if (!file) return;
          
          const box = document.getElementById('upload-box');
          const txt = document.getElementById('upload-text');
          txt.innerHTML = "Processing image...";
          
          const reader = new FileReader();
          reader.readAsDataURL(file);
          reader.onload = function(event) {
            const img = new Image();
            img.src = event.target.result;
            img.onload = function() {
              const canvas = document.createElement('canvas');
              const MAX_WIDTH = 800;
              const MAX_HEIGHT = 800;
              let width = img.width;
              let height = img.height;

              if (width > height) {
                if (width > MAX_WIDTH) {
                  height *= MAX_WIDTH / width;
                  width = MAX_WIDTH;
                }
              } else {
                if (height > MAX_HEIGHT) {
                  width *= MAX_HEIGHT / height;
                  height = MAX_HEIGHT;
                }
              }
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0, width, height);
              
              // Compress to JPEG 70% quality to keep size tiny (<100kb)
              compressedBase64 = canvas.toDataURL('image/jpeg', 0.7);
              
              box.classList.add('has-file');
              txt.innerHTML = "Screenshot Uploaded ✓<br><span style='font-size:12px; font-weight:400;'>Click to change</span>";
            }
          };
        }

        async function submitReceipt() {
          const err = document.getElementById('error-msg');
          const btn = document.getElementById('submit-btn');
          
          if (!compressedBase64) {
            err.innerText = "Please upload a payment screenshot.";
            err.style.display = "block";
            return;
          }
          
          err.style.display = "none";
          btn.disabled = true;
          btn.innerText = "Verifying & Processing...";
          
          try {
            const res = await fetch('/api/orders/' + orderId + '/confirm-upi-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ receiptBase64: compressedBase64 })
            });
            
            const data = await res.json();
            
            if (res.ok) {
              btn.innerText = "Success! Redirecting...";
              btn.style.background = "#d4af37";
              setTimeout(() => {
                window.location.href = '/api/orders/status/' + orderId;
              }, 1000);
            } else {
              err.innerText = data.error || "Verification failed.";
              err.style.display = "block";
              btn.disabled = false;
              btn.innerText = "Confirm Payment";
            }
          } catch (e) {
            err.innerText = "Network error. Try again.";
            err.style.display = "block";
            btn.disabled = false;
            btn.innerText = "Confirm Payment";
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

const crypto = require('crypto');

const confirmUpiPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { receiptBase64 } = req.body;
    
    if (!receiptBase64) {
      return res.status(400).json({ error: 'Payment screenshot is required.' });
    }

    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status.toUpperCase() !== 'PENDING' && order.status.toUpperCase() !== 'PENDING VERIFICATION') {
       return res.json({ message: 'Already processed' });
    }
    
    // Hash the Base64 image
    const imageHash = crypto.createHash('sha256').update(receiptBase64).digest('hex');
    
    // Check for Duplicate Hash in DB
    const existingHash = await prisma.order.findFirst({
      where: { utr: imageHash }
    });
    
    if (existingHash && existingHash.id !== order.id) {
      return res.status(400).json({ error: 'Duplicate screenshot detected! This receipt has already been used.' });
    }

    let cart = [];
    try { cart = JSON.parse(order.cart_details); } catch(e){}

    const shipCorrectOrderNo = await dispatchToShipCorrect(order, cart);

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { 
        status: 'Processing', 
        order_no: shipCorrectOrderNo ? shipCorrectOrderNo.toString() : order.order_no,
        utr: imageHash,               // We store the cryptographic hash of the screenshot in the UTR column
        payment_receipt: receiptBase64 // Storing the actual tiny compressed base64 image
      }
    });

    sendOrderConfirmationEmail(updatedOrder, shipCorrectOrderNo).catch(e => console.warn('[MAILER]', e.message));

    res.json({ message: 'Payment Confirmed' });
  } catch (error) {
    console.error('Error confirming UPI:', error);
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
  confirmUpiPayment,
  processCodPayment,
  getAllOrders,
  deleteOrder,
  updateOrderStatus
};
