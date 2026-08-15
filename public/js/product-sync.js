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
      <p id="dyn-modal-prod-summary" style="font-size:13px; color:#aaa; margin-bottom: 16px;"></p>
      
      <form id="dyn-checkout-form">
        <input type="hidden" id="dyn-prod-id">
        <input type="hidden" id="dyn-prod-title">
        <input type="hidden" id="dyn-prod-price">
        
        <div class="dyn-form-group">
          <label>Full Name</label>
          <input type="text" id="dyn-name" placeholder="John Doe">
          <div class="dyn-error" id="err-dyn-name" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div class="dyn-form-group">
          <label>Mobile Number</label>
          <input type="tel" id="dyn-phone" placeholder="9876543210">
          <div class="dyn-error" id="err-dyn-phone" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div class="dyn-form-group">
          <label>Email Address</label>
          <input type="email" id="dyn-email" placeholder="john@example.com">
          <div class="dyn-error" id="err-dyn-email" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div class="dyn-form-group">
          <label>Delivery Address</label>
          <input type="text" id="dyn-address" placeholder="House No, Building, Street Area">
          <div class="dyn-error" id="err-dyn-address" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div style="display:flex; gap:10px;">
          <div class="dyn-form-group" style="flex:1;">
            <label>City</label>
            <input type="text" id="dyn-city" placeholder="Mumbai">
            <div class="dyn-error" id="err-dyn-city" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
          </div>
          <div class="dyn-form-group" style="flex:1;">
            <label>Pincode</label>
            <input type="text" id="dyn-pincode" placeholder="400001">
            <div class="dyn-error" id="err-dyn-pincode" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
          </div>
        </div>
        <div class="dyn-form-group">
          <label>State</label>
          <input type="text" id="dyn-state" placeholder="Maharashtra">
          <div class="dyn-error" id="err-dyn-state" style="color:#ff6b6b; font-size:12px; display:none; margin-top:6px;"></div>
        </div>
        <div class="dyn-form-group">
          <label>Payment Method <span id="dyn-pay-discount-text" style="color:#2ecc71;font-size:10px;display:none;">(₹10 OFF applied)</span></label>
          <select id="dyn-paymode" onchange="calculateDynTotal();">
            <option value="PREPAID">💳 Pay Now (UPI / QR / Apps)</option>
            <option value="COD">Cash on Delivery (COD)</option>
          </select>
        </div>

        <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid rgba(255,255,255,0.05);">
          <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:13px; color:#aaa;">
            <span>Subtotal:</span>
            <span id="dyn-summary-subtotal">₹0</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:13px; color:#2ecc71;">
            <span>Delivery:</span>
            <span>FREE</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:13px; color:#2ecc71;" id="dyn-summary-prepaid">
            <span>Prepaid Discount:</span>
            <span>-₹10</span>
          </div>

          <div style="display:flex; justify-content:space-between; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.1); font-size:16px; font-weight:bold; color:#c99339;">
            <span>Total:</span>
            <span id="dyn-summary-total">₹0</span>
          </div>
        </div>
        
        <button type="submit" id="dyn-submit-btn" class="dynamic-buy-btn" style="margin-top:10px;">Proceed to Payment</button>
      </form>
    </div>
  `;
  document.body.appendChild(modalDiv);

  // Client-side validation for legacy dynamic checkout modal.
  // Returns true when all validations pass, focuses the first invalid field and shows inline errors.
  window.validateDynCheckout = function() {
    const errs = [];
    const showErr = (id, msg) => {
      const el = document.getElementById(id);
      const errEl = document.getElementById('err-' + id);
      if (errEl) { errEl.textContent = msg; errEl.style.display = msg ? 'block' : 'none'; }
      if (msg) errs.push(el);
    };

    // Clear previous errors
    ['dyn-name','dyn-phone','dyn-email','dyn-address','dyn-city','dyn-pincode','dyn-state'].forEach(id => {
      const errEl = document.getElementById('err-' + id);
      if (errEl) errEl.style.display = 'none';
    });

    const name = (document.getElementById('dyn-name').value || '').trim();
    const phone = (document.getElementById('dyn-phone').value || '').trim();
    const email = (document.getElementById('dyn-email').value || '').trim();
    const address = (document.getElementById('dyn-address').value || '').trim();
    const city = (document.getElementById('dyn-city').value || '').trim();
    const pincode = (document.getElementById('dyn-pincode').value || '').trim();
    const state = (document.getElementById('dyn-state').value || '').trim();

    if (!name) showErr('dyn-name', 'Please enter your full name');
    if (!phone || !/^[0-9]{10}$/.test(phone)) showErr('dyn-phone', 'Enter a valid 10-digit mobile number');
    if (email && !/^\S+@\S+\.\S+$/.test(email)) showErr('dyn-email', 'Enter a valid email or leave empty');
    if (!address) showErr('dyn-address', 'Please enter delivery address');
    if (!city) showErr('dyn-city', 'Please enter city');
    if (!pincode || !/^[0-9]{5,6}$/.test(pincode)) showErr('dyn-pincode', 'Enter a valid pincode');
    if (!state) showErr('dyn-state', 'Please enter state');

    if (errs.length) { errs[0].focus(); return false; }
    return true;
  };

  window.closeDynCheckout = function() {
    document.getElementById('dyn-checkout-modal').classList.remove('open');
  };

  window.calculateDynTotal = function() {
    const basePrice = parseFloat(document.getElementById('dyn-prod-price').value || 0);
    const paymode = document.getElementById('dyn-paymode').value;
    let total = basePrice;
    
    // Simplified flow: UPI vs COD. No prepaid discount by default.
    document.getElementById('dyn-summary-prepaid').style.display = 'none';
    document.getElementById('dyn-pay-discount-text').style.display = 'none';
    if (paymode === 'COD') {
      // Add COD delivery fee if required -- not shown here, summary shows FREE unless specified
    }

    document.getElementById('dyn-summary-subtotal').textContent = `₹${basePrice}`;
    document.getElementById('dyn-summary-total').textContent = `₹${Math.max(total, 0)}`;
  };

  window.openProductCheckout = function(id, title, price, imageUrl) {
    document.getElementById('dyn-prod-id').value = id;
    document.getElementById('dyn-prod-title').value = title;
    document.getElementById('dyn-prod-price').value = price;
    document.getElementById('dyn-modal-prod-summary').textContent = `${title} — ₹${price}`;
    
    // Try to prefill from localStorage if available
    try {
      const saved = JSON.parse(localStorage.getItem('dynCheckout') || '{}');
      if (saved.full_name) document.getElementById('dyn-name').value = saved.full_name;
      if (saved.phone) document.getElementById('dyn-phone').value = saved.phone;
      if (saved.email) document.getElementById('dyn-email').value = saved.email;
      if (saved.address) document.getElementById('dyn-address').value = saved.address;
      if (saved.city) document.getElementById('dyn-city').value = saved.city;
      if (saved.pincode) document.getElementById('dyn-pincode').value = saved.pincode;
      if (saved.state) document.getElementById('dyn-state').value = saved.state;
    } catch (e) {
      // ignore parse errors and continue
    }

    // Reset inputs
    document.getElementById('dyn-paymode').value = 'PREPAID';
    calculateDynTotal();
    
    document.getElementById('dyn-checkout-modal').classList.add('open');
  };

  // Form Submit Handler
  document.getElementById('dyn-checkout-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('dyn-submit-btn');
    const origText = btn.textContent;

    // Client-side validation: prevents native browser required popups and focuses first error
    if (typeof validateDynCheckout === 'function') {
      const ok = validateDynCheckout();
      if (!ok) { return; }
    }

    btn.textContent = 'Processing Order...';
    btn.disabled = true;

    // Persist checkout fields locally to improve UX if user returns
    try {
      const saved = {
        full_name: (document.getElementById('dyn-name').value || '').trim(),
        phone: (document.getElementById('dyn-phone').value || '').trim(),
        email: (document.getElementById('dyn-email').value || '').trim(),
        address: (document.getElementById('dyn-address').value || '').trim(),
        city: (document.getElementById('dyn-city').value || '').trim(),
        pincode: (document.getElementById('dyn-pincode').value || '').trim(),
        state: (document.getElementById('dyn-state').value || '').trim()
      };
      localStorage.setItem('dynCheckout', JSON.stringify(saved));
    } catch (e) { /* ignore storage errors */ }

    const prodId = document.getElementById('dyn-prod-id').value;
    const prodTitle = document.getElementById('dyn-prod-title').value;
    const prodPrice = parseFloat(document.getElementById('dyn-prod-price').value);

    const payload = {
      full_name: document.getElementById('dyn-name').value,
      phone: document.getElementById('dyn-phone').value,
      email: document.getElementById('dyn-email').value,
      address: document.getElementById('dyn-address').value,
      city: document.getElementById('dyn-city').value,
      pincode: document.getElementById('dyn-pincode').value,
      state: document.getElementById('dyn-state').value,
      pay_mode: document.getElementById('dyn-paymode').value,
      coupon_code: "",
      cart: [{
        product_id: prodId,
        title: prodTitle,
        price: prodPrice,
        quantity: 1,
        SKU: 'PROD-' + prodId
      }]
    };

    try {
      const res = await fetch(`${API_BASE}/api/orders/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        // Keep modal open briefly for UPI claim flow; close for COD
        if (payload.pay_mode === 'COD') {
          closeDynCheckout();
          if (data.order_id) {
            window.location.href = `/api/orders/status/${data.order_id}`;
          } else {
            window.location.reload();
          }
          return;
        }

        closeDynCheckout();

        // Prefer redirect to server-rendered checkout page which auto-opens Cashfree SDK
        if (data.checkout_url) {
          try {
            fetch('/api/debug/log', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event: 'checkout_redirect', checkout_url: data.checkout_url, order_id: data.order_id || null })
            }).catch(() => {});
          } catch (e) {}
          // Ensure absolute URL
          try {
            let checkoutUrl = data.checkout_url;
            if (checkoutUrl && checkoutUrl.startsWith('/')) checkoutUrl = window.location.origin + checkoutUrl;
            window.location.href = checkoutUrl;
          } catch (e) {
            window.location.href = data.checkout_url;
          }
        } else if (data.paymentSessionId) {
          // No checkout_url available; attempt to open SDK inline as a fallback
          try {
            const cf = window.Cashfree ? window.Cashfree({ mode: (window.CF_ENV || 'sandbox') }) : null;
            if (cf && typeof cf.checkout === 'function') {
              cf.checkout({ paymentSessionId: data.paymentSessionId });
              return;
            }
          } catch (e) {
            console.warn('Cashfree SDK init failed:', e);
          }
          alert('Payment initialized. Please proceed to payment.');
          if (data.order_id) window.location.reload();
        } else if (data.shipCorrectOrderNo || data.order_id) {
          window.location.href = `/api/orders/status/${data.order_id}`;
        } else {
          alert('Order placed successfully!');
        }
      } else {
        alert(data.error || 'Failed to place order');
      }
    } catch (err) {
      console.error(err);
      alert('Network error placing order');
    } finally {
      btn.textContent = origText;
      btn.disabled = false;
    }
  });

  // Sync Products from API
  async function syncProductsFromBackend() {
    try {
      const res = await fetch(`${API_BASE}/api/products`);
      if (!res.ok) return;
      const products = await res.json();

      let grid = document.getElementById('dynamic-products-grid');
      if (!grid) {
        // Create container if not already present
        const showcaseSec = document.createElement('section');
        showcaseSec.id = 'dynamic-products-showcase';
        showcaseSec.style.cssText = 'max-width: 1200px; margin: 40px auto; padding: 0 20px;';
        showcaseSec.innerHTML = `
          <div style="text-align: center; margin-bottom: 24px;">
            <h2 style="font-size: 2rem; color: #1a361d; font-family: sans-serif; margin-bottom: 6px;">Our Products Collection</h2>
            <p style="color: #666; font-size: 0.95rem;">Nourish Your Hair & Scalp With 100% Natural Formulations</p>
          </div>
          <div id="dynamic-products-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 24px;"></div>
        `;
        
        const target = document.getElementById('dynamic-store-container') || document.body;
        target.appendChild(showcaseSec);
        grid = document.getElementById('dynamic-products-grid');
      }

      if (!grid) return;

      if (products.length === 0) {
        grid.innerHTML = `<p style="text-align:center; color:#888; grid-column: 1/-1;">No products currently available.</p>`;
        return;
      }

      grid.innerHTML = products.map(p => {
        const img = p.image_url ? (p.image_url.startsWith('http') || p.image_url.startsWith('/') ? p.image_url : '/' + p.image_url) : '/images/w0ut7ai7_WhatsApp%20Image%202026-06-23%20at%2010.55.35%20AM.jpeg';
        return `
          <div class="dynamic-prod-card" data-product-id="${p.id}">
            <img src="${img}" class="dynamic-prod-img" onerror="this.src='https://via.placeholder.com/300x220?text=Happy+Hair'">
            <div class="dynamic-prod-title">${p.title}</div>
            <div class="dynamic-prod-price">₹${p.price}</div>
            <button class="dynamic-buy-btn" onclick="openProductCheckout(${p.id}, '${p.title.replace(/'/g, "\\'")}', ${p.price}, '${img}')">Buy Now</button>
          </div>
        `;
      }).join('');
    } catch (err) {
      console.warn('Dynamic product sync notice:', err.message);
    }
  }

  // Removed manual UPI QR helpers as we now use Cashfree.

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncProductsFromBackend);
  } else {
    syncProductsFromBackend();
  }
})();
