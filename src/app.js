require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const sentry = require('./utils/sentry');
const routes = require('./routes/index');
const fs = require('fs');

if (!fs.existsSync('logs')) fs.mkdirSync('logs');

// تهيئة Sentry مبكراً (no-op بدون SENTRY_DSN أو بدون الحزمة)
sentry.init();

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 100 : 1000,
  message: { status: 'error', message: 'طلبات كثيرة جداً، حاول لاحقاً' },
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

app.use('/api/v1', routes);

app.use(notFound);
app.use(sentry.captureErrors()); // التقاط الأخطاء في Sentry قبل المعالج العام
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`احجز API يعمل على المنفذ ${PORT} — البيئة: ${process.env.NODE_ENV}`);
});

module.exports = app;
