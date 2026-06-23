const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// ─── سجل تدقيق الأدمن (يُستدعى بعد كل عملية كتابة) ─────────────────────────────
const logAdmin = async (req, { action, target_type = null, target_id = null, before = null, after = null }) => {
  try {
    await supabaseAdmin.from('admin_audit_log').insert({
      admin_id:    req.user?.id || null,
      action,
      target_type,
      target_id,
      before_data: before,
      after_data:  after,
      ip_address:  req.ip || req.headers['x-forwarded-for']?.split(',')[0] || null,
    });
  } catch (e) {
    // لا نُفشل العملية بسبب فشل التسجيل
  }
};

const monthStartISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
};

const clampLimit = (v, def = 20, max = 100) => Math.min(Math.max(parseInt(v) || def, 1), max);

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
      { data: monthRevenueRows },
      { count: pendingWithdrawals },
      { count: pendingReports },
      { data: recentUsers },
      { data: pendingBizList },
    ] = await Promise.all([
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabaseAdmin.from('businesses').select('id', { count: 'exact', head: true }).eq('is_active', true).eq('approval_status', 'approved'),
      supabaseAdmin.from('businesses').select('id', { count: 'exact', head: true }).eq('approval_status', 'pending'),
      supabaseAdmin.from('bookings').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('bookings').select('id', { count: 'exact', head: true }).eq('booking_date', today),
      supabaseAdmin.from('bookings').select('price').eq('status', 'completed'),
      supabaseAdmin.from('bookings').select('price').eq('status', 'completed').gte('created_at', monthStartISO()),
      supabaseAdmin.from('points_withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabaseAdmin.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabaseAdmin.from('users').select('id, full_name, role, phone, created_at').is('deleted_at', null).order('created_at', { ascending: false }).limit(5),
      supabaseAdmin.from('businesses').select('id, name, province, owner_id, created_at').eq('approval_status', 'pending').order('created_at', { ascending: true }).limit(5),
    ]);

    const totalRevenue = (revenueRows || []).reduce((sum, r) => sum + (r.price || 0), 0);
    const revenueMonth = (monthRevenueRows || []).reduce((sum, r) => sum + (r.price || 0), 0);

    return success(res, {
      stats: {
        total_users:        totalUsers    ?? 0,
        active_businesses:  activeBusinesses ?? 0,
        pending_approvals:  pendingApprovals ?? 0,
        total_bookings:     totalBookings ?? 0,
        today_bookings:     todayBookings ?? 0,
        total_revenue:      totalRevenue,
        revenue_month:      revenueMonth,
      },
      alerts: {
        pending_approvals:   pendingApprovals    ?? 0,
        pending_withdrawals: pendingWithdrawals  ?? 0,
        pending_reports:     pendingReports      ?? 0,
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
    await logAdmin(req, { action: 'approve_business', target_type: 'business', target_id: biz.id, before: { approval_status: biz.approval_status }, after: data });
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
    await logAdmin(req, { action: 'suspend_business', target_type: 'business', target_id: biz.id, before: { approval_status: biz.approval_status }, after: data });
    return success(res, data, `تم تعليق المحل: ${biz.name}`);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/dashboard/charts ──────────────────────────────────────────────
exports.getDashboardCharts = async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [{ data: bookings }, { data: biz }] = await Promise.all([
      supabaseAdmin.from('bookings').select('booking_date, payment_method, status').gte('booking_date', since),
      supabaseAdmin.from('businesses').select('province').eq('is_active', true),
    ]);

    // حجوزات آخر 30 يوم
    const byDate = {};
    (bookings || []).forEach((b) => { byDate[b.booking_date] = (byDate[b.booking_date] || 0) + 1; });
    const bookings_30d = Object.entries(byDate)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // توزيع طرق الدفع
    const byPayment = {};
    (bookings || []).forEach((b) => { const k = b.payment_method || 'cash'; byPayment[k] = (byPayment[k] || 0) + 1; });
    const payment_methods = Object.entries(byPayment).map(([method, count]) => ({ method, count }));

    // توزيع المحلات بالمحافظة
    const byProvince = {};
    (biz || []).forEach((b) => { const k = b.province || 'غير محدد'; byProvince[k] = (byProvince[k] || 0) + 1; });
    const businesses_by_province = Object.entries(byProvince).map(([province, count]) => ({ province, count }));

    return success(res, { bookings_30d, payment_methods, businesses_by_province });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /admin/businesses/:id ─────────────────────────────────────────────
// لا يوجد عمود deleted_at على businesses → حذف ناعم = تعطيل + تجميد
exports.deleteBusiness = async (req, res, next) => {
  try {
    const { data: biz } = await supabaseAdmin
      .from('businesses').select('id, name, is_active').eq('id', req.params.id).single();
    if (!biz) return error(res, 'المحل غير موجود', 404);

    const { data, error: dbErr } = await supabaseAdmin
      .from('businesses')
      .update({
        is_active:       false,
        is_frozen:       true,
        approval_status: 'suspended',
        freeze_reason:   req.body?.reason || 'حُذف بواسطة الأدمن',
        updated_at:      new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('id, name, is_active, approval_status')
      .single();
    if (dbErr) throw dbErr;

    await logAdmin(req, { action: 'delete_business', target_type: 'business', target_id: biz.id, before: biz, after: data });
    return success(res, data, `تم حذف المحل: ${biz.name}`);
  } catch (err) {
    next(err);
  }
};

// ─── PUT /admin/users/:id/suspend ─────────────────────────────────────────────
exports.suspendUser = async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return error(res, 'سبب الحظر (reason) مطلوب', 400);

    const { data: user } = await supabaseAdmin
      .from('users').select('id, full_name, role, is_banned').eq('id', req.params.id).is('deleted_at', null).single();
    if (!user) return error(res, 'المستخدم غير موجود', 404);
    if (user.role === 'admin') return error(res, 'لا يمكن حظر حساب أدمن', 403);

    const { data, error: dbErr } = await supabaseAdmin
      .from('users')
      .update({ is_banned: true, ban_reason: reason })
      .eq('id', req.params.id)
      .select('id, full_name, is_banned, ban_reason')
      .single();
    if (dbErr) throw dbErr;

    await logAdmin(req, { action: 'suspend_user', target_type: 'user', target_id: user.id, before: { is_banned: user.is_banned }, after: data });
    return success(res, data, `تم حظر المستخدم: ${user.full_name || user.id}`);
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /admin/users/:id ──────────────────────────────────────────────────
// حذف ناعم متوافق مع GDPR (deleted_at) — auth middleware يرفض الدخول بعده
exports.deleteUser = async (req, res, next) => {
  try {
    const { data: user } = await supabaseAdmin
      .from('users').select('id, full_name, role').eq('id', req.params.id).is('deleted_at', null).single();
    if (!user) return error(res, 'المستخدم غير موجود', 404);
    if (user.role === 'admin') return error(res, 'لا يمكن حذف حساب أدمن', 403);

    const { data, error: dbErr } = await supabaseAdmin
      .from('users')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('id', req.params.id)
      .select('id, full_name, deleted_at')
      .single();
    if (dbErr) throw dbErr;

    await logAdmin(req, { action: 'delete_user', target_type: 'user', target_id: user.id, before: user, after: data });
    return success(res, data, `تم حذف المستخدم: ${user.full_name || user.id}`);
  } catch (err) {
    next(err);
  }
};

// ─── GET /admin/bookings ──────────────────────────────────────────────────────
exports.getBookings = async (req, res, next) => {
  try {
    const { status, no_show, province, date, page = 1 } = req.query;
    const limit = clampLimit(req.query.limit);
    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('bookings')
      .select(`
        id, booking_date, start_time, price, status, payment_method, created_at,
        services ( id, name ),
        customer:users!customer_id ( id, full_name, phone ),
        business:businesses!business_id!inner ( id, name, province )
      `, { count: 'exact' })
      .order('booking_date', { ascending: false })
      .range(from, from + limit - 1);

    if (status)   query = query.eq('status', status);
    if (date)     query = query.eq('booking_date', date);
    if (no_show !== undefined) {
      query = no_show === 'true' ? query.eq('status', 'no_show') : query.neq('status', 'no_show');
    }
    if (province) query = query.eq('business.province', province);

    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;
    return success(res, { bookings: data, total: count, page: +page, limit });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /admin/bookings/:id/cancel ───────────────────────────────────────────
exports.cancelBooking = async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return error(res, 'سبب الإلغاء (reason) مطلوب', 400);

    const { data: booking } = await supabaseAdmin
      .from('bookings').select('id, status').eq('id', req.params.id).single();
    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (['cancelled', 'completed'].includes(booking.status)) {
      return error(res, 'لا يمكن إلغاء حجز ملغى أو مكتمل', 400);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('bookings')
      .update({ status: 'cancelled', cancelled_by: 'admin', cancel_reason: reason, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id, status, cancelled_by, cancel_reason')
      .single();
    if (dbErr) throw dbErr;

    await logAdmin(req, { action: 'cancel_booking', target_type: 'booking', target_id: booking.id, before: { status: booking.status }, after: data });
    return success(res, data, 'تم إلغاء الحجز');
  } catch (err) {
    next(err);
  }
};

// ─── Categories CRUD (A05) ────────────────────────────────────────────────────
const CATEGORY_FIELDS = ['name_ar', 'name_en', 'icon_url', 'color_dark', 'color_primary', 'color_accent', 'color_bg', 'is_active', 'sort_order', 'supports_online', 'requires_staff'];
const pick = (obj, fields) => fields.reduce((acc, f) => { if (obj[f] !== undefined) acc[f] = obj[f]; return acc; }, {});

exports.getCategories = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('categories').select('*').order('sort_order', { ascending: true });
    if (dbErr) throw dbErr;
    return success(res, { categories: data });
  } catch (err) { next(err); }
};

exports.createCategory = async (req, res, next) => {
  try {
    const payload = pick(req.body, CATEGORY_FIELDS);
    if (!payload.name_ar) return error(res, 'الاسم بالعربية (name_ar) مطلوب', 400);
    payload.created_by = req.user.id;

    const { data, error: dbErr } = await supabaseAdmin.from('categories').insert(payload).select('*').single();
    if (dbErr) throw dbErr;
    await logAdmin(req, { action: 'create_category', target_type: 'category', target_id: data.id, after: data });
    return success(res, data, 'تم إنشاء القسم', 201);
  } catch (err) { next(err); }
};

exports.updateCategory = async (req, res, next) => {
  try {
    const payload = pick(req.body, CATEGORY_FIELDS);
    if (Object.keys(payload).length === 0) return error(res, 'لا توجد حقول للتحديث', 400);

    const { data, error: dbErr } = await supabaseAdmin
      .from('categories').update(payload).eq('id', req.params.id).select('*').single();
    if (dbErr) throw dbErr;
    if (!data) return error(res, 'القسم غير موجود', 404);
    await logAdmin(req, { action: 'update_category', target_type: 'category', target_id: data.id, after: data });
    return success(res, data, 'تم تحديث القسم');
  } catch (err) { next(err); }
};

exports.deleteCategory = async (req, res, next) => {
  try {
    // تعطيل بدل الحذف الصلب (قد ترتبط به محلات)
    const { data, error: dbErr } = await supabaseAdmin
      .from('categories').update({ is_active: false }).eq('id', req.params.id).select('id, name_ar, is_active').single();
    if (dbErr) throw dbErr;
    if (!data) return error(res, 'القسم غير موجود', 404);
    await logAdmin(req, { action: 'disable_category', target_type: 'category', target_id: data.id, after: data });
    return success(res, data, 'تم تعطيل القسم');
  } catch (err) { next(err); }
};

// ─── Subscription plans CRUD (A05) ────────────────────────────────────────────
const PLAN_FIELDS = ['category_id', 'plan_code', 'name_ar', 'description_ar', 'price_monthly', 'price_yearly', 'includes_reviews', 'includes_online', 'includes_analytics', 'includes_ads', 'includes_priority', 'max_staff', 'max_services', 'max_bookings_monthly', 'is_active', 'sort_order'];

exports.getPlans = async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('subscription_plans')
      .select('*, categories ( id, name_ar )')
      .order('sort_order', { ascending: true });
    if (req.query.category_id) query = query.eq('category_id', req.query.category_id);
    const { data, error: dbErr } = await query;
    if (dbErr) throw dbErr;
    return success(res, { plans: data });
  } catch (err) { next(err); }
};

exports.createPlan = async (req, res, next) => {
  try {
    const payload = pick(req.body, PLAN_FIELDS);
    if (!payload.category_id || !payload.plan_code || !payload.name_ar) {
      return error(res, 'category_id وplan_code وname_ar مطلوبة', 400);
    }
    const { data, error: dbErr } = await supabaseAdmin.from('subscription_plans').insert(payload).select('*').single();
    if (dbErr) throw dbErr;
    await logAdmin(req, { action: 'create_plan', target_type: 'subscription', target_id: data.id, after: data });
    return success(res, data, 'تم إنشاء الباقة', 201);
  } catch (err) { next(err); }
};

exports.updatePlan = async (req, res, next) => {
  try {
    const payload = pick(req.body, PLAN_FIELDS);
    if (Object.keys(payload).length === 0) return error(res, 'لا توجد حقول للتحديث', 400);
    payload.updated_at = new Date().toISOString();
    const { data, error: dbErr } = await supabaseAdmin
      .from('subscription_plans').update(payload).eq('id', req.params.id).select('*').single();
    if (dbErr) throw dbErr;
    if (!data) return error(res, 'الباقة غير موجودة', 404);
    await logAdmin(req, { action: 'edit_subscription_plan', target_type: 'subscription', target_id: data.id, after: data });
    return success(res, data, 'تم تحديث الباقة');
  } catch (err) { next(err); }
};

exports.deletePlan = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('subscription_plans').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('id, name_ar, is_active').single();
    if (dbErr) throw dbErr;
    if (!data) return error(res, 'الباقة غير موجودة', 404);
    await logAdmin(req, { action: 'disable_plan', target_type: 'subscription', target_id: data.id, after: data });
    return success(res, data, 'تم تعطيل الباقة');
  } catch (err) { next(err); }
};

// ─── Ads management (A07) ─────────────────────────────────────────────────────
const AD_FIELDS = ['business_id', 'type', 'title', 'image_url', 'target_url', 'starts_at', 'ends_at', 'is_active', 'is_free'];

exports.getAds = async (req, res, next) => {
  try {
    const { type, is_active, page = 1 } = req.query;
    const limit = clampLimit(req.query.limit);
    const fromIdx = (page - 1) * limit;
    let query = supabaseAdmin
      .from('ads')
      .select('*, businesses ( id, name )', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(fromIdx, fromIdx + limit - 1);
    if (type) query = query.eq('type', type);
    if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');
    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;
    return success(res, { ads: data, total: count, page: +page, limit });
  } catch (err) { next(err); }
};

exports.createAd = async (req, res, next) => {
  try {
    const payload = pick(req.body, AD_FIELDS);
    if (!payload.type) return error(res, 'نوع الإعلان (type) مطلوب: splash|search|badge|category', 400);
    const { data, error: dbErr } = await supabaseAdmin.from('ads').insert(payload).select('*').single();
    if (dbErr) throw dbErr;
    await logAdmin(req, { action: 'create_ad', target_type: 'ad', target_id: data.id, after: data });
    return success(res, data, 'تم إنشاء الإعلان', 201);
  } catch (err) { next(err); }
};

exports.updateAd = async (req, res, next) => {
  try {
    const payload = pick(req.body, AD_FIELDS);
    if (Object.keys(payload).length === 0) return error(res, 'لا توجد حقول للتحديث', 400);
    const { data, error: dbErr } = await supabaseAdmin.from('ads').update(payload).eq('id', req.params.id).select('*').single();
    if (dbErr) throw dbErr;
    if (!data) return error(res, 'الإعلان غير موجود', 404);
    await logAdmin(req, { action: 'update_ad', target_type: 'ad', target_id: data.id, after: data });
    return success(res, data, 'تم تحديث الإعلان');
  } catch (err) { next(err); }
};

exports.deleteAd = async (req, res, next) => {
  try {
    const { error: dbErr } = await supabaseAdmin.from('ads').delete().eq('id', req.params.id);
    if (dbErr) throw dbErr;
    await logAdmin(req, { action: 'delete_ad', target_type: 'ad', target_id: req.params.id });
    return success(res, { id: req.params.id }, 'تم حذف الإعلان');
  } catch (err) { next(err); }
};

exports.getAdStats = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin.rpc('get_ad_stats', { p_ad_id: req.params.id });
    if (dbErr) throw dbErr;
    return success(res, data);
  } catch (err) { next(err); }
};

// ─── Points withdrawals (A08) ─────────────────────────────────────────────────
exports.getWithdrawals = async (req, res, next) => {
  try {
    const { status = 'pending', page = 1 } = req.query;
    const limit = clampLimit(req.query.limit);
    const fromIdx = (page - 1) * limit;
    const { data, error: dbErr, count } = await supabaseAdmin
      .from('points_withdrawal_requests')
      .select('*, businesses ( id, name, phone )', { count: 'exact' })
      .eq('status', status)
      .order('created_at', { ascending: true })
      .range(fromIdx, fromIdx + limit - 1);
    if (dbErr) throw dbErr;
    return success(res, { withdrawals: data, total: count, page: +page, limit });
  } catch (err) { next(err); }
};

exports.approveWithdrawal = async (req, res, next) => {
  try {
    const { data: wr } = await supabaseAdmin
      .from('points_withdrawal_requests').select('id, status, amount, business_id').eq('id', req.params.id).single();
    if (!wr) return error(res, 'طلب السحب غير موجود', 404);
    if (wr.status !== 'pending') return error(res, 'الطلب ليس قيد الانتظار', 400);

    const now = new Date().toISOString();
    const { data, error: dbErr } = await supabaseAdmin
      .from('points_withdrawal_requests')
      .update({ status: 'transferred', reviewed_by: req.user.id, reviewed_at: now, transferred_at: now })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (dbErr) throw dbErr;

    await logAdmin(req, { action: 'approve_withdrawal', target_type: 'withdrawal', target_id: wr.id, before: { status: wr.status }, after: data });
    return success(res, data, 'تم تأكيد تحويل السحب');
  } catch (err) { next(err); }
};

exports.rejectWithdrawal = async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return error(res, 'سبب الرفض (reason) مطلوب', 400);

    const { data: wr } = await supabaseAdmin
      .from('points_withdrawal_requests').select('id, status').eq('id', req.params.id).single();
    if (!wr) return error(res, 'طلب السحب غير موجود', 404);
    if (wr.status !== 'pending') return error(res, 'الطلب ليس قيد الانتظار', 400);

    const { data, error: dbErr } = await supabaseAdmin
      .from('points_withdrawal_requests')
      .update({ status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(), rejection_reason: reason })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (dbErr) throw dbErr;

    await logAdmin(req, { action: 'reject_withdrawal', target_type: 'withdrawal', target_id: wr.id, before: { status: wr.status }, after: data });
    return success(res, data, 'تم رفض طلب السحب');
  } catch (err) { next(err); }
};

