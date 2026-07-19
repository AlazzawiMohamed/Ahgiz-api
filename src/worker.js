// ahgiz-api/src/worker.js
// separate Railway service (worker) — not called from app.js.
// Start Command: node src/worker.js
require('dotenv').config();
const logger = require('./utils/logger');

require('./utils/config').validateEnv({ service: 'worker' });

require('./queues/whatsapp.queue'); // initialize the Bull queue processor
require('./cron/jobs');             // schedule the 12 cron jobs

logger.info('✅ ahgiz-worker: 13 cron jobs + WhatsApp queue active');
