// ahgiz-api/src/worker.js
// Railway Service منفصل (worker) — لا يُستدعى من app.js.
// Start Command: node src/worker.js
require('dotenv').config();
const logger = require('./utils/logger');

require('./utils/config').validateEnv({ service: 'worker' });

require('./queues/whatsapp.queue'); // تهيئة Bull queue processor
require('./cron/jobs');             // جدولة الـ 12 cron jobs

logger.info('✅ ahgiz-worker: 13 cron jobs + WhatsApp queue active');
