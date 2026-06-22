const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');
const { getAvailableSlots } = require('../services/availability.service');

// ─── GET /businesses ──────────────────────────────────────────────────────────
// Direct query — search_businesses RPC has a SQLERRM bug in its EXCEPTION block
exports.getAll = async (req, res, next) => {
  try {
    const {
      q, category, province,
      rating_min, plan,
      page = 1, limit = 20,
    } = req.query;

    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('businesses')
      .select(`
        id, name, province, address, logo_url, cover_url,
        rating_avg, rating_count, is_featured, current_plan_code,
        categories ( id, slug, name_ar, name_en, icon_url )
      `, { count: 'exact' })
      .eq('is_active', true)
      .eq('is_frozen', false)
      .eq('approval_status', 'approved')
      .order('is_featured', { ascending: false })
      .order('rating_avg',  { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (q)          query = query.ilike('name', `%${q}%`);
    if (province)   query = query.eq('province', province);
    if (plan)       query = query.eq('current_plan_code', plan);
    if (rating_min) query = query.gte('rating_avg', parseFloat(rating_min));

    // category filter via foreign table
    if (category) {
      const { data: cat } = await supabaseAdmin
        .from('categories')
        .select('id')
        .eq('slug', category)
        .single();
      if (cat) query = query.eq('category_id', cat.id);
    }

    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;

    return success(res, {
      businesses: data,
      total: count,
      page:  +page,
      limit: +limit,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /businesses/popular?province=&limit= ─────────────────────────────────
// Ranked by booking count over the last 7 days; falls back to featured/top-rated.
const POPULAR_SELECT = `
  id, name, province, address, logo_url, cover_url,
  rating_avg, rating_count, is_featured, current_plan_code,
  categories ( id, slug, name_ar, name_en, icon_url )
`;

exports.getPopular = async (req, res, next) => {
  try {
    const { province } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    // Count recent bookings per business
    const { data: recent, error: bErr } = await supabaseAdmin
      .from('bookings')
      .select('business_id')
      .gte('booking_date', weekAgo);
    if (bErr) throw bErr;

    const counts = {};
    for (const r of recent || []) {
      if (r.business_id) counts[r.business_id] = (counts[r.business_id] || 0) + 1;
    }
    const rankedIds = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

    const baseFilter = (qb) => qb
      .eq('is_active', true)
      .eq('is_frozen', false)
      .eq('approval_status', 'approved');

    let businesses = [];
    if (rankedIds.length) {
      let q = baseFilter(
        supabaseAdmin.from('businesses').select(POPULAR_SELECT)
          .in('id', rankedIds.slice(0, limit * 2))
      );
      if (province) q = q.eq('province', province);
      const { data, error: e2 } = await q;
      if (e2) throw e2;
      businesses = (data || []).sort((a, b) => counts[b.id] - counts[a.id]).slice(0, limit);
    }

    // Fallback fill so the section is never empty
    if (businesses.length < limit) {
      const exclude = businesses.map((b) => b.id);
      let q = baseFilter(supabaseAdmin.from('businesses').select(POPULAR_SELECT))
        .order('is_featured', { ascending: false })
        .order('rating_avg', { ascending: false })
        .limit(limit + exclude.length);
      if (province) q = q.eq('province', province);
      const { data: fill } = await q;
      for (const b of fill || []) {
        if (businesses.length >= limit) break;
        if (!exclude.includes(b.id)) businesses.push(b);
      }
    }

    return success(res, { businesses, total: businesses.length });
  } catch (err) {
    next(err);
  }
};

// ─── GET /businesses/feed?province=&limit= (auth) ─────────────────────────────
// Personalized feed from existing data: ranks businesses in the categories the
// user has booked before first, then featured/top-rated. No preference tables needed.
exports.getFeed = async (req, res, next) => {
  try {
    const province = req.query.province || null;
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);

    // 1) preferred category ids inferred from the user's booking history
    const { data: hist } = await supabaseAdmin
      .from('bookings')
      .select('businesses ( category_id )')
      .eq('customer_id', req.user.id)
      .limit(50);
    const preferred = new Set((hist || []).map(h => h.businesses?.category_id).filter(Boolean));

    // 2) candidate pool (already ordered by featured + rating)
    let q = supabaseAdmin
      .from('businesses')
      .select(`
        id, name, province, address, logo_url, cover_url,
        rating_avg, rating_count, is_featured, current_plan_code, category_id,
        categories ( id, slug, name_ar, name_en, icon_url )
      `)
      .eq('is_active', true)
      .eq('is_frozen', false)
      .eq('approval_status', 'approved')
      .order('is_featured', { ascending: false })
      .order('rating_avg', { ascending: false })
      .limit(50);
    if (province) q = q.eq('province', province);

    const { data: pool, error: dbErr } = await q;
    if (dbErr) throw dbErr;

    // 3) stable rank: preferred-category businesses first, keep featured/rating order within
    const ranked = (pool || [])
      .map((b, i) => ({ b, i, pref: preferred.has(b.category_id) ? 1 : 0 }))
      .sort((x, y) => (y.pref - x.pref) || (x.i - y.i))
      .slice(0, limit)
      .map(({ b }) => { const { category_id, ...rest } = b; return rest; });

    return success(res, { businesses: ranked, personalized: preferred.size > 0 });
  } catch (err) {
    next(err);
  }
};

// ─── GET /businesses/:id ──────────────────────────────────────────────────────
exports.getById = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('businesses')
      .select(`
        id, name, description, bio, specialty,
        phone, whatsapp, address, province, maps_url,
        logo_url, cover_url,
        rating_avg, rating_count,
        booking_confirmation, cancellation_hours,
        instagram_url, tiktok_url, facebook_url, short_link,
        is_active, is_verified, is_featured, current_plan_code,
        categories ( id, name_ar, name_en, slug, icon_url ),
        working_hours ( day_of_week, start_time, end_time, is_closed, break_start, break_end )
      `)
      .eq('id', req.params.id)
      .eq('is_active', true)
      .eq('is_frozen', false)
      .single();

    if (dbErr || !data) return error(res, 'المحل غير موجود أو غير نشط', 404);

    return success(res, data);
  } catch (err) {
    next(err);
  }
};

// ─── GET /businesses/:id/services ─────────────────────────────────────────────
exports.getServices = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('services')
      .select('id, name, description, duration, price, category_name, buffer_minutes, allows_recurring, sort_order')
      .eq('business_id', req.params.id)
      .eq('is_active', true)
      .eq('is_addon', false)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (dbErr) throw dbErr;
    return success(res, data);
  } catch (err) {
    next(err);
  }
};

// ─── GET /businesses/:id/staff ────────────────────────────────────────────────
exports.getStaff = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('staff')
      .select('id, name, photo_url, bio, rating_avg, rating_count, sort_order, instagram_url, tiktok_url')
      .eq('business_id', req.params.id)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (dbErr) throw dbErr;
    return success(res, data);
  } catch (err) {
    next(err);
  }
};

