require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const logger = require('./utils/logger');
const { globalLimiter } = require('./middleware/rateLimiter');
const { setWebhook } = require('./services/telegram.service');
const telegramRoutes = require('./routes/telegram.routes');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const sentry = require('./utils/sentry');
const routes = require('./routes/index');
const fs = require('fs');

if (!fs.existsSync('logs')) fs.mkdirSync('logs');

// Validate the config before anything else — a bad production config must not boot at all.
require('./utils/config').validateEnv({ service: 'api' });

// Initialize Sentry early (a no-op without SENTRY_DSN, or without the package installed)
sentry.init();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy — must come before anything that reads req.ip (rate limiters, logs) ──
// Without it, Express ignores the X-Forwarded-For header and req.ip becomes Railway's
// edge IP:
//   • Every admin_audit_log row records the proxy's IP instead of the client's (this
//     was actually happening).
//   • Every rate limiter counts all visitors in a single bucket — including the
//     break-glass limiter (5/hour). That means any stranger can exhaust the attempt
//     budget and lock the owner out of their last way in: a denial of service aimed
//     squarely at the emergency path.
//
// The value is the number of trusted hops between us and the client. Confirmed against
// the live deployment on 2026-07-13 => 2. A break-glass alert reported:
//   X-Forwarded-For: 85.156.96.93, 152.233.12.245   (device, Railway edge)
//   resolved req.ip: 152.233.12.245                 (the edge — one hop short)
// Railway puts two trusted hops in front of us (its edge, then an internal router),
// so the edge's own IP lands in the chain and 1 stops there. 2 reaches the device.
//
// Use an integer, not `true`: with `true` Express trusts the entire chain, so any
// client could forge X-Forwarded-For and inject a fake IP into the security log.
// Counting hops from the right stays safe under forgery — a spoofed value only pushes
// the chain leftwards, and a fixed count still lands on the caller's real IP.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS || '2', 10));

app.use(helmet());
const allowedOrigins = [
  'https://ahgiz-admin.vercel.app',
  'http://localhost:3000',
  'http://localhost:3998',
  process.env.CORS_ORIGIN,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(globalLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// Mounted at the root, outside /api/v1: this is Telegram's callback URL, not part of the
// public API surface. Its own secret-token check stands in front of it — see the route.
app.use('/telegram', telegramRoutes);

app.use('/api/v1', routes);

app.use(notFound);
app.use(sentry.captureErrors()); // capture errors in Sentry before the global handler
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`Ahgiz API running on port ${PORT} — environment: ${process.env.NODE_ENV}`);

  // Point Telegram at this deployment's webhook. Never throws and is never awaited: the API
  // must come up even if Telegram is unreachable — a bot that cannot be reached is a
  // degraded alarm, not a reason to refuse to serve.
  setWebhook();
});

module.exports = app;
