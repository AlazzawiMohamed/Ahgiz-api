const crypto = require('crypto');
const { supabaseAdmin } = require('../utils/supabase');
const { success } = require('../utils/response');

const REFERRAL_BASE_URL = process.env.REFERRAL_BASE_URL || 'https://ahgiz.iq/join';

// ─── GET /referral/my-code ────────────────────────────────────────────────────
// Returns the customer's unique referral code (generating one if missing).
exports.getMyCode = async (req, res, next) => {
  try {
    const { data: user, error: dbErr } = await supabaseAdmin
      .from('users')
      .select('referral_code')
      .eq('id', req.user.id)
      .maybeSingle();

    if (dbErr) throw dbErr;

    let code = user?.referral_code || null;
    if (!code) {
      code = `AH${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const { error: updErr } = await supabaseAdmin
        .from('users')
        .update({ referral_code: code })
        .eq('id', req.user.id);
      if (updErr) throw updErr;
    }

    return success(res, { code, link: `${REFERRAL_BASE_URL}/${code}` });
  } catch (err) {
    next(err);
  }
};

// ─── GET /referral/history ────────────────────────────────────────────────────
// People this customer has invited, with reward status (C18).
exports.getHistory = async (req, res, next) => {
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('referrals')
      .select('id, status, points_awarded, completed_at, created_at, referred:users!referrals_referred_id_fkey ( full_name )')
      .eq('referrer_id', req.user.id)
      .order('created_at', { ascending: false });

    if (dbErr) throw dbErr;

    const history = (data || []).map((r) => ({
      id:            r.id,
      name:          r.referred?.full_name || null,
      joined_at:     r.created_at,
      reward_status: r.points_awarded ? 'granted' : (r.status || 'pending'),
    }));

    return success(res, { history });
  } catch (err) {
    next(err);
  }
};
