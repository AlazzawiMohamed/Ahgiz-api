// ahgiz-api/src/services/alert.service.js
// Immediate security alerts — two independent channels (Telegram + Slack).
//
// Why two? The alert is the only deterrent on the break-glass path: the code
// opens the door, and the alert is what guarantees the door cannot be opened
// silently. A single channel is a single point of failure that removes the
// deterrent entirely. Hence Promise.allSettled — any one channel succeeding is
// enough, and one failing never takes down the other. (A database trigger blocks
// disabling both channels — see the Layer 3 migration.)
//
// GOVERNING RULE: this file NEVER throws.
// A failed alert must never stop a legitimate admin from getting in during a real
// emergency — otherwise the alarm system becomes an extra lock on the door. Every
// path here is fail-open and time-boxed.
//
// LANGUAGE NOTE: the alert message body is admin-facing content the owner reads
// directly in Telegram/Slack, and it is the one place in this codebase where
// non-English text is allowed inside code. It is rendered in Arabic, English or
// Kurdish according to the `admin_alert_language` row in platform_settings
// (default: ar). Everything else here — comments, logs, internal errors — is English.
const axios = require('axios');
const { UAParser } = require('ua-parser-js');
const { supabaseAdmin } = require('../utils/supabase');
const logger = require('../utils/logger');

const GEO_TIMEOUT_MS  = 3000;
const SEND_TIMEOUT_MS = 5000;

const SETTING_TELEGRAM = 'security_alert_telegram_enabled';
const SETTING_SLACK    = 'security_alert_slack_enabled';
const SETTING_LANGUAGE = 'admin_alert_language';

// ── Message language ─────────────────────────────────────────────────────────

const LANGS        = ['ar', 'en', 'ku'];
const DEFAULT_LANG = 'ar';

// Anything missing or unrecognised falls back to Arabic.
const normalizeLang = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return LANGS.includes(s) ? s : DEFAULT_LANG;
};

// The fixed chrome of the alert. The variable parts (title, fields) are supplied by
// the caller, which passes its own { ar, en, ku } map — see resolveLang.
const L = {
  ar: {
    time:     '🕐 الوقت',
    location: '📍 الموقع',
    isp:      '🏢 المزود',
    ip:       '🌐 IP',
    device:   '💻 الجهاز',
    timezone: '(بغداد)',
    unknown:       'غير معروف',
    unknownDevice: 'جهاز غير معروف',
    computer:      'حاسوب',
    proxy:   '⚠️ الاتصال عبر بروكسي/VPN',
    hosting: '⚠️ الاتصال من مركز بيانات (لا شبكة منزلية)',
  },
  en: {
    time:     '🕐 Time',
    location: '📍 Location',
    isp:      '🏢 ISP',
    ip:       '🌐 IP',
    device:   '💻 Device',
    timezone: '(Baghdad)',
    unknown:       'Unknown',
    unknownDevice: 'Unknown device',
    computer:      'Computer',
    proxy:   '⚠️ Connection through a proxy/VPN',
    hosting: '⚠️ Connection from a datacenter (not a home network)',
  },
  ku: {
    time:     '🕐 کات',
    location: '📍 شوێن',
    isp:      '🏢 خزمەتگوزار',
    ip:       '🌐 IP',
    device:   '💻 ئامێر',
    timezone: '(بەغدا)',
    unknown:       'نەناسراو',
    unknownDevice: 'ئامێری نەناسراو',
    computer:      'کۆمپیوتەر',
    proxy:   '⚠️ پەیوەندی لە ڕێگەی پرۆکسی/VPN',
    hosting: '⚠️ پەیوەندی لە ناوەندی داتاوە (نەک تۆڕی ماڵەوە)',
  },
};

// A caller-supplied value is either a { ar, en, ku } map or a plain value used as-is
// (any caller that predates the language setting still renders unchanged).
const isLangMap = (v) =>
  v !== null && typeof v === 'object' && LANGS.some((l) => l in v);

const resolveLang = (v, lang) =>
  isLangMap(v) ? (v[lang] ?? v[DEFAULT_LANG] ?? v.en ?? Object.values(v)[0]) : v;

// ── Client identity ──────────────────────────────────────────────────────────

const isPrivateIp = (ip) =>
  !ip ||
  /^(10\.|127\.|192\.168\.|169\.254\.|::1$|fc|fd)/i.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

