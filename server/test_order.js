const axios = require('axios');

async function testOrder() {
  try {
    const res = await axios.post('http://127.0.0.1:3000/api/orders/create', {
      name: "Test2",
      email: "test2@example.com",
      address: "123 Test St",
      state: "TS",
      city: "TestCity",
      pincode: "123456",
      phone: "9999999999",
      pay_mode: "COD",
      cart: [{ title: "Happy Hair", price: 699, quantity: 1, SKU: "123" }]
    });
    console.log("Success:\n", res.data);
  } catch (err) {
    console.error("Error:", err.response ? err.response.data : err.message);
  }
}

testOrder();
