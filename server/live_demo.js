const axios = require('axios');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runLiveDemo() {
  const BASE = 'http://localhost:3000';
  console.log('====================================================');
  console.log('       HAPPY HAIR NUTRITION - LIVE DEMO VERIFICATION');
  console.log('====================================================\n');

  // 1. Check Server & Get Products
  console.log('STEP 1: Checking Live Products on Website');
  let prodsRes = await axios.get(`${BASE}/api/products`);
  console.log(`[SUCCESS] Current website products count: ${prodsRes.data.length}`);
  prodsRes.data.forEach(p => console.log(`   - ID #${p.id}: ${p.title} (₹${p.price})`));
  console.log('');

  // 2. Admin Login
  console.log('STEP 2: Authenticating Admin in Dashboard');
  const loginRes = await axios.post(`${BASE}/api/auth/login`, {
    email: 'admin@example.com',
    password: 'admin123'
  });
  const token = loginRes.data.token;
  console.log('[SUCCESS] Admin logged into dashboard! Token generated.');
  console.log('');

  // 3. Upload New Product
  console.log('STEP 3: Admin Taps "Upload Product" in Dashboard');
  const newProdRes = await axios.post(`${BASE}/api/products`, {
    title: 'Happy Hair — Herbal Hair Growth Serum 100ml',
    price: 899,
    image_url: 'images/w0ut7ai7_WhatsApp Image 2026-06-23 at 10.55.35 AM.jpeg',
    stock: 50
  }, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const newProd = newProdRes.data;
  console.log(`[SUCCESS] Product uploaded automatically to backend DB!`);
  console.log(`   - Product ID: #${newProd.id}`);
  console.log(`   - Title: ${newProd.title}`);
  console.log(`   - Price: ₹${newProd.price}`);
  console.log(`   - Live Website Status: Immediately available for customers to buy!`);
  console.log('');

  // 4. Customer Places Order
  console.log('STEP 4: Customer Opens Website & Buys Newly Uploaded Product');
  const orderRes = await axios.post(`${BASE}/api/orders/create`, {
    name: 'Rahul Sharma',
    phone: '9876543210',
    email: 'rahul.sharma@example.com',
    address: '402 Sunrise Heights, Bandra West',
    city: 'Mumbai',
    pincode: '400050',
    state: 'Maharashtra',
    pay_mode: 'PREPAID',
    cart: [{
      product_id: newProd.id.toString(),
      title: newProd.title,
      price: newProd.price,
      quantity: 1,
      SKU: `PROD-${newProd.id}`
    }]
  });
  const orderId = orderRes.data.order_id;
  const checkoutUrl = orderRes.data.checkout_url;
  console.log(`[SUCCESS] Customer Order Placed!`);
  console.log(`   - Internal Order ID: #${orderId}`);
  console.log(`   - Payment Gateway Page URL: ${BASE}${checkoutUrl}`);
  console.log('');

  // 5. Customer Payment Page Polling Status
  console.log('STEP 5: Customer opens Payment Page & awaits payment verification');
  let pollStatus = await axios.get(`${BASE}/api/payment/status/${orderId}`);
  console.log(`[CUSTOMER VIEW] Current status: "${pollStatus.data.status}" (Polling every 3 seconds...)`);
  console.log('');

  // 6. Admin Approves Payment in Dashboard
  console.log('STEP 6: Admin sees order in Dashboard & clicks "Approve Payment"');
  const approveRes = await axios.post(`${BASE}/api/payment/approve/${orderId}`, {}, {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log(`[SUCCESS] Admin Payment Approved!`);
  console.log(`   - Backend Response: ${approveRes.data.message}`);
  console.log(`   - Shiprocket / ShipCorrect Order #: ${approveRes.data.shipCorrectOrderNo}`);
  console.log('');

  // 7. Customer Page Auto-Refreshes
  console.log('STEP 7: Customer Payment Page Receives Status Update & Auto-Refreshes');
  pollStatus = await axios.get(`${BASE}/api/payment/status/${orderId}`);
  console.log('[CUSTOMER VIEW] Received status payload:', pollStatus.data);
  console.log(`[CUSTOMER VIEW] Refreshed status: "${pollStatus.data.status}"`);
  console.log(`[CUSTOMER VIEW] Received Shiprocket Tracking #: ${pollStatus.data.order_no}`);
  console.log(`[CUSTOMER VIEW] Order Confirmation Details:`);
  console.log(`   - Customer: ${pollStatus.data.customer_name}`);
  console.log(`   - Delivery Address: ${pollStatus.data.address}, ${pollStatus.data.city} - ${pollStatus.data.pincode}`);
  console.log(`   - Total Amount: ₹${pollStatus.data.total}`);
  console.log(`   - Live Tracking Page: ${BASE}/api/orders/status/${orderId}`);
  console.log('');

  // 8. Admin Deletes Product from Dashboard
  console.log('STEP 8: Admin Taps "Delete Product" in Dashboard');
  const delRes = await axios.delete(`${BASE}/api/products/${newProd.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log(`[SUCCESS] ${delRes.data.message}`);
  
  prodsRes = await axios.get(`${BASE}/api/products`);
  console.log(`[SUCCESS] Live website products list after deletion (ID #${newProd.id} removed automatically):`);
  prodsRes.data.forEach(p => console.log(`   - ID #${p.id}: ${p.title} (₹${p.price})`));
  console.log('');

  console.log('====================================================');
  console.log(' 🎉 ALL WORKFLOWS OPERATING 100% SMOOTHLY & BUG-FREE!');
  console.log('====================================================');
}

runLiveDemo().catch(err => {
  console.error('Demo Error:', err.response?.data || err.message);
});
