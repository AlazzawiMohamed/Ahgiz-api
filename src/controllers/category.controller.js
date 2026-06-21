const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// GET /categories
exports.getAll = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('categories')
      .select('id, slug, name_ar, name_en, icon_url, color_primary, businesses_count, sort_order, supports_reviews')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (dbErr) throw dbErr;
    return success(res, data);
  } catch (err) {
    next(err);
  }
};
