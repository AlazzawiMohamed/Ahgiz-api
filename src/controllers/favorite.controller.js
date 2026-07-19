const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// ─── POST /favorites/:business_id ─────────────────────────────────────────────
exports.add = async (req, res, next) => {
  try {
    const { business_id } = req.params;

    // Verify business exists and is active
    const { data: biz } = await supabaseAdmin
      .from('businesses')
      .select('id, name')
      .eq('id', business_id)
      .eq('is_active', true)
      .single();

    // TODO(i18n): replace with i18n key
    if (!biz) return error(res, 'المحل غير موجود أو غير نشط', 404);

    const { data, error: dbErr } = await supabaseAdmin
      .from('favorites')
      .insert({ customer_id: req.user.id, business_id })
      .select('id, business_id, created_at')
      .single();

    if (dbErr) {
      if (dbErr.code === '23505') {
        // TODO(i18n): replace with i18n key
        return error(res, 'المحل موجود بالفعل في المفضلة', 409);
      }
      throw dbErr;
    }

    // TODO(i18n): replace with i18n key
    return success(res, data, 'تمت إضافة المحل إلى المفضلة', 201);
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /favorites/:business_id ───────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { business_id } = req.params;

    const { data: existing } = await supabaseAdmin
      .from('favorites')
      .select('id')
      .eq('customer_id', req.user.id)
      .eq('business_id', business_id)
      .single();

    // TODO(i18n): replace with i18n key
    if (!existing) return error(res, 'المحل غير موجود في المفضلة', 404);

    const { error: dbErr } = await supabaseAdmin
      .from('favorites')
      .delete()
      .eq('customer_id', req.user.id)
      .eq('business_id', business_id);

    if (dbErr) throw dbErr;
    // TODO(i18n): replace with i18n key
    return success(res, null, 'تمت إزالة المحل من المفضلة');
  } catch (err) {
    next(err);
  }
};

// ─── GET /favorites ────────────────────────────────────────────────────────────
exports.getMine = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const from = (page - 1) * limit;

    const { data, error: dbErr, count } = await supabaseAdmin
      .from('favorites')
      .select(`
        id, created_at, sort_order, note,
        businesses (
          id, name, province, logo_url, cover_url,
          rating_avg, rating_count, is_featured, current_plan_code,
          categories ( id, slug, name_ar, name_en, name_ku, icon_url ),
          services ( price, is_active )
        )
      `, { count: 'exact' })
      .eq('customer_id', req.user.id)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (dbErr) throw dbErr;

    // Flatten business details to the top level; expose the favorite row id as
    // favorite_id and the business id as business_id (used by the client for
    // navigation + the DELETE call). min_price is derived from active services.
    const favorites = (data || []).map((f) => {
      const b = f.businesses || {};
      const prices = (b.services || [])
        .filter((s) => s.is_active && s.price != null)
        .map((s) => Number(s.price));
      return {
        favorite_id:       f.id,
        business_id:       b.id ?? null,
        name:              b.name ?? null,
        logo_url:          b.logo_url ?? null,
        cover_url:         b.cover_url ?? null,
        rating_avg:        b.rating_avg ?? null,
        rating_count:      b.rating_count ?? null,
        province:          b.province ?? null,
        is_featured:       b.is_featured ?? null,
        current_plan_code: b.current_plan_code ?? null,
        categories:        b.categories ?? null,
        min_price:         prices.length ? Math.min(...prices) : null,
        created_at:        f.created_at,
        sort_order:        f.sort_order,
        note:              f.note,
      };
    });

    return success(res, {
      favorites,
      total: count,
      page:  +page,
      limit: +limit,
    });
  } catch (err) {
    next(err);
  }
};