// ─── GET /businesses/:id/availability?date=&service_id=&staff_id= ─────────────
// Wraps get_available_slots RPC — returns only free time slots
exports.getAvailability = async (req, res, next) => {
  try {
    const { date, service_id, staff_id, slot_interval = '30' } = req.query;

    if (!date)       return error(res, 'date مطلوب (YYYY-MM-DD)', 400);
    if (!service_id) return error(res, 'service_id مطلوب', 400);

    if (isNaN(Date.parse(date))) return error(res, 'تنسيق التاريخ غير صحيح', 400);
    if (new Date(date) < new Date(new Date().toDateString())) {
      return error(res, 'لا يمكن عرض مواعيد في الماضي', 400);
    }

    // Fetch service to validate it belongs to this business and get duration
    const { data: service, error: svcErr } = await supabaseAdmin
      .from('services')
      .select('id, duration, buffer_minutes')
      .eq('id', service_id)
      .eq('business_id', req.params.id)
      .eq('is_active', true)
      .single();

    if (svcErr || !service) return error(res, 'الخدمة غير موجودة أو لا تنتمي لهذا المحل', 404);

    // Resolve staff_id — use provided or pick first active staff member
    let resolvedStaffId = staff_id || null;
    if (!resolvedStaffId) {
      const { data: firstStaff } = await supabaseAdmin
        .from('staff')
        .select('id')
        .eq('business_id', req.params.id)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .limit(1)
        .single();

      resolvedStaffId = firstStaff?.id || null;
    }

    const totalDuration = service.duration + (service.buffer_minutes || 0);

    const slots = await getAvailableSlots({
      businessId:       req.params.id,
      staffId:          resolvedStaffId,
      date,
      durationMins:     totalDuration,
      slotIntervalMins: parseInt(slot_interval),
    });

    // Return ALL slots (free + booked) — C08 shows booked ones struck-through (approved decision)
    const allSlots = slots.map(s => ({ ...s, is_booked: !s.is_free }));

    return success(res, {
      date,
      service_id,
      staff_id:   resolvedStaffId,
      duration:   service.duration,
      slots:      allSlots,
      total:      allSlots.length,
      available:  allSlots.filter(s => !s.is_booked).length,
    });
  } catch (err) {
    next(err);
  }
};
