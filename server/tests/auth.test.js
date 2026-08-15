const request = require('supertest');
const app = require('../src/index');
const prisma = require('../src/db');
const bcrypt = require('bcrypt');

describe('Auth Endpoints', () => {
  let testAdminEmail = 'testadmin@example.com';
  let testAdminPassword = 'password123';

  beforeAll(async () => {
    // Create a test admin
    const hashedPassword = await bcrypt.hash(testAdminPassword, 10);
    await prisma.admin.create({
      data: {
        email: testAdminEmail,
        password: hashedPassword,
      },
    });
  });

  afterAll(async () => {
    // Cleanup test admin
    await prisma.admin.deleteMany({
      where: { email: testAdminEmail },
    });
    await prisma.$disconnect();
  });

  it('should login successfully with correct credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: testAdminEmail,
        password: testAdminPassword,
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('token');
  });

  it('should fail to login with incorrect password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: testAdminEmail,
        password: 'wrongpassword',
      });

    expect(res.statusCode).toEqual(401);
    expect(res.body).toHaveProperty('error');
  });

  it('should fail validation with missing email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        password: testAdminPassword,
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toEqual('Validation failed');
  });
});
