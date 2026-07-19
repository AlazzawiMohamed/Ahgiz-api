// Telegram webhook — handles the lockdown/unlock buttons on the break-glass alert.
//
// Two gates stand in front of every action, and both must pass:
//   1. the shared secret header (routes/telegram.routes.js) — proves Telegram sent it
//   2. the sender's user id (below)                          — proves the owner pressed it
// Gate 1 alone is not enough: anyone in the group can press a button, and the update
// Telegram forwards is perfectly authentic.
//
// LANGUAGE NOTE: the bot replies are admin-facing content the owner reads directly in
// Telegram — the same exemption alert.service.js takes. Everything else here is English.
const {
  CB,
  CONFIRM_KEYBOARD,
  isAuthorizedPresser,
  sendMessage,
  answerCallbackQuery,
  clearButtons,
} = require('../services/telegram.service');
const { lockdown, unlock } = require('../services/lockdown.service');
const { clientIp } = require('../utils/request');
const logger = require('../utils/logger');

const MSG = {
  confirm:   '⚠️ هل أنت متأكد؟ سيتم إغلاق النظام وإنهاء جميع الجلسات النشطة فوراً.',
  locked:    '🔒 تم إغلاق النظام — لا يمكن لأحد الدخول الآن',
  cancelled: '✅ تم الإلغاء — لا شيء تغيّر',
  unlocked:  '✅ تم فتح النظام — يمكن الدخول الآن',
  noAction:  '👍 تم — لا إجراء.',
  failed:    '⚠️ فشل تنفيذ الأمر — راجع سجلات الخادم',
};

// Best-effort notification: if the DB write already failed, a failed Telegram reply on top
// of it must not take the process down.
const tell = async (text, keyboard = null) => {
  try {
    await sendMessage(text, keyboard);
  } catch (err) {
    logger.error('Telegram reply failed', { error: err.message });
  }
};

const runLockdown = async (actor, ip) => {
  try {
    await lockdown({ ip, actor });
    await tell(MSG.locked);
  } catch (err) {
    logger.error('LOCKDOWN FAILED', { error: err.message });
    await tell(MSG.failed);
  }
};

const runUnlock = async (actor, ip) => {
  try {
    await unlock({ ip, actor });
    await tell(MSG.unlocked);
  } catch (err) {
    logger.error('UNLOCK FAILED', { error: err.message });
    await tell(MSG.failed);
  }
};

// ── Inline button presses ────────────────────────────────────────────────────
const handleCallback = async (cq, ip) => {
  const fromId = cq.from?.id;

  // Gate 2. Ignore silently — never confirm to a stranger that this endpoint does anything.
  if (!isAuthorizedPresser(fromId)) {
    logger.warn('Telegram callback from an unauthorized user — ignored', { fromId });
    return;
  }

  const actor     = `telegram:${fromId}`;
  const data      = String(cq.data || '');
  const msgChatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  // Clear the spinner on the pressed button first, whatever the outcome.
  try {
    await answerCallbackQuery(cq.id);
  } catch (err) {
    logger.warn('answerCallbackQuery failed — continuing', { error: err.message });
  }

  // Once a decision is taken, take the buttons away so the same alert cannot be replayed.
  const consume = async () => {
    if (!msgChatId || !messageId) return;
    try {
      await clearButtons(msgChatId, messageId);
    } catch (err) {
      logger.warn('Could not clear buttons', { error: err.message });
    }
  };

  switch (data) {
    case CB.LOCKDOWN_PROMPT:
      // Step 1 — confirm. Lockdown is destructive; it is never one click.
      await tell(MSG.confirm, CONFIRM_KEYBOARD);
      return;

    case CB.LOCKDOWN_CONFIRM:
      await consume();
      await runLockdown(actor, ip);
      return;

    case CB.LOCKDOWN_CANCEL:
      await consume();
      await tell(MSG.cancelled);
      return;

    case CB.NO_ACTION:
      await consume();
      logger.info(`Break-glass alert acknowledged as expected by ${actor} — no action taken`);
      await tell(MSG.noAction);
      return;

    default:
      logger.warn('Unknown Telegram callback_data — ignored', { data });
  }
};

// ── Text commands ────────────────────────────────────────────────────────────
const handleMessage = async (message, ip) => {
  const fromId = message.from?.id;

  if (!isAuthorizedPresser(fromId)) {
    logger.warn('Telegram command from an unauthorized user — ignored', { fromId });
    return;
  }

  const actor = `telegram:${fromId}`;
  // Strip any /command@BotName suffix, which Telegram appends inside groups.
  const text = String(message.text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  switch (text) {
    case '/lockdown':
      await tell(MSG.confirm, CONFIRM_KEYBOARD);
      return;

    case '/unlock':
      // No confirmation — unlocking is safe; it only restores the normal login door.
      await runUnlock(actor, ip);
      return;

    default:
      // Not a command we own. Stay silent rather than chatter in the owner's alert channel.
  }
};

exports.webhook = async (req, res) => {
  // The route has already proved this request came from Telegram. It has NOT proved an
  // authorized human sent it — handleCallback/handleMessage do that.
  const update = req.body || {};
  const ip = clientIp(req);

  // Acknowledge immediately, whatever happens next. A non-2xx makes Telegram redeliver the
  // same update for hours, and a lockdown replayed on retry is not something we want.
  res.status(200).json({ ok: true });

  try {
    if (update.callback_query) await handleCallback(update.callback_query, ip);
    else if (update.message)   await handleMessage(update.message, ip);
  } catch (err) {
    logger.error('Telegram webhook handler crashed', { error: err.message });
  }
};
