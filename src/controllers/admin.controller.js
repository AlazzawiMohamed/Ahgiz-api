const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// ─── GET /admin/dashboard ─────────────────────────────────────────────────────
exports.getDashboard = async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [
      { count: totalUsers },
      { count: activeBusinesses },
      { count: pendingApprovals },
      { count: totalBookings },
      { count: todayBookings },
      { data: revenueRows },
      { data: recentUsers },
      { data: pendingBizList },
    ] = await Promise.all([
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabaseAdmin.from('businesses').select('id', { count: 'exact', head: true }).eq('is_active', true).eq('approval_status', 'approved'),
      supabaseAdmin.from('businesses').select('id', { count: 'exact', head: true }).eq('approval_status', 'pending'),
      supabaseAdmin.from('bookings').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('bookings').select('id', { count: 'exact', head: true }).eq('booking_date', today),
      supabaseAdmin.from('bookings').select('price').eq('status', 'completed'),
      supabaseAdmin.from('users').select('id, full_name, role, phone, created_at').is('deleted_at', null).order('created_at', { ascending: false }).limit(5),
      supabaseAdmin.from('businesses').select('id, name, province, owner_id, created_at').eq('approval_status', 'pending').order('created_at', { ascending: true }).limit(5),
    ]);

    const totalRevenue = (revenueRows || []).reduce((sum, r) => sum + (r.price || 0), 0);

    return success(res, {
      stats: {
        total_users:        totalUsers    ?? 0,
        active_businesses:  activeBusinesses ?? 0,
        pending_approvals:  pendingApprovals ?? 0,
        total_bookings:     totalBookings ?? 0,
        today_bookings:     todayBookings ?? 0,
        total_revenue:      totalRevenue,
      },
      recent_users:    recentUsers    ?? [],
      pending_businesses: pendingBizList ?? [],
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/users ─────────────────────────────────────────────────────────
exports.getUsers = async (req, res, next) => {
  try {
    const { role, is_active, is_banned, q, page = 1, limit = 20 } = req.query;
    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('users')
      .select('id, full_name, phone, email, role, is_active, is_banned, ban_reason, province, created_at, last_seen_at, deleted_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (role)      query = query.eq('role', role);
    if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');
    if (is_banned !== undefined) query = query.eq('is_banned', is_banned === 'true');
    if (q)         query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);

    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;

    return success(res, { users: data, total: count, page: +page, limit: +limit });
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/businesses ────────────────────────────────────────────────────
exports.getBusinesses = async (req, res, next) => {
  try {
    const { approval_status, is_active, q, page = 1, limit = 20 } = req.query;
    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('businesses')
      .select(`
        id, name, province, phone,
        approval_status, is_active, is_frozen, freeze_reason,
        is_verified, current_plan_code, rating_avg, rating_count,
        created_at, approved_at,
        categories ( id, slug, name_ar ),
        owner:users!owner_id ( id, full_name, phone )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (approval_status) query = query.eq('approval_status', approval_status);
    if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');
    if (q) query = query.ilike('name', `%${q}%`);

    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;

    return success(res, { businesses: data, total: count, page: +page, limit: +limit });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /admin/businesses/:id/approve ───────────────────────────────────────
exports.approveBusiness = async (req, res, next) => {
  try {
    const { data: biz } = await supabaseAdmin
      .from('businesses')
      .select('id, approval_status, name')
      .eq('id', req.params.id)
      .single();

    if (!biz) return error(res, 'المحل غير موجود', 404);
    if (biz.approval_status === 'approved') {
      return error(res, 'المحل موافق عليه مسبقاً', 400);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('businesses')
      .update({
        approval_status: 'approved',
        is_active:       true,
        is_frozen:       false,
        freeze_reason:   null,
        approved_by:     req.user.id,
        approved_at:     new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('id, name, approval_status, is_active, approved_at')
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, `تمت الموافقة على المحل: ${biz.name}`);
  } catch (err) {
    next(err);
  }
};

// ─── PUT /admin/businesses/:id/suspend ───────────────────────────────────────
exports.suspendBusiness = async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return error(res, 'سبب التعليق (reason) مطلوب', 400);

    const { data: biz } = await supabaseAdmin
      .from('businesses')
      .select('id, approval_status, name')
      .eq('id', req.params.id)
      .single();

    if (!biz) return error(res, 'المحل غير موجود', 404);
    if (biz.approval_status === 'suspended') {
      return error(res, 'المحل معلق مسبقاً', 400);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('businesses')
      .update({
        approval_status: 'suspended',
        is_frozen:       true,
        freeze_reason:   reason,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('id, name, approval_status, is_frozen, freeze_reason')
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, `تم تعليق المحل: ${biz.name}`);
  } catch (err) {
    next(err);
  }
};