// ip-api.com — the free tier is HTTP only (HTTPS is paid).
// That means the admin's IP crosses the network in plaintext to a third party.
// Acceptable here because this is enrichment, not authentication: we send no code,
// no token, no email — just the IP, which every hop on the path already sees. To
// remove the leak entirely, delete this function; the alert still works with the
// IP alone (it is fail-open by design below).
//
// The city/country come back in the alert's language, because they are rendered
// straight into the message body. ip-api offers no Kurdish, so 'ku' takes the
// English place names — the rest of the message is still Kurdish.
const GEO_LANG = { ar: 'ar', en: 'en', ku: 'en' };

const geoLookup = async (ip, lang) => {
  if (isPrivateIp(ip)) return null;

  try {
    const { data } = await axios.get(
      `http://ip-api.com/json/${encodeURIComponent(ip)}`,
      {
        params: {
          fields: 'status,country,city,isp,org,as,proxy,hosting',
          lang:   GEO_LANG[lang] || GEO_LANG[DEFAULT_LANG],
        },
        timeout: GEO_TIMEOUT_MS,
      }
    );
    if (data?.status !== 'success') return null;
    return data;
  } catch (err) {
    // Enrichment is an improvement, not a requirement — carry on with the IP alone.
    logger.warn('Geo lookup failed — alert proceeds without it', { code: err.code ?? null });
    return null;
  }
};

// Rendered directly into the alert body, so it follows the alert's language.
const parseDevice = (ua, lang = DEFAULT_LANG) => {
  const t = L[normalizeLang(lang)];
  if (!ua) return t.unknownDevice;
  const { browser, os, device } = new UAParser(ua).getResult();
  const parts = [
    [browser.name, browser.version].filter(Boolean).join(' '),
    [os.name, os.version].filter(Boolean).join(' '),
    device.vendor || device.model ? [device.vendor, device.model].filter(Boolean).join(' ') : device.type || t.computer,
  ].filter(Boolean);
  return parts.join(' — ') || t.unknownDevice;
};

// ── Channel enablement + language (platform_settings) ────────────────────────

const isOn = (v) => ['true', 't', '1', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

// If the read fails, enable BOTH channels. The default here is NOISE, NOT SILENCE:
// a spurious alert is annoying, a missing alert is catastrophic. (This inverts the
// rest of the system, where the default is to deny.)
const alertSettings = async () => {
  try {
    const { data, error } = await supabaseAdmin
      .from('platform_settings')
      .select('key, value')
      .in('key', [SETTING_TELEGRAM, SETTING_SLACK, SETTING_LANGUAGE]);

    if (error) throw error;

    const byKey = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
    return {
      // Missing setting = enabled (the migration has not been applied yet => do not go silent).
      telegram: byKey[SETTING_TELEGRAM] === undefined ? true : isOn(byKey[SETTING_TELEGRAM]),
      slack:    byKey[SETTING_SLACK]    === undefined ? true : isOn(byKey[SETTING_SLACK]),
      // Missing or unrecognised => Arabic.
      lang:     normalizeLang(byKey[SETTING_LANGUAGE]),
    };
  } catch (err) {
    logger.error('Could not read alert settings — defaulting BOTH channels ON, language ar', { error: err.message });
    return { telegram: true, slack: true, lang: DEFAULT_LANG };
  }
};

// ── Transports ───────────────────────────────────────────────────────────────

// Plain text with no parse_mode, deliberately: User-Agent strings are full of
// ( ) _ . - which are control characters in MarkdownV2 => any unescaped message is
// rejected with a 400 and the entire alert is lost. An alert that arrives plain
// beats an elegant one that never arrives.
// `replyMarkup` is an optional Telegram inline keyboard (see telegram.service.ALERT_KEYBOARD).
// Telegram-only by nature: Slack silently ignores it, which is why it is not threaded through
// sendSlack.
const sendTelegram = async (text, replyMarkup = null) => {
  const token  = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID   || '').trim();
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set');

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
    { timeout: SEND_TIMEOUT_MS }
  );
  return 'telegram';
};

