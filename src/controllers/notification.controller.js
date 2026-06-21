const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

const VALID_TYPES = [
  'booking_confirmed', 'booking_reminder_24h', 'booking_reminder_2h',
  'booking_cancelled', 'waitlist_available', 'rebooking_reminder',
  'review_request', 'receipt', 'meeting_link', 'new_booking',
  'booking_cancelled_by_customer', 'daily_summary', 'no_show_alert',
  'attendance_confirmation_required', 'grace_period_started',
  'reschedule_requested', 'reschedule_approved', 'reschedule_rejected',
  'account_recovery_approved', 'account_recovery_rejected',
];
const VALID_CHANNELS  = ['whatsapp', 'push', 'in_app', 'both'];
const VALID_PRIORITIES = ['critical', 'high', 'normal', 'low'];

// ─── POST /notifications/send — admin only ────────────────────────────────────
exports.send = async (req, res, next) => {
  try {
    const {
      user_id, type, message,
      channel = 'in_app', priority = 'normal',
      booking_id, scheduled_at,
    } = req.body;

    if (!user_id)  return error(res, 'user_id مطلوب', 400);
    if (!type)     return error(res, 'type مطلوب', 400);
    if (!message)  return error(res, 'message مطلوب', 400);

    if (!VALID_TYPES.includes(type)) {
      return error(res, `نوع الإشعار غير صالح: ${type}`, 400);
    }
    if (!VALID_CHANNELS.includes(channel)) {
      return error(res, `channel غير صالح. القيم المقبولة: ${VALID_CHANNELS.join(', ')}`, 400);
    }
    if (!VALID_PRIORITIES.includes(priority)) {
      return error(res, `priority غير صالح. القيم المقبولة: ${VALID_PRIORITIES.join(', ')}`, 400);
    }

    // Verify target user exists
    const { data: targetUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', user_id)
      .is('deleted_at', null)
      .single();

    if (!targetUser) return error(res, 'المستخدم المستهدف غير موجود', 404);

    const { data: notif, error: dbErr } = await supabaseAdmin
      .from('notifications')
      .insert({
        user_id,
        type,
        message,
        channel,
        priority,
        booking_id:   booking_id   || null,
        scheduled_at: scheduled_at || null,
        status:       'pending',
      })
      .select('id, user_id, type, message, channel, priority, status, created_at')
      .single();

    if (dbErr) throw dbErr;
    return success(res, notif, 'تم جدولة الإشعار بنجاح', 201);
  } catch (err) {
    next(err);
  }
};

// ─── GET /notifications — my notifications ────────────────────────────────────
exports.getMine = async (req, res, next) => {
  try {
    const { unread, page = 1, limit = 20 } = req.query;
    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('notifications')
      .select('id, type, message, channel, status, read_at, booking_id, created_at', { count: 'exact' })
      .eq('user_id', req.user.id)
      .in('channel', ['in_app', 'both'])
      .order('created_at', { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (unread === 'true') query = query.is('read_at', null);

    const { data, error: dbErr, count } = await query;
    if (dbErr) throw dbErr;

    return success(res, {
      notifications: data,
      unread_count:  data.filter(n => !n.read_at).length,
      total:         count,
      page:          +page,
      limit:         +limit,
    });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /notifications/read-all ──────────────────────────────────────────────
exports.readAll = async (req, res, next) => {
  try {
    const { error: dbErr, count } = await supabaseAdmin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .is('read_at', null)
      .in('channel', ['in_app', 'both']);

    if (dbErr) throw dbErr;
    return success(res, { updated: count ?? 0 }, 'تم تحديد جميع الإشعارات كمقروءة');
  } catch (err) {
    next(err);
  }
};

// ─── PUT /notifications/:id/read ──────────────────────────────────────────────
exports.readOne = async (req, res, next) => {
  try {
    const { data: notif } = await supabaseAdmin
      .from('notifications')
      .select('id, user_id, read_at')
      .eq('id', req.params.id)
      .single();

    if (!notif) return error(res, 'الإشعار غير موجود', 404);
    if (notif.user_id !== req.user.id) return error(res, 'ليس لديك صلاحية', 403);

    if (notif.read_at) {
      return success(res, { id: notif.id, read_at: notif.read_at }, 'الإشعار مقروء مسبقاً');
    }

    const { data: updated, error: dbErr } = await supabaseAdmin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id, type, message, read_at, created_at')
      .single();

    if (dbErr) throw dbErr;
    return success(res, updated, 'تم تحديد الإشعار كمقروء');
  } catch (err) {
    next(err);
  }
};
