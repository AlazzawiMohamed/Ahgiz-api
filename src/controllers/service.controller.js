const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

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

exports.create = async (req, res, next) => {
  try {
    const { business_id, name, description, price, duration, category } = req.body;
    if (!business_id || !name || !price || !duration) {
      return error(res, 'بيانات الخدمة غير مكتملة', 400);
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
