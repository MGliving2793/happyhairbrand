const prisma = require('../db');

// Simple HTML sanitizer
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>"'&]/g, (char) => {
    const map = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' };
    return map[char] || char;
  });
}

// Read All Products (Public)
const getAllProducts = async (req, res) => {
  try {
    const products = await prisma.product.findMany();
    res.json(products);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Read Single Product (Public)
const getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({
      where: { id: parseInt(id) }
    });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(product);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Create Product (Protected)
const createProduct = async (req, res) => {
  try {
    let { title, price, image_url, stock } = req.body;

    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'Valid title is required' });
    }
    
    if (price === undefined || parseFloat(price) <= 0) {
      return res.status(400).json({ error: 'Valid price > 0 is required' });
    }

    if (stock !== undefined && parseInt(stock) < 0) {
      return res.status(400).json({ error: 'Stock must be >= 0' });
    }

    title = sanitize(title);
    if (image_url) image_url = sanitize(image_url);

    const newProduct = await prisma.product.create({
      data: {
        title,
        price: parseFloat(price),
        image_url,
        stock: stock ? parseInt(stock) : 0
      }
    });

    res.status(201).json(newProduct);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Update Product (Protected)
const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    let { title, price, image_url, stock } = req.body;

    const data = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim() === '') {
        return res.status(400).json({ error: 'Valid title is required' });
      }
      data.title = sanitize(title);
    }
    if (price !== undefined) {
      if (parseFloat(price) <= 0) {
        return res.status(400).json({ error: 'Valid price > 0 is required' });
      }
      data.price = parseFloat(price);
    }
    if (image_url !== undefined) {
      data.image_url = sanitize(image_url);
    }
    if (stock !== undefined) {
      if (parseInt(stock) < 0) {
        return res.status(400).json({ error: 'Stock must be >= 0' });
      }
      data.stock = parseInt(stock);
    }

    const updatedProduct = await prisma.product.update({
      where: { id: parseInt(id) },
      data
    });

    res.json(updatedProduct);
  } catch (error) {
    console.error(error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Delete Product (Protected)
const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    
    await prisma.product.delete({
      where: { id: parseInt(id) }
    });

    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error(error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct
};