// ─── Reports / complaints ─────────────────────────────────────────────────────
exports.getReports = async (req, res, next) => {
  try {
    const { status = 'pending', page = 1 } = req.query;
    const limit = clampLimit(req.query.limit);
    const fromIdx = (page - 1) * limit;
    const { data, error: dbErr, count } = await supabaseAdmin
      .from('reports')
      .select('*, reporter:users!reporter_id ( id, full_name, phone )', { count: 'exact' })
      .eq('status', status)
      .order('created_at', { ascending: false })
      .range(fromIdx, fromIdx + limit - 1);
    if (dbErr) throw dbErr;
    return success(res, { reports: data, total: count, page: +page, limit });
  } catch (err) { next(err); }
};

exports.resolveReport = async (req, res, next) => {
  try {
    const status = req.body?.status || 'resolved';
    if (!['reviewed', 'resolved', 'dismissed'].includes(status)) {
      return error(res, 'حالة غير صالحة: reviewed|resolved|dismissed', 400);
    }
    const { data, error: dbErr } = await supabaseAdmin
      .from('reports')
      .update({ status, reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (dbErr) throw dbErr;
    if (!data) return error(res, 'البلاغ غير موجود', 404);
    await logAdmin(req, { action: 'resolve_report', target_type: 'report', target_id: data.id, after: data });
    return success(res, data, 'تم تحديث البلاغ');
  } catch (err) { next(err); }
};

// ─── Platform settings (A12) ──────────────────────────────────────────────────
const LOCKED_SETTINGS = ['calendar_pending_color'];

exports.getSettings = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('platform_settings').select('key, value, description, updated_at').order('key', { ascending: true });
    if (dbErr) throw dbErr;
    const settings = (data || []).map((s) => ({ ...s, locked: LOCKED_SETTINGS.includes(s.key) }));
    return success(res, { settings });
  } catch (err) { next(err); }
};

