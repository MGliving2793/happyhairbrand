const path = require('path');

// Load env from server directory
require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });

// Set Vercel flag
process.env.VERCEL = '1';

const app = require('../server/src/index.js');

module.exports = app;
