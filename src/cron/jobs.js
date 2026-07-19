require('dotenv').config();
const cron = require('node-cron');
const { supabaseAdmin } = require('../utils/supabase');
const logger = require('../utils/logger');

// unified wrapper: runs the job and logs any failure to cron_job_logs + logger.
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

// jobs that call a single database RPC function.
const RPC_JOBS = [
  { schedule: '* * * * *',    fn: 'process_pending_notifications',        label: 'pending notifications' },         // Job 1
  { schedule: '*/15 * * * *', fn: 'expire_pending_zaincash_transactions', label: 'expired ZainCash' },        // Job 2
  { schedule: '0 * * * *',    fn: 'expire_pending_asiahawala',            label: 'expired AsiaHawala' },      // Job 3
  { schedule: '*/10 * * * *', fn: 'process_ended_bookings',               label: 'ended bookings' },          // Job 4
  { schedule: '*/30 * * * *', fn: 'process_expired_grace_periods',        label: 'expired grace periods' },      // Job 5
  { schedule: '0 3 * * *',    fn: 'expire_points',                        label: 'expired points' },            // Job 6
  { schedule: '0 2 * * *',    fn: 'expire_ended_subscriptions',           label: 'expired subscriptions' },        // Job 7
  { schedule: '0 1 * * *',    fn: 'expire_featured_boosts',               label: 'expired featured boosts' }, // Job 8
  { schedule: '0 2 * * 0',    fn: 'weekly_data_cleanup',                  label: 'weekly cleanup' },           // Job 9
  { schedule: '0 4 * * 0',    fn: 'hard_delete_expired_users',            label: 'hard-delete expired users' },   // Job 10
  { schedule: '0 2 * * *',    fn: 'expire_record_access_grants',          label: 'expired record-access grants' },    // Job 12 (appsec M3)
];

RPC_JOBS.forEach(({ schedule, fn }) => {
  cron.schedule(schedule, () => run(fn, () => supabaseAdmin.rpc(fn)));
});

// Job 11: rebooking reminders (daily at 10am) — custom logic.
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
      // TODO(i18n): replace with i18n key
      body:              `مر ${days} يوم منذ زيارتك لـ ${row.businesses?.name} — احجز الآن! 📅`,
      channel:           'push',
      scheduled_at:      new Date().toISOString(),
    });
  }
}));

// Job 13: permanently delete accounts after the 30-day window ends (account_deletions.scheduled_at).
// daily at 00:00 Baghdad time (UTC+3).
cron.schedule(
  '0 0 * * *',
  () => run('purge_due_account_deletions', () => supabaseAdmin.rpc('purge_due_account_deletions')),
  { timezone: 'Asia/Baghdad' }
);

logger.info('Cron: 13 jobs scheduled');

module.exports = { RPC_JOBS };
