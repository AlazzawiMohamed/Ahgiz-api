require('dotenv').config();
const cron = require('node-cron');
const { supabaseAdmin } = require('../utils/supabase');
const logger = require('../utils/logger');

// مُغلّف موحّد: ينفّذ المهمة ويسجّل أي فشل في cron_job_logs + logger.
async function run(name, fn) {
  try {
    await fn();
    logger.debug(`Cron ✓ ${name}`);
  } catch (err) {
    logger.error(`Cron ✗ ${name}`, { error: err.message });
    await supabaseAdmin
      .from('cron_job_logs')
      .insert({ job_name: name, success: false, details: { error: err.message } })
      .catch(() => {});
  }
}

// مهام تستدعي دالة RPC واحدة في قاعدة البيانات.
const RPC_JOBS = [
  { schedule: '* * * * *',    fn: 'process_pending_notifications',        label: 'إشعارات معلقة' },         // Job 1
  { schedule: '*/15 * * * *', fn: 'expire_pending_zaincash_transactions', label: 'ZainCash منتهية' },        // Job 2
  { schedule: '0 * * * *',    fn: 'expire_pending_asiahawala',            label: 'AsiaHawala منتهية' },      // Job 3
  { schedule: '*/10 * * * *', fn: 'process_ended_bookings',               label: 'حجوزات منتهية' },          // Job 4
  { schedule: '*/30 * * * *', fn: 'process_expired_grace_periods',        label: 'فترات سماح منتهية' },      // Job 5
  { schedule: '0 3 * * *',    fn: 'expire_points',                        label: 'نقاط منتهية' },            // Job 6
  { schedule: '0 2 * * *',    fn: 'expire_ended_subscriptions',           label: 'اشتراكات منتهية' },        // Job 7
  { schedule: '0 1 * * *',    fn: 'expire_featured_boosts',               label: 'featured boosts منتهية' }, // Job 8
  { schedule: '0 2 * * 0',    fn: 'weekly_data_cleanup',                  label: 'تنظيف أسبوعي' },           // Job 9
  { schedule: '0 4 * * 0',    fn: 'hard_delete_expired_users',            label: 'حذف مستخدمين منتهيين' },   // Job 10
  { schedule: '0 2 * * *',    fn: 'expire_record_access_grants',          label: 'أذونات ملفات منتهية' },    // Job 12 (appsec M3)
];

RPC_JOBS.forEach(({ schedule, fn }) => {
  cron.schedule(schedule, () => run(fn, () => supabaseAdmin.rpc(fn)));
});

// Job 11: إشعارات إعادة الحجز (يومياً 10 صباحاً) — منطق مخصّص.
cron.schedule('0 10 * * *', () => run('rebooking_reminder', async () => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const { data: candidates, error } = await supabaseAdmin
    .from('bookings')
    .select('customer_id, business_id, booking_date, businesses!inner(name, rebooking_reminder_days)')
    .eq('status', 'completed')
    .eq('is_manual', false)
    .lte('booking_date', cutoff);

  if (error) throw error;

  const sent = new Set();
  for (const row of candidates || []) {
    const key = `${row.customer_id}-${row.business_id}`;
    if (sent.has(key)) continue;
    sent.add(key);

    const days = row.businesses?.rebooking_reminder_days ?? 30;
    await supabaseAdmin.from('notifications').insert({
      user_id:           row.customer_id,
      notification_type: 'rebooking_reminder',
      body:              `مر ${days} يوم منذ زيارتك لـ ${row.businesses?.name} — احجز الآن! 📅`,
      channel:           'push',
      scheduled_at:      new Date().toISOString(),
    });
  }
}));

// Job 13: حذف الحسابات نهائياً بعد انتهاء مهلة الـ30 يوماً (account_deletions.scheduled_at).
// يومياً 00:00 بتوقيت بغداد (UTC+3).
cron.schedule(
  '0 0 * * *',
  () => run('purge_due_account_deletions', () => supabaseAdmin.rpc('purge_due_account_deletions')),
  { timezone: 'Asia/Baghdad' }
);

logger.info('Cron: 13 jobs scheduled');

module.exports = { RPC_JOBS };
