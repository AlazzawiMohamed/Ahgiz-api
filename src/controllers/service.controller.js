const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// هل يملك المستخدم هذا المحل؟ (الأدمن يتجاوز)
const ownsBusiness = async (userId, businessId) => {
  const { data } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', userId)
    .maybeSingle();
  return !!data;
};

// business_id المالك للخدمة (للتحقق قبل التعديل/الحذف)
const serviceBusinessId = async (serviceId) => {
  const { data } = await supabaseAdmin
    .from('services')
    .select('business_id')
    .eq('id', serviceId)
    .maybeSingle();
  return data?.business_id || null;
};

exports.getAll = async (req, res, next) => {
  try {
    const { business_id, category } = req.query;
    let query = supabaseAdmin.from('services').select('*').eq('is_active', true);
    if (business_id) query = query.eq('business_id', business_id);
    if (category) query = query.eq('category', category);

    const { data, error: dbErr } = await query;
    if (dbErr) throw dbErr;
    return success(res, data);
  } catch (err) {
    next(err);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('services')
      .select('*, businesses(name, city)')
      .eq('id', req.params.id)
      .single();

    if (dbErr || !data) return error(res, 'الخدمة غير موجودة', 404);
    return success(res, data);
  } catch (err) {
    next(err);
  }
};

// ─── GET /services/:id/addons ─────────────────────────────────────────────────
// Optional add-ons offered by the same business (services flagged is_addon).
exports.getAddons = async (req, res, next) => {
  try {
    const { data: svc } = await supabaseAdmin
      .from('services')
      .select('business_id')
      .eq('id', req.params.id)
      .single();

    if (!svc) return error(res, 'الخدمة غير موجودة', 404);

    const { data, error: dbErr } = await supabaseAdmin
      .from('services')
      .select('id, name, description, price, duration')
      .eq('business_id', svc.business_id)
      .eq('is_addon', true)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (dbErr) throw dbErr;
    return success(res, data || []);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { business_id, name, description, price, duration, category } = req.body;
    if (!business_id || !name || !price || !duration) {
      return error(res, 'بيانات الخدمة غير مكتملة', 400);
    }

    // تحقق الملكية — لا يُسمح بإنشاء خدمة لمحل لا تملكه
    if (req.user.role !== 'admin' && !(await ownsBusiness(req.user.id, business_id))) {
      return error(res, 'لا تملك هذا المحل', 403);
    }

    const { data, error: dbErr } = await supabaseAdmin
      .from('services')
      .insert({ business_id, name, description, price, duration, category })
      .select()
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, 'تم إضافة الخدمة بنجاح', 201);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const bizId = await serviceBusinessId(req.params.id);
    if (!bizId) return error(res, 'الخدمة غير موجودة', 404);
    if (req.user.role !== 'admin' && !(await ownsBusiness(req.user.id, bizId))) {
      return error(res, 'لا تملك هذه الخدمة', 403);
    }

    const allowed = ['name', 'description', 'price', 'duration', 'category', 'is_active'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error: dbErr } = await supabaseAdmin
      .from('services')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (dbErr) throw dbErr;
    return success(res, data, 'تم تحديث الخدمة');
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const bizId = await serviceBusinessId(req.params.id);
    if (!bizId) return error(res, 'الخدمة غير موجودة', 404);
    if (req.user.role !== 'admin' && !(await ownsBusiness(req.user.id, bizId))) {
      return error(res, 'لا تملك هذه الخدمة', 403);
    }

    const { error: dbErr } = await supabaseAdmin
      .from('services')
      .update({ is_active: false })
      .eq('id', req.params.id);

    if (dbErr) throw dbErr;
    return success(res, null, 'تم حذف الخدمة');
  } catch (err) {
    next(err);
  }
};
