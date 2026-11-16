const crypto = require('crypto');
const Coupon = require('../models/Coupon');
const CouponUsage = require('../models/CouponUsage');
const Booking = require('../models/Booking');
const User = require('../models/User');

/**
 * Resolves all candidate customer IDs for a given user (handles ObjectId string and customId)
 * @param {string} customerId
 * @returns {Promise<string[]>}
 */
async function resolveCustomerCandidateIds(customerId) {
  if (!customerId) return [];
  const candidateIds = [String(customerId)];
  try {
    const isMongoId = /^[0-9a-fA-F]{24}$/.test(String(customerId));
    const userDoc = await User.findOne({
      $or: [
        { _id: isMongoId ? customerId : null },
        { customId: customerId },
      ],
    }).select('_id customId').lean();

    if (userDoc) {
      if (userDoc._id) candidateIds.push(userDoc._id.toString());
      if (userDoc.customId) candidateIds.push(userDoc.customId);
    }
  } catch (err) {
    // Non-fatal fallback
  }
  return [...new Set(candidateIds)];
}

/**
 * Checks whether the customer is a first-time customer (has 0 non-cancelled bookings)
 * @param {string} customerId
 * @returns {Promise<boolean>}
 */
async function isFirstTimeCustomer(customerId) {
  if (!customerId) return false;
  const candidateIds = await resolveCustomerCandidateIds(customerId);
  const priorBookings = await Booking.countDocuments({
    customerId: { $in: candidateIds },
    status: { $nin: ['CANCELLED', 'REJECTED'] },
  });
  return priorBookings === 0;
}

/**
 * Pure calculation of coupon discount on a given subtotal
 * @param {object} coupon
 * @param {number} subtotal
 * @param {object} [context]
 * @returns {{ valid: boolean, discount: number, originalAmount: number, finalAmount: number, discountText: string, error?: string }}
 */
function calculateCouponDiscount(coupon, subtotal, { service = 'all', category = 'all' } = {}) {
  const minRequired = coupon.minOrderAmount || (coupon.amount ? coupon.amount * 4 : 299);
  if (subtotal < minRequired) {
    return {
      valid: false,
      discount: 0,
      originalAmount: subtotal,
      finalAmount: subtotal,
      discountText: '₹0',
      error: `Minimum order amount of ₹${minRequired} required for coupon ${coupon.code}.`,
      code: 'MIN_ORDER_NOT_MET',
    };
  }

  if (coupon.applicableCategory && coupon.applicableCategory !== 'all' && category && category !== 'all' && coupon.applicableCategory !== category) {
    return {
      valid: false,
      discount: 0,
      originalAmount: subtotal,
      finalAmount: subtotal,
      discountText: '₹0',
      error: `Coupon ${coupon.code} is only valid for category "${coupon.applicableCategory}".`,
      code: 'CATEGORY_MISMATCH',
    };
  }

  if (coupon.applicableService && coupon.applicableService !== 'all' && service && service !== 'all' && coupon.applicableService !== service) {
    return {
      valid: false,
      discount: 0,
      originalAmount: subtotal,
      finalAmount: subtotal,
      discountText: '₹0',
      error: `Coupon ${coupon.code} is only valid for service "${coupon.applicableService}".`,
      code: 'SERVICE_MISMATCH',
    };
  }

  let discount = 0;
  const maxCap = coupon.maxDiscount || 250;
  const isPercentage = coupon.discountType === 'percentage' || Boolean(coupon.percent && coupon.percent > 0);

  if (isPercentage) {
    const rate = coupon.percent || coupon.discountValue || 0;
    discount = Math.min(maxCap, Math.round((subtotal * rate) / 100));
  } else {
    const flatAmount = coupon.amount || coupon.discountValue || 0;
    discount = Math.min(subtotal, flatAmount);
  }

  const finalAmount = Math.max(0, subtotal - discount);

  return {
    valid: true,
    discount,
    originalAmount: subtotal,
    finalAmount,
    discountText: `₹${discount}`,
  };
}

/**
 * Validates a coupon code for eligibility and calculates discount
 * @param {object} params
 * @returns {Promise<object>}
 */
