const cron = require('node-cron');
const { supabaseAdmin } = require('../utils/supabase');
const logger = require('../utils/logger');

const startCronJobs = () => {
  // Every hour: delete OTP sessions older than 24h
  cron.schedule('0 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count } = await supabaseAdmin
        .from('whatsapp_otp_sessions')
        .delete({ count: 'exact' })
        .lt('created_at', cutoff);
      if (count) logger.info(`Cron: cleaned ${count} expired OTP sessions`);
    } catch (err) {
      logger.error('Cron OTP cleanup failed', { error: err.message });
    }
  });

  logger.info('Cron jobs started');
};

module.exports = { startCronJobs };
