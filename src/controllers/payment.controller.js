const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

const ASIA_PENDING = 'pending_confirmation';

// Shape an asiahawala_transactions row into the client display payload
const shapeTx = (tx) => ({
  success: true,
  transaction_id: tx.id,
  receiver_phone: tx.receiver_phone,
  amount: tx.amount,
  reference: String(tx.id).slice(0, 8),
  hawala_reference: tx.hawala_reference,
  expires_at: tx.metadata?.expires_at || null,
  instructions: `أرسل ${tx.amount} دينار إلى ${tx.receiver_phone}`,
});

// ─── POST /payments/asiahawala/initiate ───────────────────────────────────────
// Creates a pending AsiaHawala transaction for the customer's pending booking.
// Idempotent: if one already exists, returns it (so C09.5 can re-display).
exports.asiahawalaInitiate = async (req, res, next) => {
  try {
    const { booking_id } = req.body;
    if (!booking_id) return error(res, 'booking_id مطلوب', 400);

    // Server-side amount = booking price (never trust the client)
    const { data: booking } = await supabaseAdmin
      .from('bookings')
      .select('id, customer_id, status, price')
      .eq('id', booking_id)
      .single();

    if (!booking) return error(res, 'الحجز غير موجود', 404);
    if (booking.customer_id !== req.user.id) {
      return error(res, 'ليس لديك صلاحية لهذا الحجز', 403);
    }

    const { data: result, error: rpcErr } = await supabaseAdmin
      .rpc('create_asiahawala_booking_payment', {
        p_booking_id:  booking_id,
        p_customer_id: req.user.id,
        p_amount:      booking.price,
      });
    if (rpcErr) throw rpcErr;

    if (result?.success) {
      return success(res, result, 'تم إنشاء طلب الحوالة');
    }

    // Already has a pending transaction → return it for display (idempotent)
    if (result?.code === 'DUPLICATE_PAYMENT') {
      const { data: tx } = await supabaseAdmin
        .from('asiahawala_transactions')
        .select('id, amount, receiver_phone, hawala_reference, metadata')
        .eq('booking_id', booking_id)
        .eq('status', ASIA_PENDING)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (tx) return success(res, shapeTx(tx), 'طلب الحوالة موجود مسبقاً');
    }

    const codeMap = {
      NOT_FOUND: 404, UNAUTHORIZED: 403, INVALID_STATUS: 400, PAYMENT_DISABLED: 503,
    };
    return error(res, result?.message || 'تعذّر إنشاء طلب الحوالة', codeMap[result?.code] || 400);
  } catch (err) {
    next(err);
  }
};

// ─── POST /payments/asiahawala/submit ─────────────────────────────────────────
// Records the customer's hawala reference on the pending transaction.
exports.asiahawalaSubmit = async (req, res, next) => {
  try {
    const { booking_id, hawala_reference } = req.body;
    if (!booking_id || !hawala_reference) {
      return error(res, 'booking_id و hawala_reference مطلوبان', 400);
    }

    const { data: tx } = await supabaseAdmin
      .from('asiahawala_transactions')
      .select('id, user_id, status')
      .eq('booking_id', booking_id)
      .eq('status', ASIA_PENDING)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!tx) return error(res, 'لا يوجد طلب حوالة معلق لهذا الحجز', 404);
    if (tx.user_id !== req.user.id) return error(res, 'ليس لديك صلاحية', 403);

    const { data: updated, error: upErr } = await supabaseAdmin
      .from('asiahawala_transactions')
      .update({
        hawala_reference: String(hawala_reference).trim(),
        updated_at:       new Date().toISOString(),
      })
      .eq('id', tx.id)
      .select('id, status, hawala_reference')
      .single();
    if (upErr) throw upErr;

    return success(res, {
      transaction_id:   updated.id,
      status:           updated.status,
      hawala_reference: updated.hawala_reference,
    }, 'تم استلام رقم الحوالة — بانتظار تأكيد الإدارة');
  } catch (err) {
    next(err);
  }
};

// ─── GET /payments/asiahawala/status/:id ──────────────────────────────────────
exports.asiahawalaStatus = async (req, res, next) => {
  try {
    const { data: tx } = await supabaseAdmin
      .from('asiahawala_transactions')
      .select('id, user_id, booking_id, status, amount, receiver_phone, hawala_reference, confirmed_at, rejection_reason')
      .eq('id', req.params.id)
      .single();

    if (!tx) return error(res, 'المعاملة غير موجودة', 404);
    if (req.user.role === 'customer' && tx.user_id !== req.user.id) {
      return error(res, 'ليس لديك صلاحية', 403);
    }
    return success(res, tx);
  } catch (err) {
    next(err);
  }
};

// ─── GET /payments/pending/:booking_id ────────────────────────────────────────
// Polls the booking payment status (used as a fallback for the realtime screen).
exports.pendingStatus = async (req, res, next) => {
  try {
    const { data, error: rpcErr } = await supabaseAdmin
      .rpc('poll_payment_status', {
        p_booking_id: req.params.booking_id,
        p_user_id:    req.user.id,
      });
    if (rpcErr) throw rpcErr;
    return success(res, data);
  } catch (err) {
    next(err);
  }
};
