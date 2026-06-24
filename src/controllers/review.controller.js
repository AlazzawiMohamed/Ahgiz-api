const { supabaseAdmin } = require('../utils/supabase');
const { success, error } = require('../utils/response');

// GET /reviews/business/:id?page=1&limit=10
exports.getByBusiness = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const from = (page - 1) * limit;

    const { data, error: dbErr, count } = await supabaseAdmin
      .from('reviews')
      .select(`
        id, business_rating, business_comment,
        staff_rating, staff_comment, created_at,
        owner_reply, owner_reply_at,
        users ( id, full_name, avatar_url ),
        staff ( id, name, photo_url )
      `, { count: 'exact' })
      .eq('business_id', req.params.id)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .range(from, from + parseInt(limit) - 1);

    if (dbErr) throw dbErr;

    return success(res, {
      reviews: data,
      total: count,
      page: +page,
      limit: +limit,
    });
  } catch (err) {
    next(err);
  }
};

// POST /reviews
exports.create = async (req, res, next) => {
  try {
    const { booking_id, business_rating, business_comment, staff_id, staff_rating } = req.body;

    if (!booking_id)      return error(res, 'booking_id مطلوب', 400);
    if (!business_rating) return error(res, 'business_rating مطلوب', 400);

    if (![1, 2, 3, 4, 5].includes(Number(business_rating))) {
      return error(res, 'business_rating يجب أن يكون بين 1 و 5', 400);
    }
    if (staff_rating !== undefined && ![1, 2, 3, 4, 5].includes(Number(staff_rating))) {
      return error(res, 'staff_rating يجب أن يكون بين 1 و 5', 400);
    }

    const { data: result, error: rpcErr } = await supabaseAdmin.rpc('create_review', {
      p_booking_id:       booking_id,
      p_customer_id:      req.user.id,
      p_business_rating:  Number(business_rating),
      p_business_comment: business_comment || null,
      p_staff_id:         staff_id || null,
      p_staff_rating:     staff_rating ? Number(staff_rating) : null,
    });

    if (rpcErr) throw rpcErr;

    if (!result?.success) {
      const code = result?.code;
      if (code === 'NO_COMPLETED_BOOKING') return error(res, result.message || 'يجب إكمال الموعد قبل التقييم', 404);
      if (code === 'FEATURE_NOT_AVAILABLE') return error(res, result.message || 'التقييمات غير متاحة لهذا المحل', 403);
      return error(res, 'حدث خطأ أثناء إنشاء التقييم', 500);
    }

    // Mark the booking as reviewed (best-effort — review is already persisted)
    const { error: flagErr } = await supabaseAdmin
      .from('bookings')
      .update({ is_reviewed: true })
      .eq('id', booking_id);
    if (flagErr) console.error('failed to set bookings.is_reviewed:', flagErr.message);

    return success(res, { review_id: result.review_id }, 'تم إضافة التقييم بنجاح', 201);
  } catch (err) {
    next(err);
  }
};