exports.updateSetting = async (req, res, next) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) return error(res, 'القيمة (value) مطلوبة', 400);
    if (LOCKED_SETTINGS.includes(key)) {
      return error(res, 'هذا الإعداد ثابت ولا يمكن تعديله', 403);
    }
    const { data: before } = await supabaseAdmin.from('platform_settings').select('value').eq('key', key).single();
    if (!before) return error(res, 'الإعداد غير موجود', 404);

    const { data, error: dbErr } = await supabaseAdmin
      .from('platform_settings')
      .update({ value: String(value), updated_by: req.user.id, updated_at: new Date().toISOString() })
      .eq('key', key)
      .select('key, value, description, updated_at')
      .single();
    if (dbErr) throw dbErr;

    await logAdmin(req, { action: 'update_setting', target_type: 'setting', target_id: null, before: { key, value: before.value }, after: data });
    return success(res, data, 'تم تحديث الإعداد');
  } catch (err) { next(err); }
};

// ─── Advanced stats (A10) ─────────────────────────────────────────────────────
exports.getStats = async (req, res, next) => {
  try {
    const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const [{ data: noShows }, { data: completed }, { data: newUsers }] = await Promise.all([
      supabaseAdmin.from('bookings').select('business:businesses!business_id ( province )').eq('status', 'no_show'),
      supabaseAdmin.from('bookings').select('price, service_id, services ( category_id )').eq('status', 'completed'),
      supabaseAdmin.from('users').select('created_at').gte('created_at', since90).is('deleted_at', null),
    ]);

    // No-Show بالمحافظة
    const noShowByProvince = {};
    (noShows || []).forEach((b) => { const p = b.business?.province || 'غير محدد'; noShowByProvince[p] = (noShowByProvince[p] || 0) + 1; });

    // متوسط قيمة الحجز بالقسم
    const byCat = {};
    (completed || []).forEach((b) => {
      const c = b.services?.category_id || 'غير محدد';
      byCat[c] = byCat[c] || { total: 0, count: 0 };
      byCat[c].total += b.price || 0; byCat[c].count += 1;
    });
    const avgBookingByCategory = Object.entries(byCat).map(([category_id, v]) => ({ category_id, avg: Math.round(v.total / v.count), count: v.count }));

    // نمو المستخدمين أسبوعياً (آخر 12 أسبوع)
    const byWeek = {};
    (newUsers || []).forEach((u) => {
      const d = new Date(u.created_at);
      const onejan = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
      const key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
      byWeek[key] = (byWeek[key] || 0) + 1;
    });
    const userGrowthWeekly = Object.entries(byWeek).map(([week, count]) => ({ week, count })).sort((a, b) => a.week.localeCompare(b.week));

    return success(res, {
      no_show_by_province: Object.entries(noShowByProvince).map(([province, count]) => ({ province, count })),
      avg_booking_by_category: avgBookingByCategory,
      user_growth_weekly: userGrowthWeekly,
    });
  } catch (err) { next(err); }
};

