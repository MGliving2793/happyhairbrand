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
    

    /* Universal Checkout Modal 2-Column Design */
    #dyn-checkout-modal {
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(8px);
      z-index: 999999;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 15px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    }
    #dyn-checkout-modal.open {
      opacity: 1;
      pointer-events: auto;
    }
    .dyn-modal-card {
      background: #ffffff;
      border-radius: 20px;
      width: 100%;
      max-width: 900px;
      display: flex;
      flex-direction: row;
      overflow: hidden;
      box-shadow: 0 30px 60px -15px rgba(0, 0, 0, 0.4);
      max-height: 90vh;
      transform: translateY(20px);
      transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    #dyn-checkout-modal.open .dyn-modal-card {
      transform: translateY(0);
    }
    @media (max-width: 768px) {
      .dyn-modal-card {
        flex-direction: column;
        overflow-y: auto;
        border-radius: 20px 20px 0 0;
        margin: auto auto 0 auto;
        max-height: 95vh;
      }
      #dyn-checkout-modal {
        align-items: flex-end;
        padding: 0;
      }
    }
    .dyn-modal-left {
      background: linear-gradient(145deg, #102113 0%, #173620 100%);
      color: #fff;
      width: 40%;
      padding: 40px;
      box-sizing: border-box;
      flex-shrink: 0;
      position: relative;
    }
    @media (max-width: 768px) {
      .dyn-modal-left { width: 100%; padding: 25px; }
    }
    .dyn-modal-right {
      padding: 40px;
      flex-grow: 1;
      box-sizing: border-box;
      position: relative;
      background: #fcfcfc;
      color: #2d3748;
      overflow-y: auto;
    }
    @media (max-width: 768px) {
      .dyn-modal-right { padding: 25px; }
    }
    .dyn-close-btn {
      position: absolute;
      top: 20px; right: 24px;
      background: #f1f5f9; border: none;
      color: #64748b; font-size: 24px; cursor: pointer;
      width: 40px; height: 40px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.2s;
    }
    .dyn-close-btn:hover { background: #e2e8f0; color: #0f172a; }
    
    /* Left Side Typography & Spacing */
    .dyn-summary-title { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1.5px; color: #c99339; font-weight: 700; margin-bottom: 16px; }
    .dyn-prod-name { font-family: serif; font-size: 1.8rem; line-height: 1.3; margin-bottom: 8px; color: #f8fafc; }
    .dyn-prod-desc { font-size: 0.95rem; color: #94a3b8; margin-bottom: 40px; }
    
    .dyn-price-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 16px;
      font-size: 15px;
      color: #cbd5e1;
    }
    .dyn-price-row.discount {
      color: #4ade80;
      font-weight: 600;
      display: none;
    }
    .dyn-price-row.total {
      margin-top: 30px;
      padding-top: 24px;
      border-top: 1px dashed rgba(255,255,255,0.2);
      font-size: 1.8rem;
      font-family: serif;
      color: #fff;
    }
    .dyn-discount-text { color: #4ade80; }
    
    /* Right Side Forms */
    .great-choice-header { font-family: serif; font-size: 2.2rem; color: #0f172a; margin-bottom: 10px; font-weight: 600; }
    .great-choice-sub { font-size: 1rem; color: #64748b; margin-bottom: 30px; line-height: 1.5; }
    
    .dyn-form-group { margin-bottom: 20px; position: relative; }
    .dyn-form-group label { display: block; font-size: 13px; color: #475569; font-weight: 600; margin-bottom: 8px; }
    .dyn-form-group input, .dyn-form-group select {
      width: 100%; padding: 12px 16px; background: #fff;
      border: 1.5px solid #cbd5e1; border-radius: 12px; color: #1e293b; font-size: 15px; box-sizing: border-box;
      transition: all 0.25s ease;
      box-shadow: 0 2px 4px rgba(0,0,0,0.02);
    }
    .dyn-form-group input:focus, .dyn-form-group select:focus {
      border-color: #c99339; outline: none; background: #fff; box-shadow: 0 0 0 4px rgba(201, 147, 57, 0.15);
    }
    .dyn-form-group select {
      appearance: none;
      background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
      background-repeat: no-repeat;
      background-position: right 16px center;
      background-size: 16px;
      cursor: pointer;
    }
    
    .dyn-submit-btn {
      width: 100%; padding: 16px; background: linear-gradient(135deg, #102113 0%, #1a361d 100%); color: #ffffff;
      border: none; border-radius: 12px; font-weight: 700; font-size: 1.1rem; cursor: pointer;
      margin-top: 24px; transition: all 0.3s ease;
      box-shadow: 0 10px 25px -5px rgba(26, 54, 29, 0.4);
    }
    .dyn-submit-btn:hover { background: linear-gradient(135deg, #1a361d 0%, #244b28 100%); transform: translateY(-2px); box-shadow: 0 15px 30px -5px rgba(26, 54, 29, 0.5); }
    .dyn-submit-btn:active { transform: translateY(0); }

    .cashfree-badge {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; color: #10b981; font-weight: 600;
      margin-top: 8px; background: #ecfdf5; padding: 4px 10px; border-radius: 20px;
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
    }
  `;
  document.head.appendChild(style);

  // Render Modal HTML
  const modalDiv = document.createElement('div');
  modalDiv.id = 'dyn-checkout-modal';
  modalDiv.innerHTML = `\n
    <div class="dyn-modal-card">
      
      <!-- Left Column: Order Summary (Green System) -->
      <div class="dyn-modal-left">
        <div class="dyn-summary-title">Order Summary</div>
        <div class="dyn-prod-name" id="dyn-modal-prod-summary-title">Happy Hair – Instant Seeds Powder Mix</div>
        <div class="dyn-prod-desc">250g · 25-day supply</div>
        
        <div class="dyn-price-row">
          <span>Quantity</span>
          <span style="display:flex; align-items:center; gap:10px; border:1px solid rgba(255,255,255,0.2); border-radius:20px; padding:4px 12px;">
            <span>1</span>
          </span>
        </div>
        
        <div class="dyn-price-row">
          <span>Subtotal</span>
          <span id="dyn-ui-subtotal">₹0</span>
        </div>
        <div class="dyn-price-row">
          <span>Shipping Charge</span>
          <span id="dyn-ui-delivery-amt" style="font-weight:600; color:#bbb;">₹80</span>
        </div>
        <div class="dyn-price-row discount" id="dyn-ui-discount-row">
          <span>Prepaid Discount</span>
          <span>-₹10</span>
        </div>

        <div class="dyn-price-row total">
          <span>Total</span>
          <span id="dyn-ui-total">₹0</span>
        </div>


      </div>
      
      <!-- Right Column: Checkout Form (White System) -->
      <div class="dyn-modal-right">
        <button class="dyn-close-btn" onclick="closeDynCheckout()" aria-label="Close Checkout">&times;</button>
        <div class="great-choice-header">✨ Great Choice.</div>
        <div class="great-choice-sub">Your Happy Hair journey starts now. Healthy hair begins from within.</div>
        
        <form id="dyn-checkout-form">
          <input type="hidden" id="dyn-prod-id">
          <input type="hidden" id="dyn-prod-title">
          <input type="hidden" id="dyn-prod-price">
          
          <div class="dyn-form-group">
            <label>Full Name</label>
            <input type="text" id="dyn-name" required placeholder="e.g. Raghav Sindhwani">
          </div>
          
          <div style="display:flex; gap:16px; flex-wrap:wrap;">
            <div class="dyn-form-group" style="flex:1; min-width:180px;">
              <label>Email Address</label>
              <input type="email" id="dyn-email" required placeholder="raghav@example.com">
            </div>
            <div class="dyn-form-group" style="flex:1; min-width:180px;">
              <label>Phone Number</label>
              <div style="display:flex; align-items:center; background:#fff; border:1.5px solid #cbd5e1; border-radius:12px; overflow:hidden; transition:all 0.25s ease;" id="dyn-phone-container">
                <span style="padding:12px 0 12px 16px; color:#64748b; font-weight:600; font-size:15px;">+91</span>
                <input type="tel" id="dyn-phone" required placeholder="9876543210" style="border:none; background:transparent; width:100%; box-shadow:none; padding-left:8px;" onfocus="document.getElementById('dyn-phone-container').style.borderColor='#c99339'; document.getElementById('dyn-phone-container').style.boxShadow='0 0 0 4px rgba(201, 147, 57, 0.15)';" onblur="document.getElementById('dyn-phone-container').style.borderColor='#cbd5e1'; document.getElementById('dyn-phone-container').style.boxShadow='none';" oninput="let v = this.value.replace(/\\D/g, ''); if(v.startsWith('91') && v.length > 10) v = v.substring(2); this.value = v.slice(0, 10);">
              </div>
            </div>
          </div>
          
          <div class="dyn-form-group">
            <label>Delivery Address</label>
            <input type="text" id="dyn-address" required placeholder="House No, Building, Street Area">
          </div>
          
          <div style="display:flex; gap:16px; flex-wrap:wrap;">
            <div class="dyn-form-group" style="flex:1; min-width:140px;">
              <label>State</label>
              <select id="dyn-state" required onchange="window.populateDynCities()">
                <option value="" disabled selected>Select State</option>
              </select>
            </div>
            <div class="dyn-form-group" style="flex:1; min-width:140px;">
              <label>City / District</label>
              <select id="dyn-city" required>
                <option value="" disabled selected>Select State First</option>
              </select>
            </div>
          </div>
          
          <div style="display:flex; gap:16px; flex-wrap:wrap;">
            <div class="dyn-form-group" style="flex:1; min-width:140px;">
              <label>Pincode</label>
              <input type="text" id="dyn-pincode" required placeholder="400001" pattern="[0-9]{6}" oninput="this.value = this.value.replace(/\\D/g, '').slice(0, 6)">
            </div>
            <div class="dyn-form-group" style="flex:1; min-width:200px;">
              <label>Payment Method</label>
              <select id="dyn-paymode" onchange="window.updateDynCheckoutTotal()">
                <option value="UPI">⚡ UPI (GPay, PhonePe, Paytm) via Cashfree</option>
                <option value="PREPAID">💳 Cards / NetBanking via Cashfree Secure</option>
                <option value="COD">📦 Cash on Delivery (+₹20)</option>
              </select>
              <div id="cashfree-badge" class="cashfree-badge">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                Secured by Cashfree
              </div>
            </div>
          </div>
          
          <button type="submit" id="dyn-submit-btn" class="dyn-submit-btn">Place Secure Order</button>
        </form>
      </div>
    </div>
  `;
  document.body.appendChild(modalDiv);

  window.closeDynCheckout = function() {
    document.getElementById('dyn-checkout-modal').classList.remove('open');
  };

  window.openProductCheckout = function(id, title, price, imageUrl) {
    document.getElementById('dyn-prod-id').value = id;
    document.getElementById('dyn-prod-title').value = title;
    document.getElementById('dyn-prod-price').value = price;
    
    // Update the title in the left column
    const titleEl = document.getElementById('dyn-modal-prod-summary-title');
    if (titleEl) {
      titleEl.textContent = title;
    }
    
    window.updateDynCheckoutTotal();
    
    document.getElementById('dyn-checkout-modal').classList.add('open');
  };



  window.updateDynCheckoutTotal = function() {
    const price = parseFloat(document.getElementById('dyn-prod-price').value || 0);
    const mode = document.getElementById('dyn-paymode').value;
    
    let delivery = 80;
    if (mode === 'COD') delivery = 100;
    
    const badge = document.getElementById('cashfree-badge');
    if (badge) {
      if (mode === 'COD') {
        badge.style.display = 'none';
      } else {
        badge.style.display = 'inline-flex';
      }
    }
    let discount = 0;
    const discountRow = document.getElementById('dyn-ui-discount-row');
    if (mode === 'PREPAID' || mode === 'UPI') {
      discount = 10;
      if (discountRow) discountRow.style.display = 'flex';
    } else {
      if (discountRow) discountRow.style.display = 'none';
    }

    document.getElementById('dyn-ui-delivery-amt').textContent = `₹${delivery}`;
    document.getElementById('dyn-ui-delivery-amt').style.color = '#bbb';
    
    const total = price + delivery - discount;
    
    document.getElementById('dyn-ui-subtotal').textContent = `₹${price}`;
    document.getElementById('dyn-ui-total').textContent = `₹${total}`;
  };

  const indianLocations = {
    "Andaman and Nicobar Islands": ["Port Blair", "Nicobar", "South Andaman", "North and Middle Andaman"],
    "Andhra Pradesh": ["Visakhapatnam", "Vijayawada", "Guntur", "Nellore", "Tirupati", "Kurnool", "Rajahmundry", "Anantapur", "Kadapa", "Eluru"],
    "Arunachal Pradesh": ["Itanagar", "Tawang", "Ziro", "Pasighat", "Roing", "Tezu"],
    "Assam": ["Guwahati", "Silchar", "Dibrugarh", "Jorhat", "Nagaon", "Tinsukia", "Tezpur", "Bongaigaon"],
    "Bihar": ["Patna", "Gaya", "Bhagalpur", "Muzaffarpur", "Purnia", "Darbhanga", "Ara", "Begusarai", "Katihar", "Chapra"],
    "Chandigarh": ["Chandigarh"],
    "Chhattisgarh": ["Raipur", "Bhilai", "Bilaspur", "Korba", "Durg", "Rajnandgaon", "Raigarh", "Jagdalpur"],
    "Dadra and Nagar Haveli and Daman and Diu": ["Daman", "Diu", "Silvassa"],
    "Delhi": ["New Delhi", "North Delhi", "South Delhi", "East Delhi", "West Delhi", "Central Delhi"],
    "Goa": ["Panaji", "Margao", "Vasco da Gama", "Mapusa", "Ponda", "Calangute"],
    "Gujarat": ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Bhavnagar", "Jamnagar", "Junagadh", "Gandhinagar", "Anand", "Navsari"],
    "Haryana": ["Faridabad", "Gurugram", "Panipat", "Ambala", "Yamunanagar", "Rohtak", "Hisar", "Karnal", "Sonipat", "Panchkula"],
    "Himachal Pradesh": ["Shimla", "Mandi", "Dharamshala", "Solan", "Kullu", "Chamba", "Hamirpur", "Una"],
    "Jharkhand": ["Ranchi", "Jamshedpur", "Dhanbad", "Bokaro", "Deoghar", "Hazaribagh", "Giridih", "Ramgarh"],
    "Karnataka": ["Bengaluru", "Mysuru", "Hubballi-Dharwad", "Mangaluru", "Belagavi", "Davangere", "Ballari", "Kalaburagi", "Udupi", "Shivamogga"],
    "Kerala": ["Thiruvananthapuram", "Kochi", "Kozhikode", "Thrissur", "Kollam", "Alappuzha", "Palakkad", "Kannur", "Kottayam"],
    "Lakshadweep": ["Kavaratti", "Minicoy", "Agatti"],
    "Madhya Pradesh": ["Indore", "Bhopal", "Jabalpur", "Gwalior", "Ujjain", "Sagar", "Dewas", "Satna", "Ratlam", "Rewa"],
    "Maharashtra": ["Mumbai", "Pune", "Nagpur", "Thane", "Nashik", "Kalyan-Dombivli", "Vasai-Virar", "Aurangabad", "Navi Mumbai", "Solapur"],
    "Manipur": ["Imphal", "Churachandpur", "Thoubal", "Kakching", "Ukhrul"],
    "Meghalaya": ["Shillong", "Tura", "Nongstoin", "Jowai", "Baghmara"],
    "Mizoram": ["Aizawl", "Lunglei", "Champhai", "Kolasib", "Serchhip"],
    "Nagaland": ["Dimapur", "Kohima", "Mokokchung", "Tuensang", "Wokha"],
    "Odisha": ["Bhubaneswar", "Cuttack", "Rourkela", "Brahmapur", "Sambalpur", "Puri", "Balasore", "Bhadrak", "Baripada"],
    "Puducherry": ["Pondicherry", "Ozhukarai", "Karaikal", "Yanam", "Mahe"],
    "Punjab": ["Ludhiana", "Amritsar", "Jalandhar", "Patiala", "Bathinda", "Hoshiarpur", "Mohali", "Batala", "Pathankot"],
    "Rajasthan": ["Jaipur", "Jodhpur", "Kota", "Bikaner", "Ajmer", "Udaipur", "Bhilwara", "Alwar", "Sikar", "Pali"],
    "Sikkim": ["Gangtok", "Namchi", "Geyzing", "Mangan"],
    "Tamil Nadu": ["Chennai", "Coimbatore", "Madurai", "Tiruchirappalli", "Salem", "Tirunelveli", "Tiruppur", "Vellore", "Erode", "Thoothukudi"],
    "Telangana": ["Hyderabad", "Warangal", "Nizamabad", "Khammam", "Karimnagar", "Ramagundam", "Mahbubnagar", "Nalgonda"],
    "Tripura": ["Agartala", "Dharmanagar", "Kailashahar", "Udaipur", "Ambassa"],
    "Uttar Pradesh": ["Lucknow", "Kanpur", "Ghaziabad", "Agra", "Varanasi", "Meerut", "Prayagraj", "Bareilly", "Aligarh", "Noida"],
    "Uttarakhand": ["Dehradun", "Haridwar", "Roorkee", "Haldwani", "Rudrapur", "Rishikesh", "Kashipur"],
    "West Bengal": ["Kolkata", "Asansol", "Siliguri", "Durgapur", "Bardhaman", "Malda", "Baharampur", "Shantipur", "Howrah", "Kharagpur"]
  };

  window.populateDynCities = function() {
    const stateSelect = document.getElementById('dyn-state');
    const citySelect = document.getElementById('dyn-city');
    if (!stateSelect || !citySelect) return;
    const selectedState = stateSelect.value;
    
    citySelect.innerHTML = '<option value="" disabled selected>Select City</option>';
    
    if (selectedState && indianLocations[selectedState]) {
      const cities = indianLocations[selectedState].sort();
      cities.forEach(city => {
        const option = document.createElement('option');
        option.value = city;
        option.textContent = city;
        citySelect.appendChild(option);
      });
      const otherOption = document.createElement('option');
      otherOption.value = "Other";
      otherOption.textContent = "Other (Not listed)";
      citySelect.appendChild(otherOption);
    }
  };

  // Populate States initially if not already populated
  const stateSelect = document.getElementById('dyn-state');
  if (stateSelect && stateSelect.options.length <= 1) {
    Object.keys(indianLocations).sort().forEach(state => {
      const option = document.createElement('option');
      option.value = state;
      option.textContent = state;
      stateSelect.appendChild(option);
    });
  }

  // Form Submit Handler
  document.getElementById('dyn-checkout-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('dyn-submit-btn');
    const origText = btn.textContent;
    btn.textContent = 'Processing Order...';
    btn.disabled = true;

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
      coupon_code: null,
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
        window.closeDynCheckout();
        if (data.checkout_url) {
          window.location.href = data.checkout_url;
        } else if (data.shipCorrectOrderNo || data.order_id) {
          alert(`Order Placed Successfully!\nOrder ID: #${data.order_id}\nShipping Ref: ${data.shipCorrectOrderNo || 'Generated'}`);
          window.location.reload();
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncProductsFromBackend);
  } else {
    syncProductsFromBackend();
  }

  // Intercept all clicks on 'Buy Now' or 'Shop Now' buttons to open our modal instead of React's
  document.addEventListener('click', function(e) {
    const btn = e.target.closest('button, a, [role="button"]');
    if (btn) {
      // Don't intercept buttons inside our own modal or our dynamic grid
      if (btn.classList.contains('dynamic-buy-btn') || btn.closest('#dyn-checkout-modal')) {
        return; 
      }
      
      const text = btn.textContent.trim().toLowerCase();
      const testId = btn.getAttribute('data-testid') || '';
      const hasCartIcon = btn.classList.contains('cart-icon') || btn.querySelector('svg') !== null;
      
      if (
        text.includes('buy') || text.includes('shop') || text.includes('order') || text.includes('get ') || text.includes('checkout') ||
        testId.includes('shop') || testId.includes('checkout') || hasCartIcon ||
        ((btn.tagName === 'BUTTON' || btn.getAttribute('role') === 'button') && !text)
      ) {
        e.preventDefault();
        e.stopPropagation(); // Stop React from seeing this click!
        e.stopImmediatePropagation();
        
        // Open our fully-functional dynamic checkout modal instead
        if (window.openProductCheckout) {
          window.openProductCheckout(1, 'Happy Hair – Instant Seeds Powder Mix', 699, '/images/w0ut7ai7_WhatsApp%20Image%202026-06-23%20at%2010.55.35%20AM.jpeg');
        }
      }
    }
  }, true); // Capture phase to beat React
  // Ultimate Fallback: MutationObserver to block the React Modal if the click interceptor misses it
  const observer = new MutationObserver((mutations) => {
    for (let m of mutations) {
      if (m.addedNodes) {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 1) { // Element node
            if (node.getAttribute('data-testid') === 'checkout-dialog' || node.querySelector('[data-testid="checkout-dialog"]')) {
              // The old React modal just tried to open!
              // Hide it instantly
              const dialog = node.getAttribute('data-testid') === 'checkout-dialog' ? node : node.querySelector('[data-testid="checkout-dialog"]');
              if (dialog) dialog.style.display = 'none';
              
              // And open our new modal!
              if (window.openProductCheckout) {
                window.openProductCheckout(1, 'Happy Hair – Instant Seeds Powder Mix', 699, '/images/w0ut7ai7_WhatsApp%20Image%202026-06-23%20at%2010.55.35%20AM.jpeg');
              }
            }
          }
        });
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // End MutationObserver
  
  // Handle State to City dynamic loading
  document.addEventListener('change', async (e) => {
    if (e.target && e.target.id === 'dyn-state') {
      const state = e.target.value;
      const citySelect = document.getElementById('dyn-city');
      if (!state || !citySelect) return;
      
      const cities = indianLocations[state];
      if (cities && cities.length > 0) {
        citySelect.innerHTML = '<option value="" disabled selected>Select City</option>' + cities.map(c => `<option value="${c}">${c}</option>`).join('');
      } else {
        citySelect.innerHTML = '<option value="" disabled selected>Other/Not Listed</option>';
      }
    }
  });

})();
