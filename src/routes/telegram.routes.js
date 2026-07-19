const express = require('express');
const router = express.Router();
const telegramController = require('../controllers/telegram.controller');
const { verifyWebhookSecret } = require('../services/telegram.service');
const logger = require('../utils/logger');

// Gate 1 of 2 — authenticity. Telegram echoes the secret registered via setWebhook in this
// header on every update. Fails closed: an unset TELEGRAM_WEBHOOK_SECRET rejects everything
// rather than leaving the endpoint open. Gate 2 (who pressed the button) is in the
// controller — this header only proves Telegram sent the update, not who is behind it.
const verifySecret = (req, res, next) => {
  if (!verifyWebhookSecret(req.headers['x-telegram-bot-api-secret-token'])) {
    logger.warn('Telegram webhook rejected — missing or wrong secret token');
    return res.status(403).json({ status: 'error', message: 'Forbidden' });
  }
  next();
};

// No dedicated rate limiter, by design: Telegram posts from a fixed IP range and the secret
// is the real gate. The global limiter in app.js still covers this path as flood protection,
// and its budget is far above any real webhook volume.
router.post('/webhook', verifySecret, telegramController.webhook);

module.exports = router;
