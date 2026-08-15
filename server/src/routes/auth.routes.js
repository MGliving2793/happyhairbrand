const express = require('express');
const router = express.Router();
const { authController } = require('../controllers');
const { validate, schemas } = require('../middlewares/validate.middleware');

router.post('/login', validate(schemas.login), authController.login);

module.exports = router;
