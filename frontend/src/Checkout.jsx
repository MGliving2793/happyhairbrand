import React, { useState, useEffect } from 'react';
import './Checkout.css';

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
  "Goa": ["Panaji", "Margao", "Vasco da Gama", "Mapusa", "Ponda"],
  "Gujarat": ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Bhavnagar", "Jamnagar", "Gandhinagar", "Junagadh", "Anand", "Navsari"],
  "Haryana": ["Faridabad", "Gurugram", "Panipat", "Ambala", "Yamunanagar", "Rohtak", "Hisar", "Karnal", "Sonipat", "Panchkula"],
  "Himachal Pradesh": ["Shimla", "Mandi", "Dharamshala", "Solan", "Kullu", "Manali"],
  "Jammu and Kashmir": ["Srinagar", "Jammu", "Anantnag", "Baramulla", "Kathua"],
  "Jharkhand": ["Ranchi", "Jamshedpur", "Dhanbad", "Bokaro", "Deoghar", "Hazaribagh", "Giridih"],
  "Karnataka": ["Bengaluru", "Mysuru", "Hubballi-Dharwad", "Mangaluru", "Belagavi", "Davangere", "Ballari", "Tumakuru", "Shivamogga", "Udupi"],
  "Kerala": ["Thiruvananthapuram", "Kochi", "Kozhikode", "Thrissur", "Kollam", "Alappuzha", "Palakkad", "Kannur", "Kottayam"],
  "Ladakh": ["Leh", "Kargil"],
  "Lakshadweep": ["Kavaratti"],
  "Madhya Pradesh": ["Indore", "Bhopal", "Jabalpur", "Gwalior", "Ujjain", "Sagar", "Rewa", "Satna", "Ratlam", "Singrauli"],
  "Maharashtra": ["Mumbai", "Pune", "Nagpur", "Thane", "Nashik", "Kalyan-Dombivli", "Vasai-Virar", "Aurangabad", "Navi Mumbai", "Solapur", "Amravati"],
  "Manipur": ["Imphal", "Thoubal", "Bishnupur", "Churachandpur"],
  "Meghalaya": ["Shillong", "Tura", "Jowai"],
  "Mizoram": ["Aizawl", "Lunglei", "Champhai"],
  "Nagaland": ["Kohima", "Dimapur", "Mokokchung"],
  "Odisha": ["Bhubaneswar", "Cuttack", "Rourkela", "Brahmapur", "Sambalpur", "Puri", "Balasore", "Bhadrak", "Baripada"],
  "Puducherry": ["Puducherry", "Oulgaret", "Karaikal", "Yanam", "Mahe"],
  "Punjab": ["Ludhiana", "Amritsar", "Jalandhar", "Patiala", "Bathinda", "Hoshiarpur", "Mohali", "Batala", "Pathankot"],
  "Rajasthan": ["Jaipur", "Jodhpur", "Kota", "Bikaner", "Ajmer", "Udaipur", "Bhilwara", "Alwar", "Sikar", "Pali"],
  "Sikkim": ["Gangtok", "Namchi", "Gyalshing", "Mangan"],
  "Tamil Nadu": ["Chennai", "Coimbatore", "Madurai", "Tiruchirappalli", "Salem", "Tirunelveli", "Tiruppur", "Erode", "Vellore", "Thoothukudi"],
  "Telangana": ["Hyderabad", "Warangal", "Nizamabad", "Karimnagar", "Ramagundam", "Khammam", "Mahbubnagar", "Nalgonda"],
  "Tripura": ["Agartala", "Dharmanagar", "Udaipur"],
  "Uttar Pradesh": ["Lucknow", "Kanpur", "Ghaziabad", "Agra", "Varanasi", "Meerut", "Prayagraj", "Bareilly", "Aligarh", "Moradabad", "Gorakhpur"],
  "Uttarakhand": ["Dehradun", "Haridwar", "Roorkee", "Haldwani", "Rudrapur", "Kashipur", "Rishikesh"],
  "West Bengal": ["Kolkata", "Asansol", "Siliguri", "Durgapur", "Bardhaman", "Malda", "Baharampur", "Shantipur", "Kharagpur", "Haldia"]
};

