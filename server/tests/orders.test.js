const request = require('supertest');
const app = require('../src/index');
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

describe('Order Endpoints', () => {
  let adminToken;
  let testOrderId;
  let testProductId;

  beforeAll(async () => {
    const testAdminEmail = 'testadmin_orders@example.com';
    const hashedPassword = await bcrypt.hash('password', 10);
    const admin = await prisma.admin.create({
      data: { email: testAdminEmail, password: hashedPassword },
    });
    
    adminToken = jwt.sign({ id: admin.id, email: admin.email }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });

    const product = await prisma.product.create({
      data: {
        title: 'Order Test Product',
        price: 100,
        stock: 10
      }
    });
    testProductId = product.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { email: 'order_test@example.com' } });
    await prisma.product.deleteMany({ where: { title: 'Order Test Product' } });
    await prisma.admin.deleteMany({ where: { email: 'testadmin_orders@example.com' } });
    await prisma.$disconnect();
  });

  it('should fail order creation if validation fails (e.g., bad phone number)', async () => {
    const res = await request(app)
      .post('/api/orders/create')
      .send({
        customer_name: 'Test Customer',
        email: 'order_test@example.com',
        phone: '123', // Invalid phone
        pay_mode: 'COD',
        cart: [{
          title: 'Order Test Product',
          price: 100,
          quantity: 1,
          product_id: testProductId
        }]
      });

    expect(res.statusCode).toEqual(400); // Because of zod validation
  });

  it('should create a COD order successfully', async () => {
    const res = await request(app)
      .post('/api/orders/create')
      .send({
        customer_name: 'Test Customer',
        email: 'order_test@example.com',
        phone: '9999999999',
        pincode: '123456',
        pay_mode: 'COD',
        cart: [{
          title: 'Order Test Product',
          price: 100,
          quantity: 1,
          product_id: testProductId,
          pay_mode: 'COD'
        }]
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body).toHaveProperty('order_id');
    testOrderId = res.body.order_id;
  });

  it('should allow admin to fetch all orders', async () => {
    const res = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body)).toBeTruthy();
  });

  it('should not allow unauthorized user to fetch orders', async () => {
    const res = await request(app).get('/api/orders');
    expect(res.statusCode).toEqual(401);
  });
});
