// ahgiz-api/src/utils/config.js
// تحقّق من متغيّرات البيئة عند الإقلاع — يفشل بصوتٍ عالٍ بدل التدهور الصامت.
// السبب الجذري للثغرة (2026-07-12): غياب بيانات الاعتماد كان يُفسَّر كـ"وضع تطوير"
// فيُعاد الرمز في جسم الاستجابة. لا نستنتج البيئة من وجود/غياب سرّ بعد اليوم.
const logger = require('./logger');

// قيم القوالب الشائعة — وجودها يعني إعداداً ناقصاً، لا إعداداً صحيحاً.
// (`your_instance_id` / `your_token` كانا فعلياً في الإنتاج ولم يُكتشفا إلا عند أول طلب.)
const PLACEHOLDER_RE = /^(your[_-]?\w*|changeme|change_me|placeholder|todo|dummy|example|x+)$/i;

const isPlaceholder = (value) => {
  const s = String(value ?? '').trim();
  return s === '' || PLACEHOLDER_RE.test(s);
};

// إشارتان مستقلّتان على أنّنا في نشرٍ حقيقي:
//  1) NODE_ENV — يضبطه الإنسان، وقد يُخطئ في كتابته أو ينساه.
//  2) RAILWAY_ENVIRONMENT — تحقنه المنصّة تلقائياً، ولا يستطيع أحد نسيانه.
const isRailwayDeploy = () => Boolean(process.env.RAILWAY_ENVIRONMENT);
const isExplicitDev = () =>
  ['development', 'test'].includes(String(process.env.NODE_ENV || '').trim());

// الافتراضي هو المنع: NODE_ENV مفقود أو مكتوب خطأً ⇒ نعامله كإنتاج.
const consoleTransportAllowed = () => isExplicitDev() && !isRailwayDeploy();

const TRANSPORTS = ['ultramsg', 'console', 'disabled', 'telegram-dev'];

const whatsappTransport = () => {
  const t = String(process.env.WHATSAPP_TRANSPORT || 'ultramsg').trim().toLowerCase();
  return TRANSPORTS.includes(t) ? t : 'invalid';
};

const fatal = (message) => {
  logger.error(`FATAL CONFIG — الخادم لن يقلع: ${message}`);
  process.exit(1);
};

// service: 'api' | 'worker'
const validateEnv = ({ service }) => {
  const required = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  if (service === 'api') required.push('JWT_REFRESH_SECRET');

  const bad = required.filter((key) => isPlaceholder(process.env[key]));
  if (bad.length) fatal(`متغيّرات مطلوبة مفقودة أو قيمتها قالب: ${bad.join(', ')}`);

  const transport = whatsappTransport();

  if (transport === 'invalid') {
    fatal(`WHATSAPP_TRANSPORT غير صالح — المسموح: ${TRANSPORTS.join(' | ')}`);
  }

  // console = تطوير فقط، ويجب أن تتحقّق الإشارتان معاً.
  if (transport === 'console' && !consoleTransportAllowed()) {
    fatal(
      'WHATSAPP_TRANSPORT=console ممنوع خارج التطوير — ' +
        `NODE_ENV=${process.env.NODE_ENV || '(غير مضبوط)'}, ` +
        `RAILWAY_ENVIRONMENT=${isRailwayDeploy() ? 'موجود' : 'غير موجود'}. ` +
        'استخدم ultramsg ببيانات حقيقية، أو disabled.'
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
        `WHATSAPP_TRANSPORT=ultramsg لكن ${badCreds.join(' و ')} مفقود أو قيمته قالب. ` +
          'اضبط بيانات UltraMsg الحقيقية، أو اضبط WHATSAPP_TRANSPORT=disabled ' +
          'للإقرار صراحةً بأنّ إرسال رموز التحقق معطّل.'
      );
    }
  }

  // disabled = إقرار صريح بغياب مزوّد واتساب. يقلع الخادم، لكن تسجيل الدخول معطّل عمداً.
  if (transport === 'disabled') {
    logger.warn(
      '⚠️  WHATSAPP_TRANSPORT=disabled — لا يوجد مزوّد واتساب. ' +
        'كل طلبات إرسال رمز التحقق سترجع 503، وتسجيل الدخول معطّل عمداً (fail-closed). ' +
        'لا يوجد أي تسريب للرمز.'
    );
  }

  // الطبقة 2 (بريد) اختيارية، لكن غيابها مع تعطّل واتساب يعني: لا قناة لرمز الأدمن إطلاقاً.
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
      '⚠️  لا توجد أي قناة لتسليم رمز الأدمن: واتساب معطّل و RESEND_API_KEY غير مضبوط. ' +
        'دخول الأدمن غير ممكن حتى تُبنى الطبقة 3 (رمز الطوارئ).'
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
