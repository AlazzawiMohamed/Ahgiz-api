const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// ─── GET /banners?screen=&province=&limit= ────────────────────────────────────
// Public. Wraps get_active_banners(p_screen, p_province, p_limit).
// screen examples: home_top, home_bottom, booking_confirm.
exports.getActive = async (req, res, next) => {
  try {
    // accept `screen` (canonical) or `position` (Sprint-doc alias)
    const screen = req.query.screen || req.query.position || 'home_top';
    const province = req.query.province || null;
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);

    const { data, error: rpcErr } = await supabaseAdmin.rpc('get_active_banners', {
      p_screen:   screen,
      p_province: province,
      p_limit:    limit,
    });
    if (rpcErr) throw rpcErr;

    return success(res, data || []);
  } catch (err) {
    next(err);
  }
};
