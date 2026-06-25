const { supabaseAdmin } = require('../utils/supabase');
const { success } = require('../utils/response');

// ─── GET /loyalty/balance ─────────────────────────────────────────────────────
// Customer points balance for the loyalty screen (C17).
exports.getBalance = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('customer_points_balance')
      .select('balance, expiring_soon, next_expiry_at')
      .eq('customer_id', req.user.id)
      .maybeSingle();

    if (dbErr) throw dbErr;

    return success(res, {
      points:            data?.balance ?? 0,
      // No points→IQD redemption rate is configured yet (points_redemption_enabled=false),
      // so we don't fabricate a monetary value — the app hides the line when null.
      value_iqd:         null,
      next_level_points: null,
      expiring_soon:     data?.expiring_soon ?? 0,
      next_expiry_at:    data?.next_expiry_at ?? null,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /loyalty/history?limit=&offset= ──────────────────────────────────────
exports.getHistory = async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { data, error: dbErr } = await supabaseAdmin
      .from('points_transactions')
      .select('id, type, points, points_category, note, created_at')
      .eq('customer_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (dbErr) throw dbErr;

    const history = (data || []).map((tx) => ({
      id:          tx.id,
      points:      tx.points,           // positive = earned, negative = redeemed
      description: tx.note,
      reason:      tx.type,
      created_at:  tx.created_at,
    }));

    return success(res, { history });
  } catch (err) {
    next(err);
  }
};
