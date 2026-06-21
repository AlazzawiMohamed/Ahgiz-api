/**
 * Admin panel tests:
 *   GET  /api/v1/admin/dashboard
 *   GET  /api/v1/admin/users
 *   GET  /api/v1/admin/businesses
 *   PUT  /api/v1/admin/businesses/:id/approve
 *   PUT  /api/v1/admin/businesses/:id/suspend
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const jwt  = require('jsonwebtoken');
const http = require('http');

const BASE     = 'http://localhost:3000/api/v1';
const USER_ID  = '23248b21-60ef-4709-9071-0fd324509667';
const ADMIN_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const BIZ_ID   = 'aaa00002-0000-0000-0000-000000000002'; // use aaa00002 for approve/suspend (leaves aaa00001 intact)

const TOKEN = jwt.sign(
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
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

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
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function runTests() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  احجز API — Admin Panel Tests');
  console.log('═══════════════════════════════════════════════\n');

  // ══════════════════════════════════════════
  console.log('📊 GET /admin/dashboard');

  await test('401 without token', async () => {
    const r = await request('GET', '/admin/dashboard');
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('403 for non-admin user', async () => {
    const r = await request('GET', '/admin/dashboard', { token: TOKEN });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });

  await test('200 returns platform stats', async () => {
    const r = await request('GET', '/admin/dashboard', { token: ADMIN_TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const d = r.body.data;
    assert(d.stats,                              'missing stats');
    assert(d.stats.total_users !== undefined,    'missing total_users');
    assert(d.stats.active_businesses !== undefined, 'missing active_businesses');
    assert(d.stats.pending_approvals !== undefined,'missing pending_approvals');
    assert(d.stats.total_bookings !== undefined, 'missing total_bookings');
    assert(d.stats.total_revenue !== undefined,  'missing total_revenue');
    assert(Array.isArray(d.recent_users),        'missing recent_users');
    assert(Array.isArray(d.pending_businesses),  'missing pending_businesses');
  });

  await test('stats have correct types', async () => {
    const r = await request('GET', '/admin/dashboard', { token: ADMIN_TOKEN });
    const s = r.body.data.stats;
    for (const key of ['total_users','active_businesses','pending_approvals','total_bookings','total_revenue']) {
      assert(typeof s[key] === 'number', `${key} must be number, got ${typeof s[key]}`);
    }
  });

  // ══════════════════════════════════════════
  console.log('\n👥 GET /admin/users');

  await test('401 without token', async () => {
    const r = await request('GET', '/admin/users');
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('403 for non-admin', async () => {
    const r = await request('GET', '/admin/users', { token: TOKEN });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });

  await test('200 returns paginated users', async () => {
    const r = await request('GET', '/admin/users', { token: ADMIN_TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body.data.users),  'users must be array');
    assert(r.body.data.total > 0,             'total must be > 0');
    assert(r.body.data.page !== undefined,    'missing page');
  });

  await test('user records have required fields', async () => {
    const r = await request('GET', '/admin/users', { token: ADMIN_TOKEN });
    const u = r.body.data.users[0];
    assert(u.id,           'missing id');
    assert(u.role,         'missing role');
    assert(u.is_active !== undefined, 'missing is_active');
    assert(u.is_banned !== undefined, 'missing is_banned');
    assert(u.created_at,  'missing created_at');
  });

  await test('filter ?role=admin works', async () => {
    const r = await request('GET', '/admin/users?role=admin', { token: ADMIN_TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    r.body.data.users.forEach(u =>
      assert(u.role === 'admin', `Got non-admin user: ${u.role}`)
    );
  });

  await test('search ?q= filters by name/phone', async () => {
    const r = await request('GET', '/admin/users?q=مدير', { token: ADMIN_TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    // admin user has full_name containing "مدير"
    assert(r.body.data.users.length > 0, 'Expected ≥1 result for q=مدير');
  });

  await test('pagination respected', async () => {
    const r = await request('GET', '/admin/users?page=1&limit=1', { token: ADMIN_TOKEN });
    assert(r.body.data.users.length <= 1, 'limit not respected');
  });

  // ══════════════════════════════════════════
  console.log('\n🏪 GET /admin/businesses');

  await test('401 without token', async () => {
    const r = await request('GET', '/admin/businesses');
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('403 for non-admin', async () => {
    const r = await request('GET', '/admin/businesses', { token: TOKEN });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });

  await test('200 returns all businesses with owner join', async () => {
    const r = await request('GET', '/admin/businesses', { token: ADMIN_TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body.data.businesses), 'businesses must be array');
    assert(r.body.data.total >= 2,                'Expected ≥2 businesses');
    const b = r.body.data.businesses[0];
    assert(b.approval_status,   'missing approval_status');
    assert(b.owner,             'missing owner join');
    assert(b.categories,        'missing categories join');
  });

  await test('filter ?approval_status=approved', async () => {
    const r = await request('GET', '/admin/businesses?approval_status=approved', { token: ADMIN_TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    r.body.data.businesses.forEach(b =>
      assert(b.approval_status === 'approved', `Got status: ${b.approval_status}`)
    );
  });

  await test('search ?q= filters by name', async () => {
    const r = await request('GET', '/admin/businesses?q=باربر', { token: ADMIN_TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.data.businesses.length > 0, 'Expected results for q=باربر');
  });

  // ══════════════════════════════════════════
  console.log('\n✅ PUT /admin/businesses/:id/approve');

  // Suspend BIZ_ID first so we can approve it
  await request('PUT', `/admin/businesses/${BIZ_ID}/suspend`, {
    token: ADMIN_TOKEN,
    body: { reason: 'اختبار التعليق قبل الموافقة' },
  });

  await test('401 without token', async () => {
    const r = await request('PUT', `/admin/businesses/${BIZ_ID}/approve`);
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('403 for non-admin', async () => {
    const r = await request('PUT', `/admin/businesses/${BIZ_ID}/approve`, { token: TOKEN });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });

  await test('404 for non-existent business', async () => {
    const r = await request('PUT', '/admin/businesses/00000000-0000-0000-0000-000000000000/approve', {
      token: ADMIN_TOKEN,
    });
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('200 approves a suspended business', async () => {
    const r = await request('PUT', `/admin/businesses/${BIZ_ID}/approve`, { token: ADMIN_TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.approval_status === 'approved', `Expected approved, got ${r.body.data.approval_status}`);
    assert(r.body.data.is_active === true,              'Expected is_active=true');
  });

  await test('400 cannot approve already-approved business', async () => {
    const r = await request('PUT', `/admin/businesses/${BIZ_ID}/approve`, { token: ADMIN_TOKEN });
    assert(r.status === 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // ══════════════════════════════════════════
  console.log('\n🚫 PUT /admin/businesses/:id/suspend');

  await test('401 without token', async () => {
    const r = await request('PUT', `/admin/businesses/${BIZ_ID}/suspend`);
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('403 for non-admin', async () => {
    const r = await request('PUT', `/admin/businesses/${BIZ_ID}/suspend`, {
      token: TOKEN,
      body: { reason: 'test' },
    });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });

  await test('400 missing reason', async () => {
    const r = await request('PUT', `/admin/businesses/${BIZ_ID}/suspend`, { token: ADMIN_TOKEN, body: {} });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body.message?.includes('reason') || r.body.message?.includes('سبب'), `Expected reason error, got: ${r.body.message}`);
  });

  await test('404 for non-existent business', async () => {
    const r = await request('PUT', '/admin/businesses/00000000-0000-0000-0000-000000000000/suspend', {
      token: ADMIN_TOKEN,
      body: { reason: 'مخالفة السياسات' },
    });
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('200 suspends an approved business', async () => {
    const r = await request('PUT', `/admin/businesses/${BIZ_ID}/suspend`, {
      token: ADMIN_TOKEN,
      body: { reason: 'مخالفة شروط الخدمة' },
    });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.approval_status === 'suspended', `Expected suspended, got ${r.body.data.approval_status}`);
    assert(r.body.data.is_frozen === true,              'Expected is_frozen=true');
    assert(r.body.data.freeze_reason,                   'missing freeze_reason');
  });

  await test('400 cannot suspend already-suspended business', async () => {
    const r = await request('PUT', `/admin/businesses/${BIZ_ID}/suspend`, {
      token: ADMIN_TOKEN,
      body: { reason: 'محاولة تعليق مكررة' },
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  // Restore BIZ_ID to approved state for clean teardown
  await request('PUT', `/admin/businesses/${BIZ_ID}/approve`, { token: ADMIN_TOKEN });

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} ✅  |  ${failed} ❌`);
  console.log('═══════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
