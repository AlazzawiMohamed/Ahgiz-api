const { supabaseAdmin } = require('../utils/supabase');
const { error } = require('../utils/response');

/**
 * Finds the business owned by req.user and attaches it as req.business.
 * Accepts ?business_id= query param for owners with multiple businesses.
 * Must run after authenticate + authorize('business').
 */
const requireBusiness = async (req, res, next) => {
  try {
    const businessId = req.query.business_id || null;

    let query = supabaseAdmin
      .from('businesses')
      .select('id, name, owner_id, is_active, is_frozen, approval_status, current_plan_code')
      .eq('owner_id', req.user.id);

    if (businessId) {
      query = query.eq('id', businessId);
    } else {
      query = query.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1);
    }

    const { data: biz } = await query.maybeSingle();

    if (!biz) return error(res, 'لا يوجد محل مرتبط بحسابك', 404);

    req.business = biz;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = requireBusiness;
