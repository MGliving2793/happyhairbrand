const request = require('supertest');
const app = require('../src/index');
const prisma = require('../src/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

describe('Product Endpoints', () => {
  let adminToken;
  let testProductId;

  beforeAll(async () => {
    // Create admin and token
    const testAdminEmail = 'testadmin_products@example.com';
    const hashedPassword = await bcrypt.hash('password', 10);
    const admin = await prisma.admin.create({
      data: { email: testAdminEmail, password: hashedPassword },
    });
    
    adminToken = jwt.sign({ id: admin.id, email: admin.email }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
  });

  afterAll(async () => {
    // Cleanup
    await prisma.product.deleteMany({ where: { title: 'Test Product' } });
    await prisma.admin.deleteMany({ where: { email: 'testadmin_products@example.com' } });
    await prisma.$disconnect();
  });

  it('should create a new product (Admin Only)', async () => {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Test Product',
        price: 500,
        description: 'Test description',
        stock: 50
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body).toHaveProperty('id');
    testProductId = res.body.id;
  });

  it('should fail to create a product without token', async () => {
    const res = await request(app)
      .post('/api/products')
      .send({
        title: 'Test Product 2',
        price: 500,
      });

    expect(res.statusCode).toEqual(401);
  });

  it('should get all products', async () => {
    const res = await request(app).get('/api/products');
    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body)).toBeTruthy();
  });

  it('should get a specific product by ID', async () => {
    const res = await request(app).get(`/api/products/${testProductId}`);
    expect(res.statusCode).toEqual(200);
    expect(res.body.title).toEqual('Test Product');
  });
});
