const axios = require('axios');

const CF_APP_ID = process.env.CASHFREE_APP_ID;
const CF_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CF_ENV = process.env.CASHFREE_ENV || 'sandbox';
const CF_BASE_URL = CF_ENV === 'sandbox' ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';

const createOrder = async (order, reqHost) => {
  // cfOrderId is a unique id for Cashfree
  const cfOrderId = `order_${order.id}_${Date.now().toString().slice(-4)}`;

  // Prepare payload according to Cashfree v3 orders API
  const payload = {
    order_id: cfOrderId,
    order_amount: order.total,
    order_currency: 'INR',
    customer_details: {
      customer_id: `cust_${Date.now()}`,
      customer_phone: order.phone || '9999999999',
      customer_name: (order.customer_name || 'Customer').toString().substring(0, 50),
      customer_email: order.email || 'customer@example.com'
    },
    order_meta: {
      return_url: `${reqHost}/api/payment/verify/${order.id}?cf_order_id=${cfOrderId}`
    }
  };

  // Build axios instance
  const cashfreeApi = axios.create({
    baseURL: CF_BASE_URL,
    headers: {
      'x-client-id': CF_APP_ID,
      'x-client-secret': CF_SECRET_KEY,
      'x-api-version': '2023-08-01',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    timeout: 10000
  });

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  let attempt = 0;
  const maxAttempts = 2; // initial try + 1 retry
  while (attempt < maxAttempts) {
    try {
      attempt++;
      const response = await cashfreeApi.post('/orders', payload);
      const paymentSessionId = response.data.payment_session_id;
      return { cfOrderId, paymentSessionId };
    } catch (err) {
      const errDetail = err.response?.data || err.message || String(err);
      console.error(`[CASHFREE CREATE ORDER ERROR] attempt=${attempt} cfOrderId=${cfOrderId} detail=`, errDetail);
      if (attempt >= maxAttempts) {
        // After retries exhausted, throw a sanitized error to the caller
        const toThrow = new Error('Cashfree createOrder failed after retry');
        toThrow.detail = typeof errDetail === 'string' ? errDetail : JSON.stringify(errDetail);
        throw toThrow;
      }
      // Small backoff before retrying
      await sleep(500);
    }
  }
};

const getOrder = async (cfOrderId) => {
  const cashfreeApi = axios.create({
    baseURL: CF_BASE_URL,
    headers: {
      'x-client-id': CF_APP_ID,
      'x-client-secret': CF_SECRET_KEY,
      'x-api-version': '2023-08-01',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    timeout: 10000
  });

  try {
    const response = await cashfreeApi.get(`/orders/${cfOrderId}`);
    return response.data;
  } catch (err) {
    console.error('[CASHFREE GET ORDER ERROR]', err.response?.data || err.message);
    throw err;
  }
};

module.exports = {
  createOrder,
  getOrder
};
