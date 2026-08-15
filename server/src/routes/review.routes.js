const express = require('express');
const router = express.Router();
const { reviewController } = require('../controllers');
const authMiddleware = require('../middlewares/auth.middleware');

// Public routes
router.post('/', reviewController.createReview);
router.get('/published', reviewController.getPublishedReviews);

// Protected routes (Admin only)
router.get('/', authMiddleware, reviewController.getAllReviews);
router.put('/:id/publish', authMiddleware, reviewController.togglePublish);
router.delete('/:id', authMiddleware, reviewController.deleteReview);

module.exports = router;
