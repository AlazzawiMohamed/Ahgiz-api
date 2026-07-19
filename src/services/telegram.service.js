// Telegram Bot API client — shared by the security alert (which attaches the buttons) and
// the webhook controller (which handles them being pressed).
//
// LANGUAGE NOTE: same exemption as alert.service.js. The button labels and bot replies are
// admin-facing content the owner reads directly in Telegram, so they are Arabic. Everything
// else in this file — comments, logs, errors — is English.
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');

const TIMEOUT_MS = 5000;

const botToken      = () => String(process.env.TELEGRAM_BOT_TOKEN      || '').trim();
const chatId        = () => String(process.env.TELEGRAM_CHAT_ID        || '').trim();
const webhookSecret = () => String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

// ── Callback payloads carried on the inline buttons ──────────────────────────
const CB = {
  LOCKDOWN_PROMPT:  'lockdown:prompt',
  LOCKDOWN_CONFIRM: 'lockdown:confirm',
  LOCKDOWN_CANCEL:  'lockdown:cancel',
  NO_ACTION:        'lockdown:noaction',
};

// Attached to the break-glass alert itself.
const ALERT_KEYBOARD = {
  inline_keyboard: [[
    { text: '🔒 إغلاق فوري',            callback_data: CB.LOCKDOWN_PROMPT },
    { text: '✅ أنا من دخل — لا إجراء', callback_data: CB.NO_ACTION },
  ]],
};

// Shown after 🔒 is pressed — lockdown is destructive, so it is never one-click.
const CONFIRM_KEYBOARD = {
  inline_keyboard: [[
    { text: '✅ نعم، أغلق النظام', callback_data: CB.LOCKDOWN_CONFIRM },
    { text: '❌ إلغاء',             callback_data: CB.LOCKDOWN_CANCEL },
  ]],
};

// ── Who is allowed to press the buttons ──────────────────────────────────────
// callback_query.from.id is always a USER id, and user ids are positive. TELEGRAM_CHAT_ID
// is the DESTINATION the alert is posted to — for a group or channel that is a NEGATIVE id,
// which can never equal a user id. Comparing the two directly would therefore reject every
// press, silently and forever. So: prefer an explicit TELEGRAM_ADMIN_USER_ID, and only fall
// back to TELEGRAM_CHAT_ID when it is itself a private-chat (positive) id.
const allowedPresserId = () => {
  const explicit = String(process.env.TELEGRAM_ADMIN_USER_ID || '').trim();
  if (explicit) return explicit;

  const cid = chatId();
  return /^\d+$/.test(cid) ? cid : null; // negative => group/channel => no safe fallback
};

const isAuthorizedPresser = (fromId) => {
  const allowed = allowedPresserId();
  if (!allowed) {
    logger.error(
      'Telegram: no authorized user id configured — set TELEGRAM_ADMIN_USER_ID. ' +
      'TELEGRAM_CHAT_ID is a group/channel id and can never match a user id, so every ' +
      'button press is being rejected.'
    );
    return false;
  }
  return String(fromId ?? '') === allowed;
};

// ── Webhook authenticity ─────────────────────────────────────────────────────
// Telegram echoes the secret we registered with setWebhook on every update. Hashing both
// sides gives a fixed-length compare, so neither the value nor its length leaks through
// timing. Fails closed: an unset secret rejects everything rather than opening the endpoint.
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();

const verifyWebhookSecret = (headerValue) => {
  const expected = webhookSecret();
  if (!expected) {
    logger.error('TELEGRAM_WEBHOOK_SECRET is not set — rejecting every webhook request');
    return false;
  }
  return crypto.timingSafeEqual(sha256(headerValue ?? ''), sha256(expected));
};

// ── Bot API ──────────────────────────────────────────────────────────────────
const callTelegram = async (method, payload) => {
  const token = botToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const { data } = await axios.post(
    `https://api.telegram.org/bot${token}/${method}`,
    payload,
    { timeout: TIMEOUT_MS }
  );
  return data;
};

// Plain text, no parse_mode — see the note in alert.service.js: an unescaped character in
// MarkdownV2 gets the whole message rejected, and a plain alert beats a lost one.
const sendMessage = (text, replyMarkup = null) =>
  callTelegram('sendMessage', {
    chat_id: chatId(),
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });

// Stops Telegram's client-side spinner on the pressed button.
const answerCallbackQuery = (callbackQueryId, text = null) =>
  callTelegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });

// Strips the buttons off a message that has already been acted on, so the same alert cannot
// be pressed a second time.
const clearButtons = (messageChatId, messageId) =>
  callTelegram('editMessageReplyMarkup', {
    chat_id: messageChatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });

// Registered on boot. Never throws: the API must come up even when Telegram is unreachable.
const setWebhook = async () => {
  const base   = String(process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
  const secret = webhookSecret();

  if (!botToken() || !base || !secret) {
    logger.warn(
      'Telegram webhook NOT registered — TELEGRAM_BOT_TOKEN, API_BASE_URL and ' +
      'TELEGRAM_WEBHOOK_SECRET must all be set. Lockdown buttons will not work.'
    );
    return { registered: false };
  }

  const url = `${base}/telegram/webhook`;

  try {
    await callTelegram('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
    });
    logger.info(`Telegram webhook registered → ${url}`);
    return { registered: true, url };
  } catch (err) {
    logger.error('Telegram setWebhook failed — lockdown buttons will not work', {
      error: err.message,
    });
    return { registered: false };
  }
};

module.exports = {
  CB,
  ALERT_KEYBOARD,
  CONFIRM_KEYBOARD,
  allowedPresserId,
  isAuthorizedPresser,
  verifyWebhookSecret,
  callTelegram,
  sendMessage,
  answerCallbackQuery,
  clearButtons,
  setWebhook,
};