export default function Checkout({ isOpen, onClose, initialProduct }) {
  const [formData, setFormData] = useState(() => {
    try {
      const saved = localStorage.getItem('checkoutForm');
      return saved ? JSON.parse(saved) : { name: '', email: '', phone: '', address: '', state: '', city: '', pincode: '', paymode: 'PREPAID' };
    } catch (e) { return { name: '', email: '', phone: '', address: '', state: '', city: '', pincode: '', paymode: 'PREPAID' }; }
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
        title: initialProduct?.title || 'Happy Hair – Instant Seeds Powder Mix',
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
        // NATIVE CASHFREE INTEGRATION: Immediately open the payment gateway without redirecting
        if (data.paymentSessionId && window.Cashfree) {
          try {
            const mode = data.cfEnv || 'sandbox';
            const cf = window.Cashfree({ mode });
            cf.checkout({
                paymentSessionId: data.paymentSessionId,
                redirectTarget: "_self"
            });
            return;
          } catch (e) {
            console.warn('Cashfree SDK inline initialization failed:', e);
          }
        }
        
        // Fallback: If Cashfree SDK is blocked or missing, use the safe server-rendered redirect
        if (data.checkout_url) {
          window.location.href = data.checkout_url.startsWith('/') ? (window.location.origin + data.checkout_url) : data.checkout_url;
          return;
        }

        // COD Success Redirect
        if (data.shipCorrectOrderNo || data.order_id) {
          window.location.href = `/api/orders/status/${data.order_id || data.shipCorrectOrderNo}`;
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
                
                <div className="z-row">
                  <div className="z-input-group">
                    <input type="email" name="email" placeholder=" " value={formData.email} onChange={handleInputChange} />
                    <label>Email Address</label>
                    {errors.email && <div className="z-field-error">{errors.email}</div>}
                  </div>
                  <div className="z-input-group">
                    <input type="tel" name="phone" placeholder=" " pattern="[0-9]{10}" value={formData.phone} onChange={handleInputChange} />
                    <label>Phone Number (10 digits)</label>
                    {errors.phone && <div className="z-field-error">{errors.phone}</div>}
                  </div>
                </div>
              </div>

              <div className="z-section">
                <h3 className="z-section-title">2. Address & Pincode</h3>
                
                <div className="z-input-group z-pincode-group">
                  <input 
                    type="text" 
                    name="pincode" 
                    placeholder=" " 
                    value={formData.pincode} 
                    onChange={handleInputChange} 
                    className={pincodeError ? 'error-input' : ''}
                  />
                  <label>6-Digit Pincode</label>
                  {pincodeLoading && <div className="z-pincode-spinner"></div>}
                  {pincodeError && <div className="z-pincode-error">{pincodeError}</div>}
                  {errors.pincode && <div className="z-field-error">{errors.pincode}</div>}
                </div>

                <div className="z-row">
                  <div className="z-input-group">
                    <input type="text" name="state" placeholder=" " value={formData.state} onChange={handleInputChange} list="states-list" />
                    <label>State (Auto by Pincode or Search)</label>
                    {errors.state && <div className="z-field-error">{errors.state}</div>}
                    <datalist id="states-list">
                      {Object.keys(indianLocations).map(s => <option key={s} value={s} />)}
                    </datalist>
                  </div>
                  
                  <div className="z-input-group">
                    <input type="text" name="city" placeholder=" " value={formData.city} onChange={handleInputChange} list="cities-list" />
                    <label>City / District (Searchable)</label>
                    {errors.city && <div className="z-field-error">{errors.city}</div>}
                    <datalist id="cities-list">
                      {citiesList.map(c => <option key={c} value={c} />)}
                    </datalist>
                  </div>
                </div>

                <div className="z-input-group">
                  <input type="text" name="address" placeholder=" " value={formData.address} onChange={handleInputChange} />
                  <label>House No, Building, Street Area (Optional)</label>
                </div>
              </div>

              <div className="z-section z-mobile-payment">
                <h3 className="z-section-title">3. Payment Method</h3>
                <div className="z-payment-options">
                  <label className={`z-payment-card ${formData.paymode === 'PREPAID' ? 'active' : ''}`}>
                    <input 
                      type="radio" 
                      name="paymode" 
                      value="PREPAID" 
                      checked={formData.paymode === 'PREPAID'} 
                      onChange={handleInputChange} 
                    />
                    <div className="z-payment-content">
                      <div className="z-payment-header">
                        <span className="z-payment-name">💳 Pay Now (UPI / QR / Apps)</span>
                        <span className="z-payment-badge">Cashfree</span>
                      </div>
                      <div className="z-payment-desc">Open your UPI app or scan QR to securely complete payment.</div>
                    </div>
                  </label>

                  <label className={`z-payment-card ${formData.paymode === 'COD' ? 'active' : ''}`}>
                    <input 
                      type="radio" 
                      name="paymode" 
                      value="COD" 
                      checked={formData.paymode === 'COD'} 
                      onChange={handleInputChange} 
                    />
                    <div className="z-payment-content">
                      <div className="z-payment-header">
                        <span className="z-payment-name">📦 Cash on Delivery</span>
                        <span className="z-payment-fee">+₹20</span>
                      </div>
                      <div className="z-payment-desc">Pay when the jar arrives.</div>
                    </div>
                  </label>
                </div>
              </div>

            </form>
          </div>

          {/* Right Side: Order Summary & Pay Button */}
          <div className="z-right-panel">
            <div className="z-summary-card">
              <h3 className="z-summary-title">Order Summary</h3>
              
              <div className="z-prod-info">
                <img src={initialProduct?.image || '/images/w0ut7ai7_WhatsApp%20Image%202026-06-23%20at%2010.55.35%20AM.jpeg'} alt="Product" className="z-p-img" />
                <div>
                  <div className="z-p-title">{initialProduct?.title || 'Happy Hair – Instant Seeds Powder Mix'}</div>
                  <div className="z-p-meta">250g &middot; Qty: 1</div>
                </div>
              </div>
              
              <div className="z-divider"></div>
              
              <div className="z-price-row">
                <span>Item Total</span>
                <span>₹{price}</span>
              </div>

              <div className="z-price-row z-discount" style={{ display: discount > 0 ? 'flex' : 'none' }}>
                <span>Prepaid Discount</span>
                <span>-₹{discount}</span>
              </div>
              
              <div className="z-price-row z-shipping">
                <span>Delivery Fee</span>
                <span>{isCOD ? `₹${delivery}` : 'FREE'}</span>
              </div>
              
              <div className="z-divider"></div>
              
              <div className="z-price-row z-total">
                <span>To Pay</span>
                <span>₹{total}</span>
              </div>

              <button type="button" onClick={submitOrder} className="z-submit-btn" disabled={loading}>
                {loading ? 'Processing Securely...' : (isCOD ? `Place Order (COD ₹${total})` : `Pay ₹${total}`)}
              </button>
              {errors.form && <div className="z-form-error">{errors.form}</div>}
              <div className="z-trust-footer" style={{ textAlign: 'center', marginTop: '20px', color: '#888', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                100% Secure Payments by Cashfree
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
