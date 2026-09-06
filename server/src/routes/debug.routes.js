const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    SHIPCORRECT_API_KEY: process.env.SHIPCORRECT_API_KEY,
    SHIPCORRECT_PICKUP_ID: process.env.SHIPCORRECT_PICKUP_ID,
    SHIPCORRECT_EMAIL: process.env.SHIPCORRECT_EMAIL,
    SHIPCORRECT_PASSWORD: process.env.SHIPCORRECT_PASSWORD
  });
});

module.exports = router;
