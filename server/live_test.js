const axios = require('axios');
async function runTest() {
  try {
    console.log('1. Creating order on LIVE server...');
    const payload = {
      customer_name: 'LIVE TEST CUSTOMER',
      phone: '9999999999',
      address: '123 Test Street',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001',
      email: 'test@example.com',
      cart_details: JSON.stringify([{ product_id: 1, title: 'Happy Hair Gummies', quantity: 1, price: 10, SKU: 'TEST-SKU' }]),
      total: 10
    };
    const createRes = await axios.post('https://happyhairbrand.vercel.app/api/orders/create', payload);
    const orderId = createRes.data.order_id;
    console.log('Order created! ID:', orderId);
    
    console.log('2. Processing COD payment on LIVE server...');
    const confirmRes = await axios.post(`https://happyhairbrand.vercel.app/api/orders/${orderId}/pay-cod`);
    console.log('Response from server:', confirmRes.data);
    
  } catch(e) {
    console.error('Test failed:', e.response ? e.response.data : e.message);
  }
}
runTest();