async function validateCouponCode({ code, customerId = null, subtotal = 0, service = 'all', category = 'all' }) {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'Coupon code is required.', code: 'CODE_REQUIRED' };
  }

  const upperCode = code.trim().toUpperCase();
  const coupon = await Coupon.findOne({ code: upperCode });

  if (!coupon) {
    return {
      valid: false,
      error: `Invalid coupon code "${upperCode}". Please check and try again.`,
      code: 'INVALID_COUPON',
    };
  }

  if (coupon.active === false || coupon.is_visible === false) {
    return {
      valid: false,
      error: `Coupon ${upperCode} is currently inactive or disabled.`,
      code: 'COUPON_INACTIVE',
    };
  }

  const now = new Date();
  if (coupon.startDate && new Date(coupon.startDate) > now) {
    return {
      valid: false,
      error: `Coupon ${upperCode} is not active yet.`,
      code: 'COUPON_NOT_STARTED',
    };
  }

  if (coupon.expiresAt && new Date(coupon.expiresAt) < now) {
    return {
      valid: false,
      error: `Coupon ${upperCode} has expired.`,
      code: 'COUPON_EXPIRED',
    };
  }

  // Global usage limit check
  if (coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit) {
    return {
      valid: false,
      error: `Coupon ${upperCode} has reached its maximum usage limit.`,
      code: 'USAGE_LIMIT_REACHED',
    };
  }

  // First-order coupon restriction (e.g. FIRST100)
  if (coupon.newCustomerOnly) {
    if (!customerId) {
      return {
        valid: false,
        error: `Please log in to apply first-order coupon ${upperCode}.`,
        code: 'AUTH_REQUIRED_FIRST_ORDER',
      };
    }
    const isNew = await isFirstTimeCustomer(customerId);
    if (!isNew) {
      return {
        valid: false,
        error: `Coupon ${upperCode} is exclusively valid for first-time customers.`,
        code: 'FIRST_ORDER_ONLY',
      };
    }
  }

  // Per-customer usage limit check
  if (customerId) {
    const candidateIds = await resolveCustomerCandidateIds(customerId);
    const redeemedCount = await CouponUsage.countDocuments({
      couponCode: coupon.code,
      customerId: { $in: candidateIds },
      status: 'redeemed',
    });
    const maxUses = coupon.perUserLimit || 1;
    if (redeemedCount >= maxUses) {
      return {
        valid: false,
        error: `You have already redeemed coupon ${upperCode} (maximum ${maxUses} use${maxUses > 1 ? 's' : ''}).`,
        code: 'COUPON_ALREADY_USED',
      };
    }
  }

  // Discount calculation
  const parsedSubtotal = parseInt(String(subtotal || 0).replace(/[^0-9]/g, ''), 10) || 0;
  const calc = calculateCouponDiscount(coupon, parsedSubtotal, { service, category });
  if (!calc.valid) {
    return {
      valid: false,
      error: calc.error,
      code: calc.code,
      coupon: {
        code: coupon.code,
        title: coupon.title,
        minOrderAmount: coupon.minOrderAmount,
      },
    };
  }

  return {
    valid: true,
    code: coupon.code,
    couponId: coupon._id,
    title: coupon.title,
    description: coupon.description,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    discount: calc.discount,
    discountText: calc.discountText,
    originalAmount: calc.originalAmount,
    finalAmount: calc.finalAmount,
    minOrderAmount: coupon.minOrderAmount,
    maxDiscount: coupon.maxDiscount,
    newCustomerOnly: Boolean(coupon.newCustomerOnly),
    message: `Coupon ${coupon.code} applied! You save ${calc.discountText}.`,
  };
}

/**
 * Creates a 10-minute hold reservation on a coupon for checkout
 * @param {object} params
 * @returns {Promise<object>}
 */
