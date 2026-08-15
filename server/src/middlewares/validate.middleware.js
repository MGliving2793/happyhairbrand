const { z } = require('zod');

function escapeHtml(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/[<>'"&]/g, (char) => {
    return {
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
      '&': '&amp;'
    }[char] || char;
  });
}

function sanitizeObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item));
  }

  if (value && typeof value === 'object') {
    const sanitized = {};
    Object.entries(value).forEach(([key, item]) => {
      sanitized[key] = sanitizeObject(item);
    });
    return sanitized;
  }

  if (typeof value === 'string') {
    return escapeHtml(value);
  }

  return value;
}

const xssClean = (req, res, next) => {
  try {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body);
    }

    if (req.params && typeof req.params === 'object') {
      req.params = sanitizeObject(req.params);
    }

    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeObject(req.query);
    }

    next();
  } catch (error) {
    next(error);
  }
};

const normalizePaymentMode = (value) => {
  if (typeof value !== 'string') return value;

  const cleaned = value.trim().toUpperCase();
  if (cleaned === 'ONLINE' || cleaned === 'ONLINE_PAYMENT' || cleaned === 'PAYNOW' || cleaned === 'PREPAID' || cleaned === 'PREPAY') {
    return 'PREPAID';
  }
  if (cleaned === 'COD' || cleaned === 'CASH_ON_DELIVERY' || cleaned === 'CASHDELIVERY' || cleaned === 'CASH') {
    return 'COD';
  }
  if (cleaned === 'UPI' || cleaned === 'UPIQR' || cleaned === 'UPI_QR') {
    return 'UPI';
  }

  return cleaned;
};

const paymentModeSchema = z.preprocess(
  (value) => normalizePaymentMode(value),
  z.enum(['PREPAID', 'COD', 'UPI']).optional()
);

// Zod schemas for different routes
const schemas = {
  login: z.object({
    body: z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }),
  }),
  createOrder: z.object({
    body: z.object({
      customer_name: z.string().min(1).max(255).optional(),
      full_name: z.string().min(1).max(255).optional(),
      name: z.string().min(1).max(255).optional(),
      email: z.string().email().optional().or(z.literal('')),
      customer_email: z.string().email().optional().or(z.literal('')),
      address: z.string().min(1).optional(),
      customer_address1: z.string().min(1).optional(),
      address_line1: z.string().min(1).optional(),
      address_line2: z.string().optional(),
      state: z.string().min(1).optional(),
      customer_address_state: z.string().min(1).optional(),
      city: z.string().min(1).optional(),
      customer_address_city: z.string().min(1).optional(),
      pincode: z.string().min(6).max(6).optional(),
      customer_address_pincode: z.string().min(6).max(6).optional(),
      phone: z.string().min(10).max(15).optional(),
      customer_contact_number1: z.string().min(10).max(15).optional(),
      mobile: z.string().min(10).max(15).optional(),
      pay_mode: paymentModeSchema,
      payment_method: paymentModeSchema,
      utr: z.string().optional(),
      quantity: z.union([z.number(), z.string()]).optional(),
      product_id: z.union([z.number(), z.string()]).optional(),
      cart: z.array(z.object({
        title: z.string(),
        price: z.union([z.number(), z.string()]),
        quantity: z.union([z.number(), z.string()]),
        SKU: z.string().optional(),
        product_id: z.union([z.number(), z.string()]).optional(),
        pay_mode: z.string().optional(),
      })).optional()
    })
  }),
  createProduct: z.object({
    body: z.object({
      title: z.string().min(1),
      price: z.number().positive(),
      description: z.string().optional(),
      image_url: z.string().optional(),
      stock: z.number().int().nonnegative().optional()
    })
  })
};

const validate = (schema) => async (req, res, next) => {
  try {
    if (schema) {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
    }
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors
      });
    }
    next(error);
  }
};

module.exports = {
  validate,
  schemas,
  xssClean
};
