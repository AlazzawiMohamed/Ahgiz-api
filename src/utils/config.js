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

const TRANSPORTS = ['ultramsg', 'console', 'disabled'];

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

  logger.info(
    `Config OK — service=${service} transport=${transport} ` +
      `NODE_ENV=${process.env.NODE_ENV || '(unset)'} railway=${isRailwayDeploy()}`
  );

  return { transport };
};

module.exports = {
  validateEnv,
  whatsappTransport,
  consoleTransportAllowed,
  isPlaceholder,
};
