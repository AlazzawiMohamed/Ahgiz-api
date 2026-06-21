const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// GET /governorates
exports.getAll = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('governorates')
      .select('id, slug, name_ar, name_en, latitude, longitude')
      .eq('is_active', true)
      .order('name_ar', { ascending: true });

    if (dbErr) throw dbErr;
    return success(res, data);
  } catch (err) {
    next(err);
  }
};