async function reserveCoupon({ code, customerId, subtotal, service = 'all', category = 'all', reservationTtlMinutes = 10 }) {
  if (!customerId) {
    throw { status: 401, message: 'Customer authentication required to reserve a coupon.', code: 'AUTH_REQUIRED' };
  }

  const candidateIds = await resolveCustomerCandidateIds(customerId);

  // Clean up any stale expired reservations for this customer
  await CouponUsage.updateMany(
    {
      customerId: { $in: candidateIds },
      status: 'reserved',
      expiresAt: { $lt: new Date() },
    },
    { $set: { status: 'expired' } }
  );

  const validation = await validateCouponCode({
    code,
    customerId,
    subtotal,
    service,
    category,
  });

  if (!validation.valid) {
    throw { status: 400, message: validation.error, code: validation.code || 'COUPON_INVALID' };
  }

  const coupon = await Coupon.findOne({ code: validation.code });
  if (!coupon) {
    throw { status: 404, message: 'Coupon not found.', code: 'COUPON_NOT_FOUND' };
  }

  // Calculate target redemptionIndex
  const redeemedCount = await CouponUsage.countDocuments({
    couponCode: coupon.code,
    customerId: { $in: candidateIds },
    status: 'redeemed',
  });
  const targetIndex = redeemedCount + 1;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + reservationTtlMinutes * 60 * 1000);

  // Check if customer already has an active reservation for this coupon
  let existingReservation = await CouponUsage.findOne({
    couponCode: coupon.code,
    customerId: { $in: candidateIds },
    status: 'reserved',
    expiresAt: { $gte: now },
  });

  if (existingReservation) {
    // Refresh existing active reservation
    existingReservation.expiresAt = expiresAt;
    existingReservation.discountAmount = validation.discount;
    existingReservation.originalAmount = validation.originalAmount;
    existingReservation.finalAmount = validation.finalAmount;
    await existingReservation.save();

    return {
      success: true,
      reservationId: existingReservation.reservationId,
      code: coupon.code,
      discount: validation.discount,
      discountText: validation.discountText,
      originalAmount: validation.originalAmount,
      finalAmount: validation.finalAmount,
      expiresAt: existingReservation.expiresAt,
      message: `Coupon ${coupon.code} reserved for checkout.`,
    };
  }

  const reservationId = `RES-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  try {
    const createdUsage = await CouponUsage.create({
      couponId: coupon._id,
      couponCode: coupon.code,
      customerId: String(customerId),
      reservationId,
      discountAmount: validation.discount,
      originalAmount: validation.originalAmount,
      finalAmount: validation.finalAmount,
      status: 'reserved',
      redemptionIndex: targetIndex,
      reservedAt: now,
      expiresAt,
      usedAt: now,
    });

    return {
      success: true,
      reservationId: createdUsage.reservationId,
      code: coupon.code,
      discount: validation.discount,
      discountText: validation.discountText,
      originalAmount: validation.originalAmount,
      finalAmount: validation.finalAmount,
      expiresAt: createdUsage.expiresAt,
      message: `Coupon ${coupon.code} applied! You save ${validation.discountText}.`,
    };
  } catch (err) {
    if (err.code === 11000) {
      // Race condition: another reservation or redemption happened concurrently
      throw {
        status: 409,
        message: `Coupon ${coupon.code} is already in use or being processed.`,
        code: 'COUPON_ALREADY_USED',
      };
    }
    throw err;
  }
}

/**
 * Releases a coupon reservation (e.g. customer removed coupon or cancelled checkout)
 * @param {object} params
 * @returns {Promise<object>}
 */
async function releaseCouponReservation({ reservationId = null, customerId = null, code = null }) {
  const filter = {};
  if (reservationId) {
    filter.reservationId = reservationId;
  } else if (customerId && code) {
    const candidateIds = await resolveCustomerCandidateIds(customerId);
    filter.customerId = { $in: candidateIds };
    filter.couponCode = String(code).trim().toUpperCase();
    filter.status = 'reserved';
  } else {
    throw { status: 400, message: 'Reservation ID or customer ID with coupon code is required.', code: 'INVALID_PARAMS' };
  }

  const updated = await CouponUsage.updateMany(
    filter,
    {
      $set: {
        status: 'released',
        releasedAt: new Date(),
      },
    }
  );

  return {
    success: true,
    releasedCount: updated.modifiedCount || 0,
    message: 'Coupon removed successfully.',
  };
}

/**
 * Finalizes coupon redemption atomically on booking confirmation
 * @param {object} params
 * @returns {Promise<object>}
 */
async function finalizeCouponRedemption({
  reservationId = null,
  couponCode,
  customerId,
  bookingId,
  discountAmount,
  originalAmount = 0,
  finalAmount = 0,
}) {
  if (!couponCode || !customerId || !bookingId) {
    return { success: false, reason: 'Missing required parameters for coupon redemption.' };
  }

  const upperCode = String(couponCode).trim().toUpperCase();
  const candidateIds = await resolveCustomerCandidateIds(customerId);

  // 1. Atomically increment global usage limit with guard
  const updatedCoupon = await Coupon.findOneAndUpdate(
    {
      code: upperCode,
      active: { $ne: false },
      $or: [
        { usageLimit: { $lte: 0 } },
        { $expr: { $lt: ['$usageCount', '$usageLimit'] } },
      ],
    },
    { $inc: { usageCount: 1 } },
    { new: true }
  );

  if (!updatedCoupon) {
    throw {
      status: 400,
      message: `Coupon ${upperCode} has reached its maximum global usage limit.`,
      code: 'USAGE_LIMIT_EXCEEDED',
    };
  }

  // 2. Transition reservation to redeemed, or create direct redemption
  let usageDoc = null;
  if (reservationId) {
    usageDoc = await CouponUsage.findOneAndUpdate(
      {
        reservationId,
        customerId: { $in: candidateIds },
        status: 'reserved',
      },
      {
        $set: {
          status: 'redeemed',
          bookingId,
          discountAmount: Number(discountAmount) || 0,
          originalAmount: Number(originalAmount) || 0,
          finalAmount: Number(finalAmount) || 0,
          redeemedAt: new Date(),
          usedAt: new Date(),
        },
      },
      { new: true }
    );
  }

  if (!usageDoc) {
    // If no reservation existed, create direct redemption record atomically
    const redeemedCount = await CouponUsage.countDocuments({
      couponCode: upperCode,
      customerId: { $in: candidateIds },
      status: 'redeemed',
    });
    const maxUses = updatedCoupon.perUserLimit || 1;
    if (redeemedCount >= maxUses) {
      // Rollback global usage count increment
      await Coupon.updateOne({ _id: updatedCoupon._id }, { $inc: { usageCount: -1 } });
      throw {
        status: 400,
        message: `You have already redeemed coupon ${upperCode}.`,
        code: 'COUPON_ALREADY_USED',
      };
    }

    try {
      usageDoc = await CouponUsage.create({
        couponId: updatedCoupon._id,
        couponCode: updatedCoupon.code,
        customerId: String(customerId),
        bookingId,
        discountAmount: Number(discountAmount) || 0,
        originalAmount: Number(originalAmount) || 0,
        finalAmount: Number(finalAmount) || 0,
        status: 'redeemed',
        redemptionIndex: redeemedCount + 1,
        redeemedAt: new Date(),
        usedAt: new Date(),
      });
    } catch (err) {
      // Roll back global usageCount
      await Coupon.updateOne({ _id: updatedCoupon._id }, { $inc: { usageCount: -1 } });
      if (err.code === 11000) {
        throw {
          status: 409,
          message: `Coupon ${upperCode} has already been used on another booking.`,
          code: 'COUPON_ALREADY_USED',
        };
      }
      throw err;
    }
  }

  return {
    success: true,
    usageId: usageDoc._id,
    couponCode: upperCode,
    discount: discountAmount,
    bookingId,
  };
}

/**
 * Rolls back a coupon redemption (e.g. booking was cancelled)
 * @param {object} params
 * @returns {Promise<object>}
 */
async function rollbackCouponRedemption({ bookingId, customerId = null, couponCode = null }) {
  if (!bookingId && !couponCode) return { success: false, reason: 'Booking ID or coupon code required' };

  const query = {};
  if (bookingId) query.bookingId = bookingId;
  if (couponCode) query.couponCode = String(couponCode).toUpperCase();

  const usageDocs = await CouponUsage.find({ ...query, status: 'redeemed' });
  if (!usageDocs || usageDocs.length === 0) {
    return { success: true, message: 'No active redeemed coupons found to rollback.' };
  }

  for (const usage of usageDocs) {
    usage.status = 'released';
    usage.releasedAt = new Date();
    await usage.save();

    await Coupon.updateOne(
      { code: usage.couponCode },
      { $inc: { usageCount: -1 } }
    );
  }

  return {
    success: true,
    rolledBackCount: usageDocs.length,
    message: 'Coupon redemption rolled back successfully.',
  };
}

/**
 * Returns categorized coupons for a customer with smart eligibility badges
 * @param {object} params
 * @returns {Promise<object>}
 */
async function getAvailableCouponsForCustomer({ customerId = null, subtotal = 0, service = 'all', category = 'all' }) {
  const now = new Date();
  const parsedSubtotal = parseInt(String(subtotal || 0).replace(/[^0-9]/g, ''), 10) || 0;

  let candidateIds = [];
  let usedCodeSet = new Set();
  let isNewCustomer = false;

  if (customerId) {
    candidateIds = await resolveCustomerCandidateIds(customerId);
    const redeemedList = await CouponUsage.find({
      customerId: { $in: candidateIds },
      status: 'redeemed',
    }).select('couponCode').lean();
    usedCodeSet = new Set(redeemedList.map(u => u.couponCode));
    isNewCustomer = await isFirstTimeCustomer(customerId);
  }

  const allCoupons = await Coupon.find({
    active: { $ne: false },
    is_visible: { $ne: false },
    $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
    ],
  }).sort({ displayOrder: 1, createdAt: -1 }).lean();

  const formattedCoupons = allCoupons.map(c => {
    const isPercentage = c.discountType === 'percentage' || Boolean(c.percent && c.percent > 0);
    const discountText = isPercentage
      ? `${c.percent || c.discountValue}% OFF`
      : `₹${c.amount || c.discountValue} OFF`;

    const minRequired = c.minOrderAmount || (c.amount ? c.amount * 4 : 299);
    const alreadyUsed = usedCodeSet.has(c.code);
    const limitReached = c.usageLimit > 0 && c.usageCount >= c.usageLimit;
    const firstOrderBlocked = c.newCustomerOnly && (!customerId || !isNewCustomer);

    let isEligible = true;
    let ineligibilityReason = '';

    if (alreadyUsed) {
      isEligible = false;
      ineligibilityReason = 'Already redeemed on a previous booking';
    } else if (limitReached) {
      isEligible = false;
      ineligibilityReason = 'Offer limit reached';
    } else if (firstOrderBlocked) {
      isEligible = false;
      ineligibilityReason = 'Exclusive offer for first-time customers';
    } else if (parsedSubtotal > 0 && parsedSubtotal < minRequired) {
      isEligible = false;
      ineligibilityReason = `Add ₹${minRequired - parsedSubtotal} more to apply`;
    }

    return {
      id: c._id.toString(),
      code: c.code,
      title: c.title || (isPercentage ? `${c.percent || c.discountValue}% Instant Discount` : `Flat ₹${c.amount || c.discountValue} OFF`),
      description: c.description || `Use code ${c.code} at checkout to save on home services.`,
      discount: discountText,
      discountType: isPercentage ? 'percentage' : 'flat',
      discountValue: isPercentage ? (c.percent || c.discountValue) : (c.amount || c.discountValue),
      amount: c.amount || (isPercentage ? 0 : c.discountValue || 0),
      percent: c.percent || (isPercentage ? c.discountValue || 0 : 0),
      maxDiscount: c.maxDiscount || 250,
      minOrderAmount: minRequired,
      applicableService: c.applicableService || 'all',
      applicableCategory: c.applicableCategory || 'all',
      newCustomerOnly: Boolean(c.newCustomerOnly),
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      terms: c.terms || 'Applicable on verified HomeStepIn service bookings.',
      isEligible,
      ineligibilityReason,
      alreadyUsed,
      limitReached,
    };
  });

  return {
    coupons: formattedCoupons,
    isNewCustomer,
  };
}

/**
 * Returns customer's past redemptions
 * @param {string} customerId
 * @returns {Promise<object[]>}
 */
async function getCustomerRedemptions(customerId) {
  if (!customerId) return [];
  const candidateIds = await resolveCustomerCandidateIds(customerId);
  return CouponUsage.find({
    customerId: { $in: candidateIds },
    status: 'redeemed',
  })
    .sort({ redeemedAt: -1 })
    .lean();
}

/**
 * Returns coupon management analytics for Admin
 * @param {string} couponIdOrCode
 * @returns {Promise<object>}
 */
async function getCouponAnalytics(couponIdOrCode) {
  const coupon = await Coupon.findOne({
    $or: [
      { code: String(couponIdOrCode).toUpperCase() },
      { _id: /^[0-9a-fA-F]{24}$/.test(couponIdOrCode) ? couponIdOrCode : null },
    ],
  }).lean();

  if (!coupon) return null;

  const usages = await CouponUsage.find({
    couponCode: coupon.code,
    status: 'redeemed',
  }).lean();

  const totalRedemptions = usages.length;
  const uniqueCustomers = new Set(usages.map(u => u.customerId)).size;
  const totalDiscountGranted = usages.reduce((sum, u) => sum + (u.discountAmount || 0), 0);
  const totalOrderValueGenerated = usages.reduce((sum, u) => sum + (u.originalAmount || 0), 0);

  return {
    couponCode: coupon.code,
    title: coupon.title,
    totalRedemptions,
    uniqueCustomers,
    totalDiscountGranted,
    totalOrderValueGenerated,
    usageLimit: coupon.usageLimit,
    remainingUses: coupon.usageLimit > 0 ? Math.max(0, coupon.usageLimit - totalRedemptions) : 'Unlimited',
    active: coupon.active !== false && coupon.is_visible !== false,
    newCustomerOnly: Boolean(coupon.newCustomerOnly),
  };
}

module.exports = {
  resolveCustomerCandidateIds,
  isFirstTimeCustomer,
  calculateCouponDiscount,
  validateCouponCode,
  reserveCoupon,
  releaseCouponReservation,
  finalizeCouponRedemption,
  rollbackCouponRedemption,
  getAvailableCouponsForCustomer,
  getCustomerRedemptions,
  getCouponAnalytics,
};
