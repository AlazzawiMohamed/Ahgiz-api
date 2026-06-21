const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// ─── GET /search?q=&province=&category=&rating_min=&page=&limit= ─────────────
exports.search = async (req, res, next) => {
  try {
    const {
      q, province, category,
      rating_min, page = 1, limit = 20,
    } = req.query;

    if (!q && !province && !category) {
      return error(res, 'يجب توفير معيار بحث واحد على الأقل: q, province, أو category', 400);
    }

    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('businesses')
      .select(`
        id, name, description, province, address,
        logo_url, rating_avg, rating_count,
        is_featured, current_plan_code,
        categories ( id, slug, name_ar, name_en, icon_url )
      `, { count: 'exact' })
      .eq('is_active',        true)
      .eq('is_frozen',        false)
      .eq('approval_status',  'approved')
      .order('is_featured',   { ascending: false })
      .order('rating_avg',    { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (q)          query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
    if (province)   query = query.eq('province', province);
    if (rating_min) query = query.gte('rating_avg', parseFloat(rating_min));

    if (category) {
      const { data: cat } = await supabaseAdmin
        .from('categories')
        .select('id')
        .eq('slug', category)
        .single();
      if (!cat) return error(res, 'الفئة غير موجودة', 404);
      query = query.eq('category_id', cat.id);
    }

    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;

    return success(res, {
      query:      q || null,
      results:    data,
      total:      count,
      page:       +page,
      limit:      +limit,
    });
  } catch (err) {
    next(err);
  }
};
