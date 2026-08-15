const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  try {
    const order = await prisma.order.create({
      data: {
        customer_name: 'Test QA',
        email: 'qa@test.com',
        phone: '1234567890',
        address: '123 QA St',
        city: 'QA City',
        state: 'QA State',
        pincode: '123456',
        total: 100
      }
    });
    console.log('Created:', order.id);
    await prisma.order.delete({ where: { id: order.id } });
    console.log('Deleted:', order.id);
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

test();
