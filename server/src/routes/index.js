const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const productRoutes = require('./product.routes');
const orderRoutes = require('./order.routes');
const paymentRoutes = require('./payment.routes');
const reviewRoutes = require('./review.routes');
const chatRoutes = require('./chat.routes');
const debugRoutes = require('./debug.routes');

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/orders', orderRoutes);
router.use('/payment', paymentRoutes);
router.use('/reviews', reviewRoutes);
router.use('/chat', chatRoutes);
router.use('/debug-env', debugRoutes);

module.exports = router;
