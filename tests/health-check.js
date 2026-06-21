/**
 * احجز API — Comprehensive Health Check
 * Verifies every endpoint returns the expected HTTP status code.
 * Usage: node tests/health-check.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const jwt  = require('jsonwebtoken');
const http = require('http');

const BASE     = 'http://localhost:3000/api/v1';
const USER_ID  = '23248b21-60ef-4709-9071-0fd324509667';
const ADMIN_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const BIZ_ID   = 'aaa00001-0000-0000-0000-000000000001';
const SERVICE_ID = 'bbb00001-0000-0000-0000-000000000001';

const USER_TOKEN = jwt.sign(
  { id: USER_ID, role: 'business', type: 'access' },
  process.env.JWT_SECRET,
  { expiresIn: '15m' }
);
const ADMIN_TOKEN = jwt.sign(
  { id: ADMIN_ID, role: 'admin', type: 'access' },
  process.env.JWT_SECRET,
  { expiresIn: '15m' }
);

function request(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let passed = 0, failed = 0, total = 0;
const failures = [];

async function check(label, method, path, expectedStatus, opts = {}) {
  total++;
  try {
    const r = await request(method, path, opts);
    if (r.status === expectedStatus) {
      process.stdout.write('.');
      passed++;
    } else {
      process.stdout.write('F');
      failed++;
      failures.push({ label, expected: expectedStatus, got: r.status, body: r.body?.message || '' });
    }
  } catch (e) {
    process.stdout.write('E');
    failed++;
    failures.push({ label, expected: expectedStatus, got: 'ERROR', body: e.message });
  }
}

async function runHealthCheck() {
  const tomorrow = (() => {
    const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10);
  })();

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  احجز API — Health Check');
  console.log('══════════════════════════════════════════════════════\n');

  // ── System ────────────────────────────────────────────────────────────────
  process.stdout.write('System              : ');
  await check('health',              'GET',  '/health',                        200);
  console.log();

  // ── Auth ──────────────────────────────────────────────────────────────────
  process.stdout.write('Auth                : ');
  await check('send-otp missing body',    'POST', '/auth/send-otp',            400, { body: {} });
  await check('send-otp invalid phone',   'POST', '/auth/send-otp',            400, { body: { phone: '123' } });
  await check('verify-otp missing body',  'POST', '/auth/verify-otp',          400, { body: {} });
  await check('refresh missing body',     'POST', '/auth/refresh',             400, { body: {} });
  await check('logout needs auth',        'POST', '/auth/logout',              401);
  await check('me needs auth',            'GET',  '/auth/me',                  401);
  await check('me valid token',           'GET',  '/auth/me',                  200, { token: USER_TOKEN });
  console.log();

  // ── Categories / Governorates ─────────────────────────────────────────────
  process.stdout.write('Catalogue           : ');
  await check('categories',              'GET',  '/categories',               200);
  await check('governorates',            'GET',  '/governorates',             200);
  console.log();

  // ── Businesses ────────────────────────────────────────────────────────────
  process.stdout.write('Businesses          : ');
  await check('list all',               'GET',  '/businesses',                200);
  await check('list with q filter',     'GET',  '/businesses?q=صالون',        200);
  await check('list with province',     'GET',  '/businesses?province=baghdad', 200);
  await check('get by id',              'GET',  `/businesses/${BIZ_ID}`,      200);
  await check('get non-existent',       'GET',  '/businesses/00000000-0000-0000-0000-000000000000', 404);
  await check('get services',           'GET',  `/businesses/${BIZ_ID}/services`, 200);
  await check('get staff',              'GET',  `/businesses/${BIZ_ID}/staff`, 200);
  await check('availability no date',   'GET',  `/businesses/${BIZ_ID}/availability`, 400);
  await check('availability no svc',    'GET',  `/businesses/${BIZ_ID}/availability?date=${tomorrow}`, 400);
  await check('availability valid',     'GET',  `/businesses/${BIZ_ID}/availability?date=${tomorrow}&service_id=${SERVICE_ID}`, 200);
  console.log();

  // ── Bookings ──────────────────────────────────────────────────────────────
  process.stdout.write('Bookings            : ');
  await check('create needs auth',      'POST', '/bookings',                  401);
  await check('create missing fields',  'POST', '/bookings',                  400, { token: USER_TOKEN, body: {} });
  await check('get by id needs auth',   'GET',  '/bookings/00000000-0000-0000-0000-000000000001', 401);
  await check('cancel needs auth',      'PUT',  '/bookings/00000000-0000-0000-0000-000000000001/cancel', 401);
  await check('get non-existent',       'GET',  '/bookings/00000000-0000-0000-0000-000000000000', 401);
  console.log();

  // ── Users ─────────────────────────────────────────────────────────────────
  process.stdout.write('Users               : ');
  await check('profile needs auth',     'GET',  '/users/profile',             401);
  await check('profile valid',          'GET',  '/users/profile',             200, { token: USER_TOKEN });
  await check('update profile auth',    'PUT',  '/users/profile',             401);
  await check('update no fields',       'PUT',  '/users/profile',             400, { token: USER_TOKEN, body: { x: 1 } });
  await check('update valid',           'PUT',  '/users/profile',             200, { token: USER_TOKEN, body: { province: 'baghdad' } });
  await check('my bookings auth',       'GET',  '/users/bookings',            401);
  await check('my bookings valid',      'GET',  '/users/bookings',            200, { token: USER_TOKEN });
  console.log();

  // ── Reviews ───────────────────────────────────────────────────────────────
  process.stdout.write('Reviews             : ');
  await check('get by business',        'GET',  `/reviews/business/${BIZ_ID}`, 200);
  await check('create needs auth',      'POST', '/reviews',                   401);
  await check('create missing fields',  'POST', '/reviews',                   400, { token: USER_TOKEN, body: {} });
  await check('create invalid rating',  'POST', '/reviews',                   400, { token: USER_TOKEN, body: { booking_id: '00000000-0000-0000-0000-000000000001', business_rating: 9 } });
  console.log();

  // ── Notifications ─────────────────────────────────────────────────────────
  process.stdout.write('Notifications       : ');
  await check('send needs admin',       'POST', '/notifications/send',        401);
  await check('send non-admin 403',     'POST', '/notifications/send',        403, { token: USER_TOKEN, body: { user_id: USER_ID, type: 'booking_confirmed', message: 'x' } });
  await check('list needs auth',        'GET',  '/notifications',             401);
  await check('list valid',             'GET',  '/notifications',             200, { token: USER_TOKEN });
  await check('list unread filter',     'GET',  '/notifications?unread=true', 200, { token: USER_TOKEN });
  await check('read-all needs auth',    'PUT',  '/notifications/read-all',    401);
  await check('read-all valid',         'PUT',  '/notifications/read-all',    200, { token: USER_TOKEN });
  await check('read-one needs auth',    'PUT',  '/notifications/00000000-0000-0000-0000-000000000001/read', 401);
  await check('read-one not-found',     'PUT',  '/notifications/00000000-0000-0000-0000-000000000000/read', 404, { token: USER_TOKEN });
  console.log();

  // ── Favorites ─────────────────────────────────────────────────────────────
  process.stdout.write('Favorites           : ');
  await check('list needs auth',        'GET',  '/favorites',                 401);
  await check('list valid',             'GET',  '/favorites',                 200, { token: USER_TOKEN });
  await check('add needs auth',         'POST', `/favorites/${BIZ_ID}`,       401);
  await check('add invalid biz',        'POST', '/favorites/00000000-0000-0000-0000-000000000000', 404, { token: USER_TOKEN });
  await check('delete needs auth',      'DELETE',`/favorites/${BIZ_ID}`,      401);
  console.log();

  // ── Search ────────────────────────────────────────────────────────────────
  process.stdout.write('Search              : ');
  await check('no filters 400',         'GET',  '/search',                    400);
  await check('q filter',               'GET',  '/search?q=صالون',            200);
  await check('province filter',        'GET',  '/search?province=baghdad',   200);
  await check('category filter',        'GET',  '/search?category=beauty',    200);
  await check('bad category 404',       'GET',  '/search?category=xyz-bad',   404);
  console.log();

  // ── Owner Panel ───────────────────────────────────────────────────────────
  process.stdout.write('Owner Panel         : ');
  const OWN = (p) => `${p}?business_id=${BIZ_ID}`;
  await check('dashboard needs auth',   'GET',  OWN('/owner/dashboard'),       401);
  await check('dashboard non-biz 403',  'GET',  OWN('/owner/dashboard'),       403, { token: ADMIN_TOKEN });
  await check('dashboard valid',        'GET',  OWN('/owner/dashboard'),       200, { token: USER_TOKEN });
  await check('bookings needs auth',    'GET',  OWN('/owner/bookings'),        401);
  await check('bookings valid',         'GET',  OWN('/owner/bookings'),        200, { token: USER_TOKEN });
  await check('staff needs auth',       'GET',  OWN('/owner/staff'),           401);
  await check('staff valid',            'GET',  OWN('/owner/staff'),           200, { token: USER_TOKEN });
  await check('update biz needs auth',  'PUT',  OWN('/owner/business'),        401, { body: { bio: 'x' } });
  await check('update biz no fields',   'PUT',  OWN('/owner/business'),        400, { token: USER_TOKEN, body: { is_active: false } });
  await check('update biz valid',       'PUT',  OWN('/owner/business'),        200, { token: USER_TOKEN, body: { bio: 'صالون متخصص' } });
  await check('confirm needs auth',     'PUT',  OWN('/owner/bookings/00000000-0000-0000-0000-000000000000/confirm'), 401);
  await check('confirm not-found',      'PUT',  OWN('/owner/bookings/00000000-0000-0000-0000-000000000000/confirm'), 404, { token: USER_TOKEN });
  await check('complete needs auth',    'PUT',  OWN('/owner/bookings/00000000-0000-0000-0000-000000000000/complete'), 401);
  await check('no-show needs auth',     'PUT',  OWN('/owner/bookings/00000000-0000-0000-0000-000000000000/no-show'),  401);
  console.log();

  // ── Admin Panel ───────────────────────────────────────────────────────────
  process.stdout.write('Admin Panel         : ');
  await check('dashboard needs auth',   'GET',  '/admin/dashboard',            401);
  await check('dashboard non-admin 403','GET',  '/admin/dashboard',            403, { token: USER_TOKEN });
  await check('dashboard valid',        'GET',  '/admin/dashboard',            200, { token: ADMIN_TOKEN });
  await check('users needs auth',       'GET',  '/admin/users',               401);
  await check('users valid',            'GET',  '/admin/users',               200, { token: ADMIN_TOKEN });
  await check('biz list needs auth',    'GET',  '/admin/businesses',          401);
  await check('biz list valid',         'GET',  '/admin/businesses',          200, { token: ADMIN_TOKEN });
  await check('approve needs auth',     'PUT',  `/admin/businesses/${BIZ_ID}/approve`, 401);
  await check('approve non-admin 403',  'PUT',  `/admin/businesses/${BIZ_ID}/approve`, 403, { token: USER_TOKEN });
  await check('suspend needs auth',     'PUT',  `/admin/businesses/${BIZ_ID}/suspend`, 401);
  await check('suspend no reason 400',  'PUT',  `/admin/businesses/${BIZ_ID}/suspend`, 400, { token: ADMIN_TOKEN, body: {} });
  console.log();

  // ─── Results ──────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Total: ${total}  |  ✅ ${passed}  |  ❌ ${failed}`);
  console.log('══════════════════════════════════════════════════════');

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => {
      console.log(`  ❌ ${f.label}`);
      console.log(`     Expected ${f.expected}, got ${f.got}${f.body ? ` — ${f.body}` : ''}`);
    });
    console.log();
    process.exit(1);
  } else {
    console.log('\n  🎉 All endpoints healthy!\n');
  }
}

runHealthCheck().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
