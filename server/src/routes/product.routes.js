const express = require('express');
const router = express.Router();
const { productController } = require('../controllers');
const { authMiddleware } = require('../middlewares');
const { validate, schemas } = require('../middlewares/validate.middleware');

// Public routes
router.get('/', productController.getAllProducts);
router.get('/:id', productController.getProductById);

// Protected routes (Admin only)
router.post('/', authMiddleware, validate(schemas.createProduct), productController.createProduct);
router.put('/:id', authMiddleware, productController.updateProduct);
router.delete('/:id', authMiddleware, productController.deleteProduct);

module.exports = router;
