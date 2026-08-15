const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function resetDB() {
    console.log('Resetting database...');
    
    // Clear Orders, Reviews, and Products
    await prisma.order.deleteMany({});
    console.log('Deleted all orders.');
    
    await prisma.review.deleteMany({});
    console.log('Deleted all reviews.');
    
    await prisma.product.deleteMany({});
    console.log('Deleted all products.');

    // Seed the default product
    const product = await prisma.product.create({
        data: {
            title: 'Happy Hair – Instant Seeds Powder Mix',
            price: 699,
            image_url: 'images/w0ut7ai7_WhatsApp Image 2026-06-23 at 10.55.35 AM.jpeg',
            stock: 100
        }
    });
    
    console.log('Seeded default product:', product);
    console.log('Database reset complete!');
}

resetDB()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
