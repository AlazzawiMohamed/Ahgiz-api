/**
 * Automated tests for Business Owner Panel:
 *   GET  /api/v1/owner/dashboard
 *   GET  /api/v1/owner/bookings
 *   PUT  /api/v1/owner/bookings/:id/confirm
 *   PUT  /api/v1/owner/bookings/:id/complete
 *   PUT  /api/v1/owner/bookings/:id/no-show
 *   GET  /api/v1/owner/staff
 *   PUT  /api/v1/owner/business
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const jwt  = require('jsonwebtoken');
const http = require('http');

const BASE       = 'http://localhost:3000/api/v1';
const USER_ID    = '23248b21-60ef-4709-9071-0fd324509667';
const ADMIN_ID   = 'aaaaaaaa-0000-0000-0000-000000000001';
const BIZ_ID     = 'aaa00001-0000-0000-0000-000000000001';
const SERVICE_ID = 'bbb00001-0000-0000-0000-000000000001';
const STAFF_ID   = 'ccc00001-0000-0000-0000-000000000001';

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

const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
})();

// Pin exact business via query param — avoids nondeterministic middleware ordering
const OWN = (path) => {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}business_id=${BIZ_ID}`;
};

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
const state = {};

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

async function createBooking(startTime) {
  const r = await request('POST', '/bookings', {
    token: TOKEN,
    body: {
      business_id:    BIZ_ID,
      service_id:     SERVICE_ID,
      staff_id:       STAFF_ID,
      booking_date:   TOMORROW,
      start_time:     startTime,
      payment_method: 'cash',
    },
  });
  if (r.status !== 201) throw new Error(`Booking creation failed [${r.status}]: ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}

async function runTests() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  احجز API — Business Owner Panel Tests');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('⚙️  Setup: creating test bookings...');
  try {
    // Spread bookings far apart so the 60-min service+0-buffer slots never overlap
    state.bookingForConfirm  = await createBooking('09:00:00');
    state.bookingForComplete = await createBooking('12:00:00');
    state.bookingForNoShow   = await createBooking('16:00:00');
    console.log(`  ✓ bookings: ${state.bookingForConfirm.slice(0,8)} | ${state.bookingForComplete.slice(0,8)} | ${state.bookingForNoShow.slice(0,8)}\n`);
  } catch (e) {
    console.log(`  ✗ Setup failed: ${e.message}\n`);
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════
  console.log('📊 GET /owner/dashboard');

  await test('401 without token', async () => {
    const r = await request('GET', OWN('/owner/dashboard'));
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('403 for non-business role', async () => {
    const r = await request('GET', OWN('/owner/dashboard'), { token: ADMIN_TOKEN });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });

  await test('200 returns full dashboard structure', async () => {
    const r = await request('GET', OWN('/owner/dashboard'), { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const d = r.body.data;
    assert(d.business?.id === BIZ_ID,          `wrong business: ${d.business?.id}`);
    assert(d.today?.date,                       'missing today.date');
    assert(d.today?.total !== undefined,        'missing today.total');
    assert(d.today?.revenue !== undefined,      'missing today.revenue');
    assert(Array.isArray(d.upcoming),           'upcoming must be array');
    assert(d.staff_count !== undefined,         'missing staff_count');
    assert(d.pending_total !== undefined,       'missing pending_total');
  });

  await test('today stats include all status keys', async () => {
    const r = await request('GET', OWN('/owner/dashboard'), { token: TOKEN });
    const t = r.body.data.today;
    for (const s of ['pending','confirmed','completed','cancelled','no_show']) {
      assert(t[s] !== undefined, `missing today.${s}`);
    }
  });

  await test('staff_count ≥ 1 (seeded data)', async () => {
    const r = await request('GET', OWN('/owner/dashboard'), { token: TOKEN });
    assert(r.body.data.staff_count >= 1, `Expected ≥1 staff, got ${r.body.data.staff_count}`);
  });

  // ══════════════════════════════════════════════════════
  console.log('\n📋 GET /owner/bookings');

  await test('401 without token', async () => {
    const r = await request('GET', OWN('/owner/bookings'));
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('200 returns paginated bookings', async () => {
    const r = await request('GET', OWN('/owner/bookings'), { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body.data.bookings), 'bookings must be array');
    assert(r.body.data.total > 0, 'total must be > 0');
  });

  await test('bookings join services + staff + customer', async () => {
    const r = await request('GET', OWN('/owner/bookings'), { token: TOKEN });
    const b = r.body.data.bookings.find(b => b.id === state.bookingForConfirm);
    assert(b,                       'created booking not in list');
    assert(b.services?.name,        'missing services join');
    assert(b.staff?.name,           'missing staff join');
    assert(b.customer !== undefined,'missing customer join');
  });

  await test('filter ?date= returns only that date', async () => {
    const r = await request('GET', OWN(`/owner/bookings?date=${TOMORROW}`), { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    r.body.data.bookings.forEach(b =>
      assert(b.booking_date === TOMORROW, `Wrong date: ${b.booking_date}`)
    );
  });

  await test('filter ?status=pending returns only pending', async () => {
    const r = await request('GET', OWN('/owner/bookings?status=pending'), { token: TOKEN });
    r.body.data.bookings.forEach(b =>
      assert(b.status === 'pending', `Non-pending: ${b.status}`)
    );
  });

  await test('pagination respected', async () => {
    const r = await request('GET', OWN('/owner/bookings?page=1&limit=2'), { token: TOKEN });
    assert(r.body.data.bookings.length <= 2, 'limit not respected');
    assert(r.body.data.total > 0,            'total should be > 0');
  });

  // ══════════════════════════════════════════════════════
  console.log('\n✅ PUT /owner/bookings/:id/confirm');

  await test('401 without token', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForConfirm}/confirm`));
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('404 for unknown booking', async () => {
    const r = await request('PUT', OWN('/owner/bookings/00000000-0000-0000-0000-000000000000/confirm'), { token: TOKEN });
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('200 confirms pending booking', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForConfirm}/confirm`), { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.status === 'confirmed', `Expected confirmed, got ${r.body.data.status}`);
  });

  await test('400 cannot re-confirm an already-confirmed booking', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForConfirm}/confirm`), { token: TOKEN });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  // ══════════════════════════════════════════════════════
  console.log('\n🏁 PUT /owner/bookings/:id/complete');

  // Pre-confirm bookingForComplete
  await request('PUT', OWN(`/owner/bookings/${state.bookingForComplete}/confirm`), { token: TOKEN });

  await test('401 without token', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForComplete}/complete`));
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('400 cannot complete a still-pending booking', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForNoShow}/complete`), { token: TOKEN });
    assert(r.status === 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('200 completes a confirmed booking', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForComplete}/complete`), { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.status === 'completed', `Expected completed, got ${r.body.data.status}`);
  });

  await test('400 cannot complete an already-completed booking', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForComplete}/complete`), { token: TOKEN });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  // ══════════════════════════════════════════════════════
  console.log('\n🚫 PUT /owner/bookings/:id/no-show');

  // Pre-confirm bookingForNoShow
  await request('PUT', OWN(`/owner/bookings/${state.bookingForNoShow}/confirm`), { token: TOKEN });

  await test('401 without token', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForNoShow}/no-show`));
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('200 marks confirmed booking as no-show', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForNoShow}/no-show`), { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.status === 'no_show', `Expected no_show, got ${r.body.data.status}`);
  });

  await test('400 cannot re-flag already no-show booking', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForNoShow}/no-show`), { token: TOKEN });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('400 cannot no-show a completed booking', async () => {
    const r = await request('PUT', OWN(`/owner/bookings/${state.bookingForComplete}/no-show`), { token: TOKEN });
    assert(r.status === 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // ══════════════════════════════════════════════════════
  console.log('\n👥 GET /owner/staff');

  await test('401 without token', async () => {
    const r = await request('GET', OWN('/owner/staff'));
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('403 for non-business role', async () => {
    const r = await request('GET', OWN('/owner/staff'), { token: ADMIN_TOKEN });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });

  await test('200 returns all staff', async () => {
    const r = await request('GET', OWN('/owner/staff'), { token: TOKEN });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body.data), 'data must be array');
    assert(r.body.data.length >= 1,    'Expected ≥1 staff member');
  });

  await test('staff includes management fields', async () => {
    const r = await request('GET', OWN('/owner/staff'), { token: TOKEN });
    const s = r.body.data[0];
    assert(s.id,                      'missing id');
    assert(s.name,                    'missing name');
    assert(s.is_active !== undefined, 'missing is_active');
    assert(s.rating_avg !== undefined,'missing rating_avg');
    assert(s.sort_order !== undefined,'missing sort_order');
  });

  // ══════════════════════════════════════════════════════
  console.log('\n🏪 PUT /owner/business');

  await test('401 without token', async () => {
    const r = await request('PUT', OWN('/owner/business'), { body: { bio: 'test' } });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('403 for non-business role', async () => {
    const r = await request('PUT', OWN('/owner/business'), { token: ADMIN_TOKEN, body: { bio: 'test' } });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });

  await test('400 when only protected fields sent', async () => {
    const r = await request('PUT', OWN('/owner/business'), {
      token: TOKEN,
      body: { is_active: false, approval_status: 'rejected', is_featured: true },
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body.message?.includes('لا توجد'), `Expected Arabic error, got: ${r.body.message}`);
  });

  await test('400 invalid booking_confirmation value', async () => {
    const r = await request('PUT', OWN('/owner/business'), {
      token: TOKEN,
      body: { booking_confirmation: 'instant' },
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('200 updates bio and address', async () => {
    const r = await request('PUT', OWN('/owner/business'), {
      token: TOKEN,
      body: { bio: 'صالون متخصص في التجميل النسائي', address: 'شارع حيفا، بغداد' },
    });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.id === BIZ_ID,             'wrong business id in response');
    assert(r.body.data.bio === 'صالون متخصص في التجميل النسائي', 'bio not updated');
  });

  await test('200 updates booking settings', async () => {
    const r = await request('PUT', OWN('/owner/business'), {
      token: TOKEN,
      body: { booking_confirmation: 'auto', cancellation_hours: 24 },
    });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data.booking_confirmation === 'auto', 'booking_confirmation not updated');
    assert(r.body.data.cancellation_hours === 24,       'cancellation_hours not updated');
  });

  await test('protected fields are silently ignored', async () => {
    const before = await request('GET', `/businesses/${BIZ_ID}`);
    const wasActive = before.body.data?.is_active;

    await request('PUT', OWN('/owner/business'), {
      token: TOKEN,
      body: { waitlist_enabled: true, is_active: false, approval_status: 'rejected' },
    });

    const after = await request('GET', `/businesses/${BIZ_ID}`);
    assert(
      after.body.data?.is_active === true,
      `is_active changed! before: ${wasActive}, after: ${after.body.data?.is_active}`
    );
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Results: ${passed} ✅  |  ${failed} ❌`);
  console.log('═══════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
