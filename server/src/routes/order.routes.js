const express = require('express');
const router = express.Router();
const { orderController } = require('../controllers');
const authMiddleware = require('../middlewares/auth.middleware');
const { validate, schemas } = require('../middlewares/validate.middleware');

router.get('/', authMiddleware, orderController.getAllOrders);
router.post('/create', validate(schemas.createOrder), orderController.createOrder);
// Redirect legacy manual UPI screenshot route to the automated payment gateway
router.get('/pay/:id', (req, res) => res.redirect(`/api/payment/checkout/${req.params.id}`));
router.get('/:id/cod-confirm', orderController.renderCodConfirmPage);
router.post('/:id/pay-cod', orderController.processCodPayment);
router.post('/approve', authMiddleware, orderController.approveOrder);
router.post('/track', orderController.trackOrder);
router.get('/status/:orderId', orderController.renderTrackingPage);
router.post('/:id/claim-upi', orderController.claimUpi);
router.put('/:id/status', authMiddleware, orderController.updateOrderStatus);
router.delete('/:id', authMiddleware, orderController.deleteOrder);

router.post('/:id/confirm-upi-payment', orderController.confirmUpiPayment);

module.exports = router;
