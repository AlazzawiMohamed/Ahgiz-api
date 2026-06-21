/**
 * Automated tests for:
 *   GET  /api/v1/categories
 *   GET  /api/v1/governorates
 *   GET  /api/v1/users/profile
 *   PUT  /api/v1/users/profile
 *   GET  /api/v1/reviews/business/:id
 *   POST /api/v1/reviews
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const jwt  = require('jsonwebtoken');
const http = require('http');

const BASE  = 'http://localhost:3000/api/v1';
const BIZ_ID = 'aaa00001-0000-0000-0000-000000000001';
const USER_ID = '23248b21-60ef-4709-9071-0fd324509667';

// Sign a short-lived access token for the test user
const TOKEN = jwt.sign(
  { id: USER_ID, role: 'business', type: 'access' },
  process.env.JWT_SECRET,
  { expiresIn: '5m' }
);

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(BASE + path, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${label}`);
    console.log(`     → ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// ─── Test suites ──────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  احجز API — Endpoint Tests');
  console.log('═══════════════════════════════════════════\n');

  // ── GET /categories ──────────────────────────────────────────────────────
  console.log('📁 GET /categories');

  await test('200 + returns array', async () => {
    const r = await request('GET', '/categories');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.status === 'success', 'status !== success');
    assert(Array.isArray(r.body.data), 'data is not an array');
    assert(r.body.data.length > 0, 'categories array is empty');
  });

  await test('each category has id, slug, name_ar', async () => {
    const r = await request('GET', '/categories');
    const cat = r.body.data[0];
    assert(cat.id,      'missing id');
    assert(cat.slug,    'missing slug');
    assert(cat.name_ar, 'missing name_ar');
  });

  await test('no auth required', async () => {
    const r = await request('GET', '/categories');
    assert(r.status === 200, `Expected 200 without token, got ${r.status}`);
  });

  // ── GET /governorates ────────────────────────────────────────────────────
  console.log('\n📁 GET /governorates');

  await test('200 + returns array', async () => {
    const r = await request('GET', '/governorates');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(Array.isArray(r.body.data), 'data is not an array');
    assert(r.body.data.length >= 18, `Expected ≥18 governorates, got ${r.body.data.length}`);
  });

  await test('each governorate has id, slug, name_ar', async () => {
    const r = await request('GET', '/governorates');
    const gov = r.body.data[0];
    assert(gov.id,      'missing id');
    assert(gov.slug,    'missing slug');
    assert(gov.name_ar, 'missing name_ar');
  });

  await test('no auth required', async () => {
    const r = await request('GET', '/governorates');
    assert(r.status === 200, `Expected 200 without token, got ${r.status}`);
  });

  // ── GET /users/profile ───────────────────────────────────────────────────
  console.log('\n📁 GET /users/profile');

  await test('401 without token', async () => {
    const r = await request('GET', '/users/profile');
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('200 with valid token', async () => {
    const r = await request('GET', '/users/profile', { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.status === 'success', 'status !== success');
    assert(r.body.data.id === USER_ID, 'wrong user id');
  });

  await test('response has full_name, phone, role', async () => {
    const r = await request('GET', '/users/profile', { token: TOKEN });
    const u = r.body.data;
    assert(u.full_name !== undefined, 'missing full_name');
    assert(u.phone     !== undefined, 'missing phone');
    assert(u.role      !== undefined, 'missing role');
  });

  // ── PUT /users/profile ───────────────────────────────────────────────────
  console.log('\n📁 PUT /users/profile');

  await test('401 without token', async () => {
    const r = await request('PUT', '/users/profile', { body: { full_name: 'test' } });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('400 with no valid fields', async () => {
    const r = await request('PUT', '/users/profile', {
      token: TOKEN,
      body: { not_a_field: 'xyz' },
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body.message.includes('لا توجد'), `Expected Arabic error, got: ${r.body.message}`);
  });

  await test('200 updates full_name', async () => {
    const r = await request('PUT', '/users/profile', {
      token: TOKEN,
      body: { full_name: 'مستخدم تجريبي' },
    });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.full_name === 'مستخدم تجريبي', 'full_name not updated');
  });

  await test('200 updates province', async () => {
    const r = await request('PUT', '/users/profile', {
      token: TOKEN,
      body: { province: 'baghdad' },
    });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.province === 'baghdad', 'province not updated');
  });

  // ── GET /reviews/business/:id ────────────────────────────────────────────
  console.log('\n📁 GET /reviews/business/:id');

  await test('200 returns paginated reviews object', async () => {
    const r = await request('GET', `/reviews/business/${BIZ_ID}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.status === 'success', 'status !== success');
    assert(Array.isArray(r.body.data.reviews), 'data.reviews is not array');
    assert(r.body.data.total !== undefined, 'missing total');
  });

  await test('no auth required', async () => {
    const r = await request('GET', `/reviews/business/${BIZ_ID}`);
    assert(r.status === 200, `Expected 200 without token, got ${r.status}`);
  });

  await test('pagination params respected', async () => {
    const r = await request('GET', `/reviews/business/${BIZ_ID}?page=1&limit=5`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.data.page === 1,  'wrong page');
    assert(r.body.data.limit === 5, 'wrong limit');
  });

  // ── POST /reviews ────────────────────────────────────────────────────────
  console.log('\n📁 POST /reviews');

  await test('401 without token', async () => {
    const r = await request('POST', '/reviews', {
      body: { booking_id: '00000000-0000-0000-0000-000000000000', business_rating: 5 },
    });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('400 missing booking_id', async () => {
    const r = await request('POST', '/reviews', {
      token: TOKEN,
      body: { business_rating: 5 },
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body.message.includes('booking_id'), `Expected Arabic error, got: ${r.body.message}`);
  });

  await test('400 missing business_rating', async () => {
    const r = await request('POST', '/reviews', {
      token: TOKEN,
      body: { booking_id: '00000000-0000-0000-0000-000000000000' },
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body.message.includes('business_rating'), `Expected Arabic error, got: ${r.body.message}`);
  });

  await test('400 invalid business_rating (out of range)', async () => {
    const r = await request('POST', '/reviews', {
      token: TOKEN,
      body: { booking_id: '00000000-0000-0000-0000-000000000000', business_rating: 6 },
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body.message.includes('1') && r.body.message.includes('5'),
      `Expected 1-5 range error, got: ${r.body.message}`);
  });

  await test('404 Arabic error for non-existent/non-completed booking', async () => {
    const r = await request('POST', '/reviews', {
      token: TOKEN,
      body: {
        booking_id: '00000000-0000-0000-0000-000000000001',
        business_rating: 5,
        business_comment: 'ممتاز',
      },
    });
    assert(r.status === 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.message && r.body.message.length > 0, 'Expected Arabic error message');
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} ✅  |  ${failed} ❌`);
  console.log('═══════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
