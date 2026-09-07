const axios = require('axios');
const prisma = require('../db');
const { sendOrderConfirmationEmail } = require('../utils/mailer');
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

    // Prevent aggressive mobile caching
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).send('Order not found');

    if (order.status.toUpperCase() !== 'PENDING' && order.status.toUpperCase() !== 'PENDING VERIFICATION') {
      return res.redirect(`/api/orders/status/${order.id}`);
    }

    const upiId = process.env.MERCHANT_UPI_ID || "7411090509@sbi";
    const merchantName = process.env.MERCHANT_NAME || "Murthy";
    const amount = Number(order.total).toFixed(2);
    const tr = `HH${order.id}T${Date.now()}`;
    
    // Standard generic intent (for QR, PhonePe, Paytm, etc)
    const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(merchantName)}&am=${amount}&mc=0000&tr=${tr}&cu=INR`;
    const upiLinkWithAmount = upiLink;
    
    // QR-only approach: no app intent links (they cause "limit exceeded" errors in GPay)

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
        .portal-card { background: #fff; width: 100%; max-width: 480px; border-radius: 24px; padding: 28px 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.06); border: 1px solid #f0ebe1; }
        .header-title { font-size: 22px; font-weight: 700; color: #4a3b32; margin-bottom: 8px; text-align: center; }
        .amount-badge { text-align: center; font-size: 32px; font-weight: 800; color: #10b981; margin-bottom: 20px; }
        .qr-box { text-align: center; background: #f0fdf4; border: 2px solid #10b981; border-radius: 20px; padding: 24px 16px; margin-bottom: 24px; }
        .qr-box img { width: 260px; max-width: 100%; border-radius: 12px; }
        .qr-label { margin-top: 14px; font-size: 14px; font-weight: 600; color: #374151; }
        .qr-sublabel { font-size: 12px; color: #9ca3af; margin-top: 4px; }
        .steps-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 18px; margin-bottom: 24px; }
        .step { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
        .step:last-child { margin-bottom: 0; }
        .step-num { min-width: 28px; height: 28px; border-radius: 50%; background: #10b981; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; }
        .step-text { font-size: 14px; color: #475569; line-height: 1.5; }
        .step-text b { color: #1e293b; }
        .utr-section { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px; text-align: center; }
        .utr-title { font-size: 16px; font-weight: 700; color: #1e293b; margin-bottom: 12px; }
        .utr-input { width: 100%; padding: 16px; border: 2px solid #cbd5e1; border-radius: 12px; font-size: 18px; font-weight: 700; color: #334155; text-align: center; letter-spacing: 2px; outline: none; margin-bottom: 16px; transition: 0.2s; }
        .utr-input:focus { border-color: #10b981; box-shadow: 0 0 0 4px rgba(16,185,129,0.1); }
        .submit-btn { width: 100%; padding: 18px; border-radius: 12px; background: #10b981; color: #fff; font-size: 16px; font-weight: 700; border: none; cursor: pointer; transition: 0.2s; }
        .submit-btn:hover { background: #059669; }
        .submit-btn:disabled { background: #94a3b8; cursor: not-allowed; }
        .error-msg { color: #b91c1c; background: #fef2f2; border: 1px solid #f87171; border-radius: 8px; padding: 12px; font-size: 14px; font-weight: 600; margin-bottom: 16px; display: none; text-align: left; }
        .upi-id-box { display: flex; align-items: center; justify-content: center; gap: 8px; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 16px; margin-top: 14px; }
        .upi-id-box span { font-size: 15px; font-weight: 700; color: #1e293b; letter-spacing: 0.5px; }
        .copy-btn { background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 10px; font-size: 12px; font-weight: 600; color: #4b5563; cursor: pointer; }
        .copy-btn:hover { background: #e5e7eb; }
        .pay-now-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 18px; border-radius: 14px; background: linear-gradient(135deg, #10b981, #059669); color: #fff; font-size: 18px; font-weight: 800; text-decoration: none; text-align: center; margin-bottom: 8px; box-shadow: 0 4px 16px rgba(16,185,129,0.35); transition: all 0.2s; }
        .pay-now-btn:hover { background: linear-gradient(135deg, #059669, #047857); box-shadow: 0 6px 20px rgba(16,185,129,0.5); transform: translateY(-1px); }
      </style>
    </head>
    <body>
      <div class="portal-card">
        <h1 class="header-title">Scan & Pay with Any UPI App</h1>
        <div class="amount-badge">₹${amount}</div>
        
        <div class="qr-box">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(upiLinkWithAmount)}" alt="UPI QR Code">
          <div class="qr-label">Open <b>Google Pay</b>, <b>PhonePe</b>, <b>Paytm</b> or any UPI app</div>
          <div class="qr-sublabel">Tap the QR scanner inside the app → Scan this code → Pay</div>
          <div class="upi-id-box">
            <span>${upiId}</span>
            <button class="copy-btn" onclick="navigator.clipboard.writeText('${upiId}'); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy',1500)">Copy</button>
          </div>
        </div>

        <a href="${upiLink}" class="pay-now-btn">
          💳 Pay Now ₹${amount}
        </a>
        <div style="text-align:center; margin-bottom:24px; font-size:12px; color:#9ca3af;">Tap above to open your UPI app directly (works on mobile)</div>

        <div class="steps-box">
          <div class="step">
            <div class="step-num">1</div>
            <div class="step-text">Open <b>Google Pay / PhonePe / Paytm</b> and tap the <b>QR scanner</b> icon</div>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <div class="step-text"><b>Scan the QR code</b> above and complete the payment of <b>₹${amount}</b></div>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <div class="step-text">After payment, <b>take a screenshot</b> of the success screen and upload it below</div>
          </div>
        </div>

        <div class="utr-section">
          <div class="utr-title">Upload Payment Screenshot</div>
          <p style="font-size: 13px; color: #64748b; margin-bottom: 16px;">Our AI will automatically verify your payment screenshot in seconds. Make sure the UTR/Reference number and amount are visible.</p>
          
          <input type="file" id="receipt-upload" accept="image/*" style="margin-bottom: 16px; width: 100%; border: 1px dashed #cbd5e1; padding: 10px; border-radius: 8px; background: #fff; font-size: 14px;">
          <img id="image-preview" style="display:none; max-width: 100%; max-height: 200px; border-radius: 8px; margin: 0 auto 16px; border: 1px solid #e2e8f0;" />
          
          <button id="submit-btn" class="submit-btn">Verify Payment & Ship Order</button>
          <div id="error-msg" class="error-msg" style="margin-top: 16px;"></div>
          <div id="success-msg" style="display:none; margin-top: 16px; color: #15803d; background: #f0fdf4; border: 2px solid #22c55e; border-radius: 12px; padding: 16px; font-size: 16px; font-weight: 700; text-align: center;">✅ Payment Verified! Redirecting to order status...</div>
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
          document.addEventListener('DOMContentLoaded', function() {
            try {
              var ORDER_ID = "${order.id}";
              var currentBase64 = null;
              
              var fileInput = document.getElementById('receipt-upload');
              var submitBtn = document.getElementById('submit-btn');
              var imgElem = document.getElementById('image-preview');
              var errorMsg = document.getElementById('error-msg');
              var successMsg = document.getElementById('success-msg');

              if (fileInput) {
                fileInput.addEventListener('change', function(event) {
                  try {
                    var file = event.target.files[0];
                    if (!file) return;

                    errorMsg.style.display = 'none';
                    imgElem.style.display = 'block';
                    imgElem.src = 'https://i.gifer.com/ZKZg.gif';
                    
                    var reader = new FileReader();
                    reader.onload = function(e) {
                      var img = new Image();
                      img.onload = function() {
                        try {
                          var canvas = document.createElement('canvas');
                          var ctx = canvas.getContext('2d');
                          
                          var MAX_WIDTH = 1000;
                          var MAX_HEIGHT = 1000;
                          var width = img.width;
                          var height = img.height;

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
                          ctx.drawImage(img, 0, 0, width, height);

                          currentBase64 = canvas.toDataURL('image/jpeg', 0.6);
                          imgElem.src = currentBase64;
                        } catch(canvasErr) {
                          console.error('Canvas compression failed:', canvasErr);
                          currentBase64 = e.target.result;
                          imgElem.src = currentBase64;
                        }
                      };
                      img.onerror = function() {
                        errorMsg.innerText = '❌ Failed to load image preview.';
                        errorMsg.style.display = 'block';
                        imgElem.style.display = 'none';
                        currentBase64 = null;
                      };
                      img.src = e.target.result;
                    };
                    reader.onerror = function() {
                      errorMsg.innerText = '❌ Failed to read file.';
                      errorMsg.style.display = 'block';
                      imgElem.style.display = 'none';
                      currentBase64 = null;
                    };
                    reader.readAsDataURL(file);
                  } catch(err) {
                    alert("Error in preview: " + err.message);
                  }
                });
              }

              if (submitBtn) {
                submitBtn.addEventListener('click', function() {
                  try {
                    errorMsg.style.display = 'none';
                    successMsg.style.display = 'none';
                    
                    if (!currentBase64) {
                      errorMsg.innerText = '❌ Please wait for the image preview to load before verifying.';
                      errorMsg.style.display = 'block';
                      alert('Please wait for the image preview to appear before verifying.');
                      return;
                    }

                    submitBtn.disabled = true;
                    submitBtn.innerText = 'AI is Verifying (Takes ~10s)...';
                    submitBtn.style.background = '#6366f1';

                    fetch('/api/orders/' + ORDER_ID + '/verify-receipt', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ imageBase64: currentBase64 })
                    })
                    .then(function(res) {
                      return res.json().then(function(data) {
                        return { ok: res.ok, data: data };
                      }).catch(function() {
                        throw new Error('Server returned an invalid response. Image might be too large.');
                      });
                    })
                    .then(function(result) {
                      if (result.ok && result.data.success) {
                        submitBtn.innerHTML = '✅ Verified! Redirecting...';
                        submitBtn.style.background = '#16a34a';
                        successMsg.style.display = 'block';
                        setTimeout(function() {
                          window.location.href = '/api/orders/status/' + ORDER_ID;
                        }, 1500);
                      } else {
                        var errText = result.data.error || result.data.reason || 'Verification failed. Please try again.';
                        errorMsg.innerText = '❌ AI Check Failed: ' + errText;
                        errorMsg.style.display = 'block';
                        submitBtn.disabled = false;
                        submitBtn.innerText = 'Verify Payment & Ship Order';
                        submitBtn.style.background = '#10b981';
                        alert('AI Check Failed: ' + errText);
                      }
                    })
                    .catch(function(e) {
                      errorMsg.innerText = '❌ ' + e.message;
                      errorMsg.style.display = 'block';
                      submitBtn.disabled = false;
                      submitBtn.innerText = 'Verify Payment & Ship Order';
                      submitBtn.style.background = '#10b981';
                      alert('Network Error: ' + e.message);
                    });
                  } catch (err) {
                    alert('Unexpected Error: ' + err.message);
                    submitBtn.disabled = false;
                    submitBtn.innerText = 'Verify Payment & Ship Order';
                  }
                });
              }
            } catch (initErr) {
              alert("Script initialization error: " + initErr.message);
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


const verifyReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    const { imageBase64 } = req.body;

    console.log(`[AI-VERIFY] Starting verification for order ${id}`);

    if (!imageBase64) {
      return res.status(400).json({ error: 'No image provided.' });
    }

    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const upperStatus = order.status.toUpperCase();
    if (upperStatus !== 'PENDING' && upperStatus !== 'PENDING VERIFICATION' && upperStatus !== 'PENDING_VERIFICATION') {
       return res.status(400).json({ error: 'Order already processed.' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server AI configuration missing (GEMINI_API_KEY).' });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

    // Extract base64 and mimeType
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const mimeMatch = imageBase64.match(/^data:(image\/\w+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

    const prompt = `
      You are an expert payment verifier. Analyze this UPI payment screenshot.
      The expected payment is to 'Murthy' or UPI ID '7411090509@sbi'.
      The expected amount is ₹${order.total}.
      Extract the 12-digit UTR (Transaction/Reference ID).
      Respond strictly in JSON format without markdown wrapping, like this:
      {
        "is_valid": true or false,
        "utr": "extracted 12-digit UTR or null",
        "amount": number found,
        "reason": "short explanation of why it is valid or invalid"
      }
      It is valid ONLY if the amount matches exactly and it shows a successful transaction to the correct recipient.
    `;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Data,
          mimeType: mimeType
        }
      }
    ]);

    const responseText = result.response.text();
    let aiResult;
    try {
      const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
      aiResult = JSON.parse(cleanJson);
    } catch (err) {
      console.error("[AI-VERIFY] Failed to parse AI response:", responseText);
      return res.status(500).json({ error: 'Failed to analyze the screenshot. Please ensure the image is clear.' });
    }

    console.log(`[AI-VERIFY] AI Result:`, aiResult);

    if (!aiResult.is_valid) {
      return res.status(400).json({ success: false, reason: aiResult.reason });
    }

    const utr = aiResult.utr;
    if (!utr || utr.length !== 12 || !/^\d{12}$/.test(utr)) {
      return res.status(400).json({ success: false, reason: "AI could not clearly detect a valid 12-digit UTR in the screenshot." });
    }

    // Smart Security Check: Duplicate UTR Prevention (always need a new photo/transaction)
    const existingOrder = await prisma.order.findFirst({
      where: { utr: utr }
    });
    
    if (existingOrder && existingOrder.id !== order.id) {
      console.warn(`[AI-VERIFY] Spoof detected! UTR ${utr} already used on order ${existingOrder.id}`);
      return res.status(400).json({ error: 'Duplicate transaction detected! This payment screenshot has already been used.' });
    }

    // Update order status and UTR
    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { 
        status: 'Processing', 
        utr: utr
      }
    });

    console.log(`[AI-VERIFY] Order ${id} updated to Processing with UTR ${utr}`);

    res.json({ success: true, message: 'Payment verified and order dispatched!', status: updatedOrder.status });

    // Background ShipCorrect dispatch
    (async () => {
      try {
        let cart = [];
        try { cart = JSON.parse(order.cart_details); } catch(e){}
        const shipCorrectOrderNo = await dispatchToShipCorrect(updatedOrder, cart);
        if (shipCorrectOrderNo) {
          await prisma.order.update({
            where: { id: order.id },
            data: { order_no: shipCorrectOrderNo.toString() }
          });
          console.log(`[AI-VERIFY] ShipCorrect order created: ${shipCorrectOrderNo} for order ${id}`);
        }
      } catch (err) {
        console.error(`[AI-VERIFY] Background ShipCorrect dispatch failed for order ${id}:`, err.message);
      }
    })();

  } catch (error) {
    console.error('[AI-VERIFY] Fatal error:', error);
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
  verifyReceipt,
  processCodPayment,
  getAllOrders,
  deleteOrder,
  updateOrderStatus
};
