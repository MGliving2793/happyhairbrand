const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

// Environment validation (warn when required vars are missing). Do not expose secrets in logs.
function checkRequiredEnv() {
  const requiredWhenNotTest = [
    'JWT_SECRET',
    'DATABASE_URL'
  ];

  const optionalButRecommended = [
    'CASHFREE_APP_ID',
    'CASHFREE_SECRET_KEY',
    'SHIPCORRECT_API_KEY',
    'SHIPCORRECT_BASE_URL',
    'EMAIL_USER'
  ];

  const missing = [];
  if (process.env.NODE_ENV !== 'test') {
    requiredWhenNotTest.forEach((k) => { if (!process.env[k]) missing.push(k); });
  }

  const missingRecommended = optionalButRecommended.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    console.error('[ENV CHECK] Missing required environment variables:', missing.join(', '));
    console.error('[ENV CHECK] The server may not function correctly without these.');
  }

  if (missingRecommended.length > 0) {
    console.warn('[ENV CHECK] Missing recommended environment variables (some features may be disabled):', missingRecommended.join(', '));
  }
}

checkRequiredEnv();

// Global error handlers to catch unhandled rejections and exceptions and log succinctly.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION] Reason:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION] Message:', err && err.message ? err.message : err);
  // In production you might want to exit process to allow a supervisor to restart
});

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Vercel
app.set('trust proxy', 1);


// CORS Configuration - allow localhost development plus Vercel domain and same-origin callers.
// The previous origin checker raised a CORS exception that bubbled into the global 500 handler,
// which explains the browser-level 500 footprint seen on the live domain.
const defaultAllowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'https://happy-hair-nutrition.vercel.app',
  'https://www.happy-hair-nutrition.vercel.app'
];

const configuredOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)
  : [];

const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...configuredOrigins])];

// Security Headers - Helmet configuration moved here so it can use allowedOrigins dynamically
const helmetConnect = ["'self'", 'https://sdk.cashfree.com', 'https://api.qrserver.com'];
allowedOrigins.forEach(o => {
  try {
    const host = new URL(o).origin;
    helmetConnect.push(host);
  } catch (e) {
    // ignore
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "https://*.cashfree.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://*.cashfree.com", "https://cdn.tailwindcss.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://api.qrserver.com", "https://*.cashfree.com"],
      connectSrc: [...helmetConnect, "https://*.cashfree.com"],
      frameSrc: ["'self'", "https://*.cashfree.com"],
      formAction: ["'self'", "https://*.cashfree.com"]
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    const host = (() => {
      try {
        return new URL(origin).hostname;
      } catch {
        return '';
      }
    })();

    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }

    if (host.endsWith('.vercel.app') || host.endsWith('vercel.app') || host.includes('happy-hair-nutrition')) {
      return callback(null, true);
    }

    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate Limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again after 15 minutes' }
});

const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders, please try again later' }
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// Parsing Middlewares with size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Sanitize incoming data to prevent XSS
const { xssClean } = require('./middlewares/validate.middleware');
app.use(xssClean);

// Serve static files for Website and Dashboard
app.use(express.static(path.join(__dirname, '../../public')));
app.use('/website', express.static(path.join(__dirname, '../../public')));
app.use('/dashboard', express.static(path.join(__dirname, '../../dashboard')));

// Legacy frontend bundle requests a video asset under the API static directory.
// The repo ships the relevant MP4 under the image directory, so expose it through a compatibility alias.
app.get('/api/static/videos/happy_hair_hero.mp4', (req, res) => {
  const fallbackVideo = path.join(__dirname, '../../public/images/promo_video.mp4');
  res.sendFile(fallbackVideo, (error) => {
    if (error) {
      console.error('[STATIC VIDEO ERROR]', error.message);
      if (!res.headersSent) {
        res.status(404).json({ error: 'Video asset not found' });
      }
    }
  });
});

// Serve static videos/media
app.use('/api/static', express.static(path.join(__dirname, '../../public')));

// Request Logger (minimal in production)
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
  }
  next();
});

// Apply rate limiters to specific routes
app.use('/api/auth/login', authLimiter);
app.use('/api/orders/create', orderLimiter);

// Routes
app.use('/api', require('./routes'));
// Temporary debug logging route for client-side events
app.use('/api/debug', require('./routes/debug.routes'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err && err.message ? err.message : err);
  // Print full error object and stack to aid debugging in development
  try { console.error(err); } catch (e) { /* ignore */ }
  try { console.error(err && err.stack ? err.stack : 'no-stack'); } catch (e) {}
  res.status(err.status || 500).json({ error: 'Internal Server Error', details: process.env.NODE_ENV !== 'production' ? (err && err.message ? err.message : '') : undefined });
});

// Auto-seed Admin and Default Product on startup
const bcrypt = require('bcryptjs');
const prisma = require('./db');

async function initDbSeed() {
  try {
    const adminCount = await prisma.admin.count();
    if (adminCount === 0) {
      const defaultEmail = process.env.ADMIN_EMAIL || 'mgliving2793@gmail.com';
      const defaultPassword = process.env.ADMIN_PASSWORD || 'mgliving2793';
      const hashedPassword = await bcrypt.hash(defaultPassword, 12);
      await prisma.admin.create({
        data: {
          email: defaultEmail,
          password: hashedPassword
        }
      });
      console.log(`[SEED] Admin created: ${defaultEmail}`);
    }

    const productCount = await prisma.product.count();
    if (productCount === 0) {
      await prisma.product.create({
        data: {
          title: 'Happy Hair \u2013 Instant Seeds Powder Mix',
          price: 699,
          image_url: 'images/w0ut7ai7_WhatsApp Image 2026-06-23 at 10.55.35 AM.jpeg',
          stock: 100
        }
      });
      console.log('[SEED] Default product created');
    }
  } catch (err) {
    console.error('[SEED ERROR]', err.message);
  }
}

// Only listen when running directly (not on Vercel) and not in test mode
if (process.env.VERCEL !== '1' && process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    initDbSeed();
  });
} else {
  // On Vercel, seed on first request
  let seeded = false;
  const originalHandler = app;
  app.use(async (req, res, next) => {
    if (!seeded) {
      seeded = true;
      await initDbSeed().catch(console.error);
    }
    next();
  });
}

module.exports = app;