// ─── Admin activity log (A11) ─────────────────────────────────────────────────
exports.getActivity = async (req, res, next) => {
  try {
    const { action, from: fromDate, to: toDate, page = 1 } = req.query;
    const limit = clampLimit(req.query.limit, 30);
    const fromIdx = (page - 1) * limit;

    let query = supabaseAdmin
      .from('admin_audit_log')
      .select('id, action, target_type, target_id, before_data, after_data, ip_address, created_at, admin:users!admin_id ( id, full_name, email )', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(fromIdx, fromIdx + limit - 1);

    if (action)   query = query.eq('action', action);
    if (fromDate) query = query.gte('created_at', fromDate);
    if (toDate)   query = query.lte('created_at', toDate);

    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;
    return success(res, { activity: data, total: count, page: +page, limit });
  } catch (err) { next(err); }
};

// ─── CSV reports export (A09) ─────────────────────────────────────────────────
const toCsv = (rows) => {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
};

exports.exportReport = async (req, res, next) => {
  try {
    const { kind } = req.params;
    let rows = [];

    if (kind === 'revenue') {
      const { data } = await supabaseAdmin
        .from('bookings')
        .select('booking_date, price, payment_method, business:businesses!business_id ( name, province )')
        .eq('status', 'completed');
      rows = (data || []).map((b) => ({
        date: b.booking_date, business: b.business?.name || '', province: b.business?.province || '',
        amount: b.price || 0, payment_method: b.payment_method,
      }));
    } else if (kind === 'businesses') {
      const { data } = await supabaseAdmin
        .from('businesses').select('name, province, approval_status, is_active, rating_avg, rating_count, created_at');
      rows = data || [];
    } else if (kind === 'users') {
      const { data } = await supabaseAdmin
        .from('users').select('full_name, phone, role, province, created_at, last_seen_at').is('deleted_at', null);
      rows = data || [];
    } else if (kind === 'payments') {
      const { data } = await supabaseAdmin
        .from('bookings').select('payment_method, price').eq('status', 'completed');
      const agg = {};
      (data || []).forEach((b) => { const k = b.payment_method || 'cash'; agg[k] = agg[k] || { count: 0, total: 0 }; agg[k].count += 1; agg[k].total += b.price || 0; });
      rows = Object.entries(agg).map(([payment_method, v]) => ({ payment_method, count: v.count, total: v.total }));
    } else {
      return error(res, 'نوع تقرير غير معروف: revenue|businesses|users|payments', 400);
    }

    const csv = toCsv(rows);
    await logAdmin(req, { action: 'export_report', target_type: 'report', target_id: null, after: { kind, rows: rows.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}-report.csv"`);
    return res.send('﻿' + csv); // BOM لدعم العربية في Excel
  } catch (err) { next(err); }
};
