const prisma = require('../db');

// Simple HTML sanitizer
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>"'&]/g, (char) => {
    const map = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' };
    return map[char] || char;
  });
}

// Create Review (Public)
const createReview = async (req, res) => {
  try {
    let { customer_name, rating, comment, productId } = req.body;

    if (!customer_name || !rating || !comment || !productId) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const parsedRating = parseInt(rating);
    if (isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    customer_name = sanitize(customer_name);
    comment = sanitize(comment);

    const review = await prisma.review.create({
      data: {
        customer_name,
        rating: parsedRating,
        comment,
        productId: parseInt(productId)
      }
    });

    res.status(201).json(review);
  } catch (error) {
    console.error('Error creating review:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Get All Reviews (Admin)
const getAllReviews = async (req, res) => {
  try {
    const reviews = await prisma.review.findMany({
      include: { product: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(reviews);
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Get Published Reviews (Public)
const getPublishedReviews = async (req, res) => {
  try {
    const { productId } = req.query;
    
    let whereClause = { is_published: true };
    if (productId) {
      whereClause.productId = parseInt(productId);
    }

    const reviews = await prisma.review.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' }
    });
    res.json(reviews);
  } catch (error) {
    console.error('Error fetching published reviews:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Publish/Unpublish Review (Admin)
const togglePublish = async (req, res) => {
  try {
    const { id } = req.params;
    const { is_published } = req.body;

    const review = await prisma.review.update({
      where: { id: parseInt(id) },
      data: { is_published: Boolean(is_published) }
    });

    res.json(review);
  } catch (error) {
    console.error('Error updating review:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Delete Review (Admin)
const deleteReview = async (req, res) => {
  try {
    const { id } = req.params;
    
    await prisma.review.delete({
      where: { id: parseInt(id) }
    });

    res.json({ message: 'Review deleted successfully' });
  } catch (error) {
    console.error('Error deleting review:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  createReview,
  getAllReviews,
  getPublishedReviews,
  togglePublish,
  deleteReview
};