const sendSlack = async (text) => {
  const url = String(process.env.SLACK_WEBHOOK_URL || '').trim();
  if (!url) throw new Error('SLACK_WEBHOOK_URL is not set');

  await axios.post(url, { text }, { timeout: SEND_TIMEOUT_MS });
  return 'slack';
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds a rich security alert and broadcasts it on every enabled channel.
 * Never throws. Returns a delivery summary for logging only.
 *
 * The language comes from platform_settings.admin_alert_language (ar | en | ku,
 * default ar). `title` and `fields` are admin-facing, so each is either a
 * { ar, en, ku } map or a plain value used as-is in every language.
 *
 * @param {object}  p
 * @param {string|{ar?:string,en?:string,ku?:string}}  p.title   Headline; carries its own leading emoji
 * @param {string} [p.ip]              Client IP (from utils/request.clientIp)
 * @param {string} [p.userAgent]       Raw User-Agent header
 * @param {string} [p.forwardedChain]  Raw X-Forwarded-For — to diagnose the trust proxy setting
 * @param {object|{ar?:object,en?:object,ku?:object}} [p.fields] Key/value pairs appended to the body
 * @param {object} [p.replyMarkup]     Telegram inline keyboard (ignored by Slack)
 * @returns {Promise<{delivered: string[], failed: string[]}>}
 */
const sendSecurityAlert = async ({ title, ip, userAgent, forwardedChain, fields = {}, replyMarkup = null }) => {
  try {
    // The language gates the geo lookup (place names come back translated), so the
    // settings read has to land first — it is a single indexed row, the geo call is
    // the slow one.
    const flags = await alertSettings();
    const lang  = flags.lang;
    const t     = L[lang];
    const geo   = await geoLookup(ip, lang);

    // Logs stay English whatever language the alert itself goes out in.
    const logTitle = resolveLang(title, 'en');

    const sep = lang === 'en' ? ', ' : '، ';   // ar/ku are Arabic-script: U+060C
    const location = geo
      ? [geo.city, geo.country].filter(Boolean).join(sep) || t.unknown
      : t.unknown;
    const isp = geo ? (geo.isp || geo.org || geo.as || t.unknown) : t.unknown;

    // ── Alert message body — the admin reads this directly, in `lang` ──────────
    // The title carries its own leading emoji, so nothing is prepended here.
    const lines = [
      resolveLang(title, lang),
      '',
      `${t.time}: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Baghdad' })} ${t.timezone}`,
      `${t.location}: ${location}`,
      `${t.isp}: ${isp}`,
      `${t.ip}: ${ip || t.unknown}`,
      `${t.device}: ${parseDevice(userAgent, lang)}`,
    ];

    // Extra risk signals from ip-api — an admin logging in from a VPN/datacenter
    // rather than a home network.
    if (geo?.proxy)   lines.push(t.proxy);
    if (geo?.hosting) lines.push(t.hosting);

    for (const [k, v] of Object.entries(resolveLang(fields, lang) || {})) {
      if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`);
    }

    // Shown on the first real use: if the IP above does not match the actual client,
    // the trust proxy hop count in app.js is wrong. See TRUST_PROXY_HOPS.
    if (forwardedChain) lines.push('', `🔎 X-Forwarded-For: ${forwardedChain}`);
    // ── end of alert body ─────────────────────────────────────────────────────

    const text = lines.join('\n');

    const jobs = [];
    if (flags.telegram) jobs.push(sendTelegram(text, replyMarkup));
    if (flags.slack)    jobs.push(sendSlack(text));

    if (!jobs.length) {
      // Should be unreachable: the trigger forbids disabling both channels. If we
      // get here, the migration has not been applied.
      logger.error('SECURITY ALERT NOT SENT — both channels disabled', { title: logTitle });
      return { delivered: [], failed: ['telegram', 'slack'] };
    }

    const results = await Promise.allSettled(jobs);

    const delivered = [];
    const failed = [];
    results.forEach((r) => {
      if (r.status === 'fulfilled') delivered.push(r.value);
      else failed.push(r.reason?.message || 'unknown');
    });

    if (!delivered.length) {
      logger.error('SECURITY ALERT — every channel failed', { title: logTitle, failed });
    } else if (failed.length) {
      logger.warn('Security alert partially delivered', { title: logTitle, delivered, failed });
    } else {
      logger.info(`Security alert delivered → ${delivered.join(', ')}`);
    }

    return { delivered, failed };
  } catch (err) {
    // Last safety net: nothing in here is worth failing the admin's request over.
    logger.error('sendSecurityAlert crashed — swallowed by design', { error: err.message });
    return { delivered: [], failed: ['exception'] };
  }
};

module.exports = { sendSecurityAlert, parseDevice, isPrivateIp };
