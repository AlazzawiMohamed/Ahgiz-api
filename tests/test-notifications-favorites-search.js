/**
 * Automated tests for:
 *   POST /api/v1/notifications/send
 *   GET  /api/v1/notifications
 *   PUT  /api/v1/notifications/read-all
 *   PUT  /api/v1/notifications/:id/read
 *   POST /api/v1/favorites/:business_id
 *   DELETE /api/v1/favorites/:business_id
 *   GET  /api/v1/favorites
 *   GET  /api/v1/search
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const jwt  = require('jsonwebtoken');
const http = require('http');

const BASE     = 'http://localhost:3000/api/v1';
const USER_ID   = '23248b21-60ef-4709-9071-0fd324509667';
const ADMIN_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const BIZ_ID    = 'aaa00001-0000-0000-0000-000000000001';
const BIZ_ID2   = 'aaa00002-0000-0000-0000-000000000002';

const TOKEN = jwt.sign(
  { id: USER_ID, role: 'business', type: 'access' },
  process.env.JWT_SECRET,
  { expiresIn: '10m' }
);
// Admin token uses the real admin user ID — authenticate will pull role='admin' from DB
const ADMIN_TOKEN = jwt.sign(
  { id: ADMIN_ID, role: 'admin', type: 'access' },
  process.env.JWT_SECRET,
  { expiresIn: '10m' }
);

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

let passed = 0, failed = 0;
const state = {};  // shared state across tests

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
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function runTests() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  احجز API — Notifications / Favorites / Search Tests');
  console.log('═══════════════════════════════════════════════════════\n');

  // ══════════════════════════════════════════════════════
  // 1. POST /notifications/send
  // ══════════════════════════════════════════════════════
  console.log('📬 POST /notifications/send');

  await test('401 without token', async () => {
    const r = await request('POST', '/notifications/send', {
      body: { user_id: USER_ID, type: 'booking_confirmed', message: 'test' },
    });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('403 for non-admin user', async () => {
    const r = await request('POST', '/notifications/send', {
      token: TOKEN,
      body: { user_id: USER_ID, type: 'booking_confirmed', message: 'test' },
    });
    assert(r.status === 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('400 missing user_id', async () => {
    const r = await request('POST', '/notifications/send', {
      token: ADMIN_TOKEN,
      body: { type: 'booking_confirmed', message: 'رسالة اختبار' },
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body.message.includes('user_id'), `Expected Arabic error, got: ${r.body.message}`);
  });

  await test('400 invalid type', async () => {
    const r = await request('POST', '/notifications/send', {
      token: ADMIN_TOKEN,
      body: { user_id: USER_ID, type: 'invalid_type', message: 'test' },
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('201 admin sends valid notification', async () => {
    const r = await request('POST', '/notifications/send', {
      token: ADMIN_TOKEN,
      body: {
        user_id: USER_ID,
        type: 'booking_confirmed',
        message: 'تم تأكيد حجزك بنجاح',
        channel: 'in_app',
        priority: 'normal',
      },
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.id, 'missing notification id');
    assert(r.body.data.status === 'pending', 'Expected status=pending');
    state.notifId = r.body.data.id;
  });

  await test('201 second notification for read-all test', async () => {
    const r = await request('POST', '/notifications/send', {
      token: ADMIN_TOKEN,
      body: {
        user_id: USER_ID,
        type: 'review_request',
        message: 'كيف كانت تجربتك؟',
        channel: 'in_app',
      },
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    state.notifId2 = r.body.data.id;
  });

  // ══════════════════════════════════════════════════════
  // 2. GET /notifications
  // ══════════════════════════════════════════════════════
  console.log('\n📋 GET /notifications');

  await test('401 without token', async () => {
    const r = await request('GET', '/notifications');
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('200 returns notifications array', async () => {
    const r = await request('GET', '/notifications', { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body.data.notifications), 'notifications is not array');
    assert(r.body.data.total !== undefined, 'missing total');
  });

  await test('created notifications appear in list', async () => {
    const r = await request('GET', '/notifications', { token: TOKEN });
    const ids = r.body.data.notifications.map(n => n.id);
    assert(ids.includes(state.notifId), `notifId ${state.notifId} not found in list`);
  });

  await test('unread=true filter returns only unread', async () => {
    const r = await request('GET', '/notifications?unread=true', { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const hasRead = r.body.data.notifications.some(n => n.read_at !== null);
    assert(!hasRead, 'unread filter returned notifications with read_at set');
  });

  // ══════════════════════════════════════════════════════
  // 3. PUT /notifications/:id/read
  // ══════════════════════════════════════════════════════
  console.log('\n👁️  PUT /notifications/:id/read');

  await test('401 without token', async () => {
    const r = await request('PUT', `/notifications/${state.notifId}/read`);
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('404 for non-existent notification', async () => {
    const r = await request('PUT', '/notifications/00000000-0000-0000-0000-000000000000/read', {
      token: TOKEN,
    });
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('200 marks notification as read', async () => {
    const r = await request('PUT', `/notifications/${state.notifId}/read`, { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.read_at !== null, 'read_at should be set');
  });

  await test('200 idempotent — re-reading already-read notification', async () => {
    const r = await request('PUT', `/notifications/${state.notifId}/read`, { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // ══════════════════════════════════════════════════════
  // 4. PUT /notifications/read-all
  // ══════════════════════════════════════════════════════
  console.log('\n✅ PUT /notifications/read-all');

  await test('401 without token', async () => {
    const r = await request('PUT', '/notifications/read-all');
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('200 marks all unread as read', async () => {
    const r = await request('PUT', '/notifications/read-all', { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.updated !== undefined, 'missing updated count');
  });

  await test('all notifications now read', async () => {
    const r = await request('GET', '/notifications?unread=true', { token: TOKEN });
    assert(r.body.data.notifications.length === 0, 'Expected 0 unread after read-all');
  });

  // ══════════════════════════════════════════════════════
  // 5. POST /favorites/:business_id
  // ══════════════════════════════════════════════════════
  console.log('\n❤️  POST /favorites/:business_id');

  await test('401 without token', async () => {
    const r = await request('POST', `/favorites/${BIZ_ID}`);
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('404 for non-existent business', async () => {
    const r = await request('POST', '/favorites/00000000-0000-0000-0000-000000000000', {
      token: TOKEN,
    });
    assert(r.status === 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // Clean up first in case it exists from previous test run
  await request('DELETE', `/favorites/${BIZ_ID}`,  { token: TOKEN });
  await request('DELETE', `/favorites/${BIZ_ID2}`, { token: TOKEN });

  await test('201 adds business to favorites', async () => {
    const r = await request('POST', `/favorites/${BIZ_ID}`, { token: TOKEN });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.business_id === BIZ_ID, 'wrong business_id');
  });

  await test('409 duplicate favorite', async () => {
    const r = await request('POST', `/favorites/${BIZ_ID}`, { token: TOKEN });
    assert(r.status === 409, `Expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.message.includes('موجود'), `Expected Arabic duplicate error, got: ${r.body.message}`);
  });

  await test('201 add second favorite', async () => {
    const r = await request('POST', `/favorites/${BIZ_ID2}`, { token: TOKEN });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // ══════════════════════════════════════════════════════
  // 6. GET /favorites
  // ══════════════════════════════════════════════════════
  console.log('\n📋 GET /favorites');

  await test('401 without token', async () => {
    const r = await request('GET', '/favorites');
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('200 returns favorites list with business info', async () => {
    const r = await request('GET', '/favorites', { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body.data.favorites), 'favorites is not array');
    assert(r.body.data.favorites.length >= 2, `Expected ≥2 favorites, got ${r.body.data.favorites.length}`);
  });

  await test('business details present in favorites', async () => {
    const r = await request('GET', '/favorites', { token: TOKEN });
    const fav = r.body.data.favorites[0];
    assert(fav.businesses,                'missing businesses join');
    assert(fav.businesses.id,             'missing businesses.id');
    assert(fav.businesses.name,           'missing businesses.name');
    assert(fav.businesses.categories,     'missing categories join');
  });

  await test('pagination respected', async () => {
    const r = await request('GET', '/favorites?page=1&limit=1', { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.data.favorites.length <= 1, 'limit not respected');
    assert(r.body.data.total >= 2, 'total should reflect all favorites');
  });

  // ══════════════════════════════════════════════════════
  // 7. DELETE /favorites/:business_id
  // ══════════════════════════════════════════════════════
  console.log('\n🗑️  DELETE /favorites/:business_id');

  await test('401 without token', async () => {
    const r = await request('DELETE', `/favorites/${BIZ_ID}`);
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('404 for non-favorite business', async () => {
    const r = await request('DELETE', '/favorites/00000000-0000-0000-0000-000000000999', {
      token: TOKEN,
    });
    assert(r.status === 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('200 removes favorite', async () => {
    const r = await request('DELETE', `/favorites/${BIZ_ID}`, { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.message.includes('إزالة') || r.body.message.includes('تمت'), `Expected Arabic msg, got: ${r.body.message}`);
  });

  await test('404 on repeated delete', async () => {
    const r = await request('DELETE', `/favorites/${BIZ_ID}`, { token: TOKEN });
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  // Cleanup second favorite
  await request('DELETE', `/favorites/${BIZ_ID2}`, { token: TOKEN });

  // ══════════════════════════════════════════════════════
  // 8. GET /search
  // ══════════════════════════════════════════════════════
  console.log('\n🔍 GET /search');

  await test('400 without any filter', async () => {
    const r = await request('GET', '/search');
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    const msg = r.body.message;
    assert(msg && msg.includes('معيار'), `Expected Arabic guidance msg, got: ${msg}`);
  });

  await test('200 search by q', async () => {
    const r = await request('GET', '/search?q=صالون');
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body.data.results), 'results is not array');
    assert(r.body.data.results.length > 0, 'expected results for q=صالون');
  });

  await test('results contain required fields', async () => {
    const r = await request('GET', '/search?q=صالون');
    const biz = r.body.data.results[0];
    assert(biz.id,          'missing id');
    assert(biz.name,        'missing name');
    assert(biz.categories,  'missing categories');
  });

  await test('200 search by province', async () => {
    const r = await request('GET', '/search?province=baghdad');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.data.results.length > 0, 'expected results for province=baghdad');
    r.body.data.results.forEach(b => {
      assert(b.province === 'baghdad', `Got non-baghdad result: ${b.province}`);
    });
  });

  await test('200 search by category slug', async () => {
    const r = await request('GET', '/search?category=beauty');
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body.data.results), 'results not array');
  });

  await test('404 for unknown category slug', async () => {
    const r = await request('GET', '/search?category=does-not-exist-xyz');
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('no auth required for search', async () => {
    const r = await request('GET', '/search?province=baghdad');
    assert(r.status === 200, `Expected 200 without token, got ${r.status}`);
  });

  await test('pagination works in search', async () => {
    const r = await request('GET', '/search?province=baghdad&page=1&limit=1');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.data.results.length <= 1, 'limit not respected');
    assert(r.body.data.page === 1, 'wrong page');
  });

  await test('combined filters (q + province)', async () => {
    const r = await request('GET', '/search?q=صالون&province=baghdad');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} ✅  |  ${failed} ❌`);
  console.log('═══════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
