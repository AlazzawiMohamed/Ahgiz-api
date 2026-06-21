require('dotenv').config();
const cron = require('node-cron');
const { supabaseAdmin } = require('../utils/supabase');
const logger = require('../utils/logger');

const JOBS = [
  { schedule: '* * * * *',    fn: 'process_pending_notifications',       label: 'إشعارات معلقة' },
  { schedule: '*/15 * * * *', fn: 'expire_pending_zaincash_transactions', label: 'ZainCash منتهية' },
  { schedule: '0 * * * *',    fn: 'expire_pending_asiahawala',            label: 'AsiaHawala منتهية' },
  { schedule: '*/10 * * * *', fn: 'process_ended_bookings',               label: 'حجوزات منتهية' },
  { schedule: '*/30 * * * *', fn: 'process_expired_grace_periods',        label: 'فترات سماح منتهية' },
  { schedule: '0 3 * * *',    fn: 'expire_points',                        label: 'نقاط منتهية' },
  { schedule: '0 2 * * *',    fn: 'expire_ended_subscriptions',           label: 'اشتراكات منتهية' },
  { schedule: '0 1 * * *',    fn: 'expire_featured_boosts',               label: 'featured boosts منتهية' },
  { schedule: '0 2 * * 0',    fn: 'weekly_data_cleanup',                  label: 'تنظيف أسبوعي' },
  { schedule: '0 4 * * 0',    fn: 'hard_delete_expired_users',            label: 'حذف مستخدمين منتهيين' },
];

JOBS.forEach(({ schedule, fn, label }) => {
  cron.schedule(schedule, async () => {
    try {
      await supabaseAdmin.rpc(fn);
      logger.debug(`Cron ✓ ${fn}`);
    } catch (err) {
      logger.error(`Cron ✗ ${fn} (${label})`, { error: err.message });
    }
  });
});

logger.info(`Cron: ${JOBS.length} jobs scheduled`);

module.exports = { JOBS };
