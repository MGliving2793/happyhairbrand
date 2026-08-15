const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const product = await prisma.product.create({
    data: {
      title: 'Happy Hair – Instant Seeds Powder Mix',
      price: 699,
      image_url: 'images/w0ut7ai7_WhatsApp Image 2026-06-23 at 10.55.35 AM.jpeg',
      stock: 100
    }
  });
  console.log('Product created:', product);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
