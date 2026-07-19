// ahgiz-api/src/utils/config.js
// Validates the environment variables at boot — fails loudly instead of degrading silently.
// Root cause of the vulnerability (2026-07-12): missing credentials were being read as
// "development mode", so the OTP was returned in the response body. We no longer infer the
// environment from the presence or absence of a secret.
const logger = require('./logger');

// Common placeholder values — their presence means the config is incomplete, not correct.
// (`your_instance_id` / `your_token` were genuinely live in production, and went unnoticed
// until the first real request.)
const PLACEHOLDER_RE = /^(your[_-]?\w*|changeme|change_me|placeholder|todo|dummy|example|x+)$/i;

const isPlaceholder = (value) => {
  const s = String(value ?? '').trim();
  return s === '' || PLACEHOLDER_RE.test(s);
};

// Two independent signals that we are in a real deployment:
//  1) NODE_ENV — set by a human, who can misspell it or forget it.
//  2) RAILWAY_ENVIRONMENT — injected by the platform automatically; nobody can forget it.
const isRailwayDeploy = () => Boolean(process.env.RAILWAY_ENVIRONMENT);
const isExplicitDev = () =>
  ['development', 'test'].includes(String(process.env.NODE_ENV || '').trim());

// The default is to deny: a missing or misspelled NODE_ENV ⇒ we treat it as production.
const consoleTransportAllowed = () => isExplicitDev() && !isRailwayDeploy();

const TRANSPORTS = ['ultramsg', 'console', 'disabled', 'telegram-dev'];

const whatsappTransport = () => {
  const t = String(process.env.WHATSAPP_TRANSPORT || 'ultramsg').trim().toLowerCase();
  return TRANSPORTS.includes(t) ? t : 'invalid';
};

const fatal = (message) => {
  logger.error(`FATAL CONFIG — the server will not boot: ${message}`);
  process.exit(1);
};

// service: 'api' | 'worker'
const validateEnv = ({ service }) => {
  const required = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  if (service === 'api') required.push('JWT_REFRESH_SECRET');

  const bad = required.filter((key) => isPlaceholder(process.env[key]));
  if (bad.length) fatal(`Required variables are missing or still set to a placeholder: ${bad.join(', ')}`);

  const transport = whatsappTransport();

  if (transport === 'invalid') {
    fatal(`WHATSAPP_TRANSPORT is invalid — allowed: ${TRANSPORTS.join(' | ')}`);
  }

  // console = development only, and both signals have to agree.
  if (transport === 'console' && !consoleTransportAllowed()) {
    fatal(
      'WHATSAPP_TRANSPORT=console is forbidden outside development — ' +
        `NODE_ENV=${process.env.NODE_ENV || '(unset)'}, ` +
        `RAILWAY_ENVIRONMENT=${isRailwayDeploy() ? 'present' : 'absent'}. ` +
        'Use ultramsg with real credentials, or disabled.'
    );
  }

  // telegram-dev = development only, guarded by the EXACT same double signal as console:
  // it delivers the OTP to the admin's own Telegram chat, so it must never run in a real
  // deployment (the platform-injected RAILWAY_ENVIRONMENT blocks it even if NODE_ENV lies).
  if (transport === 'telegram-dev' && !consoleTransportAllowed()) {
    fatal(
      'WHATSAPP_TRANSPORT=telegram-dev is forbidden outside development — ' +
        `NODE_ENV=${process.env.NODE_ENV || '(unset)'}, ` +
        `RAILWAY_ENVIRONMENT=${isRailwayDeploy() ? 'present' : 'absent'}. ` +
        'Use ultramsg with real credentials, or disabled.'
    );
  }

  if (transport === 'ultramsg') {
    const badCreds = ['ULTRAMSG_INSTANCE_ID', 'ULTRAMSG_TOKEN'].filter((key) =>
      isPlaceholder(process.env[key])
    );
    if (badCreds.length) {
      fatal(
        `WHATSAPP_TRANSPORT=ultramsg, but the following are missing or still placeholders: ${badCreds.join(', ')}. ` +
          'Set the real UltraMsg credentials, or set WHATSAPP_TRANSPORT=disabled ' +
          'to acknowledge explicitly that OTP delivery is turned off.'
      );
    }
  }

  // disabled = an explicit acknowledgement that there is no WhatsApp provider. The server
  // still boots, but login is deliberately turned off.
  if (transport === 'disabled') {
    logger.warn(
      '⚠️  WHATSAPP_TRANSPORT=disabled — no WhatsApp provider. ' +
        'Every OTP send request will return 503, and login is deliberately disabled (fail-closed). ' +
        'The code is never leaked.'
    );
  }

  // Layer 2 (email) is optional, but its absence while WhatsApp is disabled means there is
  // no channel at all for the admin's code.
  const emailReady = Boolean(process.env.RESEND_API_KEY);

  // Layer 3 (break-glass code) — the last way in when both delivery channels are down.
  // Ready only when BOTH are present: the hash (the code) and the email (the session
  // owner). ADMIN_BREAKGLASS_EMAIL is mandatory because admin_sessions.admin_id is NOT
  // NULL and the code is not bound to any particular admin — we declare the owner
  // rather than guessing them.
  const breakglassReady = Boolean(
    /^\$2[aby]\$\d{2}\$/.test(String(process.env.ADMIN_BREAKGLASS_HASH || '').trim()) &&
      String(process.env.ADMIN_BREAKGLASS_EMAIL || '').trim()
  );

  if (transport === 'disabled' && !emailReady && !breakglassReady) {
    logger.warn(
      '⚠️  No admin login channel at all: WhatsApp is disabled, RESEND_API_KEY is unset, ' +
        'and the break-glass code is not configured (ADMIN_BREAKGLASS_HASH + ADMIN_BREAKGLASS_EMAIL). ' +
        'Admin login is currently impossible.'
    );
  }

  // The alert channels are the only deterrent on the emergency path. A working code
  // with no alert is a silent back door.
  if (breakglassReady) {
    const alertChannels = [
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? 'telegram' : null,
      process.env.SLACK_WEBHOOK_URL ? 'slack' : null,
    ].filter(Boolean);

    if (!alertChannels.length) {
      logger.warn(
        '⚠️  Break-glass code is configured but no alert channel is set ' +
          '(TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID or SLACK_WEBHOOK_URL). ' +
          'Using it would pass silently — which defeats the whole purpose of Layer 3. ' +
          'Configure at least one channel.'
      );
    }
  }

  logger.info(
    `Config OK — service=${service} transport=${transport} email=${emailReady ? 'ready' : 'off'} ` +
      `breakglass=${breakglassReady ? 'armed' : 'off'} ` +
      `NODE_ENV=${process.env.NODE_ENV || '(unset)'} railway=${isRailwayDeploy()}`
  );

  return { transport, breakglassReady };
};

module.exports = {
  validateEnv,
  whatsappTransport,
  consoleTransportAllowed,
  isPlaceholder,
};
