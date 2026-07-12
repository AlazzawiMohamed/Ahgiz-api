#!/usr/bin/env node
// scripts/send-admin-email-verification.js
//
// تهيئة لمرّة واحدة: يرسل رابط توثيق إلى بريد الأدمن، فيصير البريد قناة احتياطية
// لرمز الـ2FA (الطبقة 2).
//
// لماذا سكربت وليس endpoint؟ لأن طلب التوثيق يحتاج هويّة أدمن مُثبتة — والأدمن
// لا يستطيع تسجيل الدخول أصلاً قبل وجود قناة تسليم (بيضة ودجاجة). تشغيل هذا
// السكربت يتطلب مفتاح service_role، أي أنّ صلاحية التشغيل هي نفسها صلاحية المالك.
//
// الاستخدام:
//   node scripts/send-admin-email-verification.js <admin-email>
//
// يتطلّب في .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
// واختيارياً ADMIN_VERIFY_BASE_URL (افتراضياً رابط الإنتاج).

require('dotenv').config();
const crypto = require('crypto');
const { supabaseAdmin } = require('../src/utils/supabase');
const { sendAdminVerificationEmail, emailConfigured } = require('../src/services/email.service');

const BASE_URL =
  process.env.ADMIN_VERIFY_BASE_URL ||
  'https://divine-creativity-production-b349.up.railway.app/api/v1';

const TTL_MS = 60 * 60 * 1000; // ساعة واحدة

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('الاستخدام: node scripts/send-admin-email-verification.js <admin-email>');
    process.exit(1);
  }
  if (!emailConfigured()) {
    console.error('RESEND_API_KEY غير مضبوط — اضبطه في .env قبل التشغيل.');
    process.exit(1);
  }

  const { data: admin, error } = await supabaseAdmin
    .from('users')
    .select('id, email, admin_email_verified_at')
    .eq('email', email)
    .eq('role', 'admin')
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!admin) {
    console.error(`لا يوجد أدمن بالبريد: ${email}`);
    process.exit(1);
  }
  if (admin.admin_email_verified_at) {
    console.log(`ℹ️  البريد موثّق مسبقاً (${admin.admin_email_verified_at}). لا حاجة لإعادة التوثيق.`);
    process.exit(0);
  }

  // التوكن الخام يُرسل بالبريد فقط؛ نخزّن تجزئته فحسب (كما نفعل مع refresh tokens).
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const { error: upErr } = await supabaseAdmin
    .from('users')
    .update({
      admin_email_verify_token_hash: tokenHash,
      admin_email_verify_expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    })
    .eq('id', admin.id);

  if (upErr) throw upErr;

  const link = `${BASE_URL}/admin/auth/verify-email?token=${rawToken}`;
  await sendAdminVerificationEmail(admin.email, link);

  console.log(`✅ أُرسل رابط التوثيق إلى ${admin.email} — صالح لمدة ساعة، استخدام واحد.`);
  console.log('   افتح الرابط من صندوق البريد نفسه لإتمام التوثيق.');
  process.exit(0);
})().catch((err) => {
  console.error('فشل:', err.message);
  process.exit(1);
});
