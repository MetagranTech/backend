const crypto = require('crypto');
const FinanceOutbox = require('../models/FinanceOutbox');
const { getFinanceConnection, connectFinanceDb } = require('../financeDb');
const { getFinanceModels } = require('../models/financeModels');

function roundInr(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function genId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function getModels() {
  const conn = getFinanceConnection();
  if (!conn || conn.readyState !== 1) {
    const err = new Error('Finance database is temporarily unavailable.');
    err.code = 'FINANCE_DB_UNAVAILABLE';
    err.status = 503;
    throw err;
  }
  return getFinanceModels(conn);
}

async function getOrCreatePartnerAccount(models, partnerId, partnerName = '') {
  let account = await models.PartnerFinancialAccount.findOne({ partnerId: String(partnerId) });
  if (!account) {
    try {
      account = await models.PartnerFinancialAccount.create({
        partnerId: String(partnerId),
        partnerName: partnerName || '',
      });
    } catch (dup) {
      if (dup && dup.code === 11000) {
        account = await models.PartnerFinancialAccount.findOne({ partnerId: String(partnerId) });
      } else {
        throw dup;
      }
    }
  } else if (partnerName && !account.partnerName) {
    account.partnerName = partnerName;
    await account.save();
  }
  return account;
}

async function getActiveCommissionConfig(asOfDate = new Date()) {
  const models = getModels();
  const targetDate = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);

  const active = await models.PlatformCommission.findOne({
    isActive: true,
    effectiveFrom: { $lte: targetDate },
  })
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .lean();

  if (active) {
    return active;
  }

  // Fallback to any configured policy if effectiveFrom is in future or initial setup
  const anyPolicy = await models.PlatformCommission.findOne({ isActive: true })
    .sort({ createdAt: -1 })
    .lean();

  if (anyPolicy) {
    return anyPolicy;
  }

  // Bootstrap initial policy from environment if DB has zero policies yet
  const initialRate = Number(process.env.INITIAL_PLATFORM_COMMISSION_PERCENT);
  const safeRate = Number.isFinite(initialRate) && initialRate >= 0 && initialRate <= 100 ? roundInr(initialRate) : 15;

  const created = await models.PlatformCommission.create({
    commissionId: genId('comm'),
    ratePercent: safeRate,
    effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
    isActive: true,
    updatedBy: 'system_bootstrap',
    reason: 'Initial platform commission configuration (admin-editable)',
  });

  return created.toObject();
}

async function setCommissionConfig({ ratePercent, effectiveFrom, adminId, reason }) {
  const rate = Number(ratePercent);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    const err = new Error('Commission rate must be between 0 and 100.');
    err.status = 400;
    throw err;
  }
  if (!adminId) {
    const err = new Error('Admin identity is required.');
    err.status = 403;
    throw err;
  }

  const models = getModels();
  const effectiveDate = effectiveFrom ? new Date(effectiveFrom) : new Date();
  if (Number.isNaN(effectiveDate.getTime())) {
    const err = new Error('Invalid effectiveFrom date.');
    err.status = 400;
    throw err;
  }

  const prev = await models.PlatformCommission.findOne({ isActive: true }).sort({ createdAt: -1 }).lean();

  const created = await models.PlatformCommission.create({
    commissionId: genId('comm'),
    ratePercent: roundInr(rate),
    effectiveFrom: effectiveDate,
    isActive: true,
    updatedBy: String(adminId),
    reason: (reason && String(reason).trim()) || 'Admin updated platform commission rate',
  });

  await models.FinancialAuditLog.create({
    auditId: genId('faud'),
    action: 'COMMISSION_CONFIG_UPDATED',
    actorId: String(adminId),
    actorRole: 'admin',
    amount: roundInr(rate),
    beforeState: prev ? { ratePercent: prev.ratePercent, effectiveFrom: prev.effectiveFrom } : null,
    afterState: { ratePercent: created.ratePercent, effectiveFrom: created.effectiveFrom },
    metadata: { reason: created.reason, commissionId: created.commissionId },
  });

  return created;
}

/**
 * Enqueue a COD collection event in the Main DB FinanceOutbox (idempotent).
 */
async function enqueueCodCollectionEvent({ booking, payment, collectedBy, collectedAt }) {
  const bookingId = String(booking.customId || booking._id);
  const partnerId = String(booking.providerId || booking.worker || collectedBy);
  const amount = roundInr(
    payment?.amount ||
      booking.codConfirmedAmount ||
      booking.priceNum ||
      (typeof booking.price === 'string' ? parseFloat(booking.price.replace(/[^0-9.]/g, '')) : 0)
  );

  if (!bookingId || !partnerId || amount <= 0) {
    throw new Error('Invalid booking, partnerId, or amount for COD finance event.');
  }

  const eventId = `fin_cod_${bookingId}`;
  const existing = await FinanceOutbox.findOne({ eventId });
  if (existing) {
    if (existing.status !== 'SYNCED') {
      setImmediate(() => {
        processFinanceOutbox().catch(() => {});
      });
    }
    return existing;
  }

  const doc = await FinanceOutbox.create({
    eventId,
    eventType: 'COD_COLLECTION',
    bookingId,
    partnerId,
    customerId: String(booking.customerId || booking.customer || ''),
    amount,
    payload: {
      bookingId,
      partnerId,
      partnerName: booking.providerName || '',
      customerId: String(booking.customerId || booking.customer || ''),
      service: booking.service || 'Home Service',
      amount,
      paymentId: payment?.customId || null,
      collectedBy: String(collectedBy || partnerId),
      collectedAt: (collectedAt || new Date()).toISOString(),
    },
    status: 'PENDING',
    attempts: 0,
    nextRetryAt: new Date(),
  });

  setImmediate(() => {
    processFinanceOutbox().catch(() => {});
  });

  return doc;
}

let activeFinanceOutboxPromise = null;
let financeOutboxNeedsAnotherPass = false;

async function processSingleOutboxEvent(job) {
  const models = getModels();
  const payload = job.payload || {};
  const bookingId = String(job.bookingId);
  const partnerId = String(job.partnerId);
  const grossAmount = roundInr(job.amount);
  const collectedAt = payload.collectedAt ? new Date(payload.collectedAt) : new Date();

  const account = await getOrCreatePartnerAccount(models, partnerId, payload.partnerName || '');

  // Idempotency check in Finance DB: has this bookingId already been recorded?
  const existingCollection = await models.CODCollection.findOne({ bookingId }).lean();
  const existingEarning = await models.PartnerEarning.findOne({ bookingId }).lean();

  if (existingCollection && existingEarning) {
    return { alreadySynced: true, bookingId };
  }

  const commissionPolicy = await getActiveCommissionConfig(collectedAt);
  const ratePercent = roundInr(commissionPolicy.ratePercent);
  const commissionAmount = roundInr((grossAmount * ratePercent) / 100);
  const netAmount = roundInr(grossAmount - commissionAmount);

  if (!existingCollection) {
    try {
      await models.CODCollection.create({
        collectionId: genId('codc'),
        eventId: `${job.eventId}_cod`,
        bookingId,
        partnerId,
        customerId: payload.customerId || null,
        amount: grossAmount,
        currency: 'INR',
        collectedBy: String(payload.collectedBy || partnerId),
        collectedAt,
        status: 'COLLECTED',
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }

  if (!existingEarning) {
    try {
      await models.PartnerEarning.create({
        earningId: genId('earn'),
        eventId: `${job.eventId}_earn`,
        bookingId,
        partnerId,
        customerId: payload.customerId || null,
        service: payload.service || 'Home Service',
        grossAmount,
        commissionRatePercent: ratePercent,
        commissionAmount,
        netAmount,
        currency: 'INR',
        status: 'EARNED',
        earnedAt: collectedAt,
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }

    // Append-only FinancialLedger entries (with unique eventIds to prevent duplicate ledger impact)
    const beforeOutstanding = roundInr(account.outstandingCommission);
    const afterOutstanding = roundInr(beforeOutstanding + commissionAmount);
    const beforeNet = roundInr(account.netEarnings);
    const afterNet = roundInr(beforeNet + netAmount);

    const ledgerEntries = [
      {
        ledgerId: genId('led'),
        eventId: `${job.eventId}_led_cod`,
        partnerId,
        bookingId,
        entryType: 'COD_COLLECTED',
        direction: 'CREDIT',
        amount: grossAmount,
        currency: 'INR',
        balanceBefore: roundInr(account.totalCodCollected),
        balanceAfter: roundInr(account.totalCodCollected + grossAmount),
        description: `COD cash collected for Booking #${bookingId} (${payload.service || 'Service'})`,
        actorId: String(payload.collectedBy || partnerId),
        actorRole: 'worker',
        metadata: { commissionRatePercent: ratePercent },
      },
      {
        ledgerId: genId('led'),
        eventId: `${job.eventId}_led_comm`,
        partnerId,
        bookingId,
        entryType: 'COMMISSION_ACCRUED',
        direction: 'DEBIT',
        amount: commissionAmount,
        currency: 'INR',
        balanceBefore: beforeOutstanding,
        balanceAfter: afterOutstanding,
        description: `Platform commission (${ratePercent}%) payable on Booking #${bookingId}`,
        actorId: 'system_finance',
        actorRole: 'system',
        metadata: { ratePercent, grossAmount },
      },
      {
        ledgerId: genId('led'),
        eventId: `${job.eventId}_led_net`,
        partnerId,
        bookingId,
        entryType: 'PARTNER_NET_EARNING',
        direction: 'CREDIT',
        amount: netAmount,
        currency: 'INR',
        balanceBefore: beforeNet,
        balanceAfter: afterNet,
        description: `Partner net earning for Booking #${bookingId}`,
        actorId: 'system_finance',
        actorRole: 'system',
        metadata: { ratePercent, grossAmount, commissionAmount },
      },
    ];

    for (const entry of ledgerEntries) {
      try {
        await models.FinancialLedger.create(entry);
      } catch (e) {
        if (e.code !== 11000) throw e;
      }
    }

    // Update PartnerFinancialAccount summary atomically
    await models.PartnerFinancialAccount.updateOne(
      { partnerId },
      {
        $inc: {
          totalCodCollected: grossAmount,
          grossEarnings: grossAmount,
          netEarnings: netAmount,
          totalCommissionPayable: commissionAmount,
          outstandingCommission: commissionAmount,
          completedCodBookingsCount: 1,
        },
        $set: { lastReconciledAt: new Date() },
      }
    );

    await models.FinancialAuditLog.create({
      auditId: genId('faud'),
      action: 'COD_EVENT_SYNCED_TO_FINANCE',
      actorId: String(payload.collectedBy || partnerId),
      actorRole: 'system',
      partnerId,
      bookingId,
      amount: grossAmount,
      beforeState: { outstandingCommission: beforeOutstanding, netEarnings: beforeNet },
      afterState: { outstandingCommission: afterOutstanding, netEarnings: afterNet },
      metadata: { ratePercent, commissionAmount, netAmount },
    });
  }

  return { synced: true, bookingId, grossAmount, commissionAmount, netAmount };
}

async function processFinanceOutbox() {
  if (activeFinanceOutboxPromise) {
    financeOutboxNeedsAnotherPass = true;
    return activeFinanceOutboxPromise;
  }

  activeFinanceOutboxPromise = (async () => {
    let processed = 0;
    let failed = 0;

    try {
      // Ensure Finance DB is reachable before claiming
      try {
        await connectFinanceDb();
      } catch (connErr) {
        return { processed: 0, failed: 0, error: connErr.message };
      }

      do {
        financeOutboxNeedsAnotherPass = false;
        const now = new Date();
        const pendingJobs = await FinanceOutbox.find({
          status: { $in: ['PENDING', 'FAILED'] },
          nextRetryAt: { $lte: now },
          attempts: { $lt: 20 },
        })
          .sort({ createdAt: 1 })
          .limit(50);

        for (const job of pendingJobs) {
          const locked = await FinanceOutbox.findOneAndUpdate(
            { _id: job._id, status: { $in: ['PENDING', 'FAILED'] } },
            { $set: { status: 'PROCESSING' }, $inc: { attempts: 1 } },
            { new: true }
          );
          if (!locked) continue;

          try {
            await processSingleOutboxEvent(locked);
            await FinanceOutbox.updateOne(
              { _id: locked._id },
              { $set: { status: 'SYNCED', syncedAt: new Date(), lastError: null } }
            );
            processed++;
          } catch (err) {
            const delayMs = Math.min(300000, Math.pow(2, locked.attempts) * 1000);
            await FinanceOutbox.updateOne(
              { _id: locked._id },
              {
                $set: {
                  status: 'FAILED',
                  lastError: err.message,
                  nextRetryAt: new Date(Date.now() + delayMs),
                },
              }
            );
            failed++;
          }
        }
      } while (financeOutboxNeedsAnotherPass);
    } finally {
      activeFinanceOutboxPromise = null;
    }

    return { processed, failed };
  })();

  return activeFinanceOutboxPromise;
}

/**
 * Reconcile Main DB completed COD bookings/payments with Finance DB.
 */
async function reconcileFinanceDatabase({ BookingModel, PaymentModel }) {
  await connectFinanceDb();
  const models = getModels();

  const paidCodBookings = await BookingModel.find({
    paymentStatus: { $in: ['PAID', 'COD_COLLECTED'] },
    $or: [{ paymentMethod: 'CASH_ON_DELIVERY' }, { codCollectedAt: { $ne: null } }],
  }).lean();

  let enqueuedCount = 0;
  for (const b of paidCodBookings) {
    const bKey = String(b.customId || b._id);
    const existing = await models.CODCollection.findOne({ bookingId: bKey }).lean();
    if (!existing) {
      const pay = PaymentModel
        ? await PaymentModel.findOne({ bookingId: bKey, method: 'CASH_ON_DELIVERY' }).lean()
        : null;
      await enqueueCodCollectionEvent({
        booking: b,
        payment: pay,
        collectedBy: b.codCollectedBy || b.providerId,
        collectedAt: b.codCollectedAt || b.finishedAt || b.updatedAt || new Date(),
      });
      enqueuedCount++;
    }
  }

  const outboxRes = await processFinanceOutbox();
  return {
    checkedBookings: paidCodBookings.length,
    missingEnqueued: enqueuedCount,
    ...outboxRes,
  };
}

// ── Partner APIs ──────────────────────────────────────────────────────

async function getPartnerFinancialSummary(partnerId) {
  const models = getModels();
  const pid = String(partnerId);
  const account = await getOrCreatePartnerAccount(models, pid);
  const activeCommission = await getActiveCommissionConfig();
  const pendingSettlements = await models.PartnerAdminSettlement.countDocuments({
    partnerId: pid,
    status: 'PENDING',
  });

  return {
    partnerId: pid,
    currency: 'INR',
    totalCodCollected: roundInr(account.totalCodCollected),
    grossEarnings: roundInr(account.grossEarnings),
    netEarnings: roundInr(account.netEarnings),
    totalCommissionPayable: roundInr(account.totalCommissionPayable),
    commissionPaid: roundInr(account.commissionPaid),
    outstandingCommission: roundInr(account.outstandingCommission),
    totalAdjustments: roundInr(account.totalAdjustments),
    totalSettlements: roundInr(account.totalSettlements),
    pendingSettlementsCount: pendingSettlements,
    completedCodBookingsCount: account.completedCodBookingsCount || 0,
    currentCommissionRatePercent: roundInr(activeCommission.ratePercent),
    lastReconciledAt: account.lastReconciledAt,
  };
}

async function getPartnerFinancialHistory(partnerId, { page = 1, limit = 20, startDate, endDate } = {}) {
  const models = getModels();
  const pid = String(partnerId);
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const query = { partnerId: pid };
  if (startDate || endDate) {
    query.earnedAt = {};
    if (startDate) query.earnedAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query.earnedAt.$lte = end;
    }
  }

  const [earnings, total, settlements, ledger] = await Promise.all([
    models.PartnerEarning.find(query)
      .sort({ earnedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    models.PartnerEarning.countDocuments(query),
    models.PartnerAdminSettlement.find({ partnerId: pid }).sort({ submittedAt: -1 }).limit(50).lean(),
    models.FinancialLedger.find({ partnerId: pid }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  return {
    transactions: earnings.map(e => ({
      earningId: e.earningId,
      bookingId: e.bookingId,
      service: e.service,
      codCollectedAmount: roundInr(e.grossAmount),
      commissionRatePercent: roundInr(e.commissionRatePercent),
      commissionAmount: roundInr(e.commissionAmount),
      netAmount: roundInr(e.netAmount),
      status: e.status,
      transactionDate: e.earnedAt,
    })),
    settlements,
    ledger,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum) || 1,
    },
  };
}

async function submitPartnerSettlement(partnerId, { amount, paymentMethod, utrReference, paymentProofUrl, notes, idempotencyKey }) {
  const models = getModels();
  const pid = String(partnerId);
  const amt = roundInr(amount);

  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('Settlement amount must be a positive number.');
    err.status = 400;
    throw err;
  }

  const method = String(paymentMethod || '').toUpperCase();
  if (!['UPI', 'GPAY', 'BANK_TRANSFER'].includes(method)) {
    const err = new Error('Payment method must be UPI, GPAY, or BANK_TRANSFER.');
    err.status = 400;
    throw err;
  }

  const utr = String(utrReference || '').trim();
  if (!utr || utr.length < 4) {
    const err = new Error('A valid UTR / transaction reference number is required.');
    err.status = 400;
    throw err;
  }

  if (idempotencyKey) {
    const existing = await models.PartnerAdminSettlement.findOne({ idempotencyKey: String(idempotencyKey) }).lean();
    if (existing) {
      return existing;
    }
  }

  const account = await getOrCreatePartnerAccount(models, pid);
  if (amt > roundInr(account.outstandingCommission) + 0.01) {
    const err = new Error(`Settlement amount (₹${amt}) exceeds your outstanding commission balance (₹${roundInr(account.outstandingCommission)}).`);
    err.status = 400;
    throw err;
  }

  // Always created as PENDING — never auto-marked as received!
  const settlement = await models.PartnerAdminSettlement.create({
    settlementId: genId('settle'),
    idempotencyKey: idempotencyKey ? String(idempotencyKey) : undefined,
    partnerId: pid,
    amount: amt,
    currency: 'INR',
    paymentMethod: method,
    utrReference: utr,
    paymentProofUrl: paymentProofUrl ? String(paymentProofUrl).trim() : null,
    notes: notes ? String(notes).trim() : '',
    status: 'PENDING',
    submittedAt: new Date(),
  });

  await models.PartnerFinancialAccount.updateOne(
    { partnerId: pid },
    { $inc: { pendingSettlementsCount: 1 } }
  );

  await models.FinancialAuditLog.create({
    auditId: genId('faud'),
    action: 'SETTLEMENT_SUBMITTED',
    actorId: pid,
    actorRole: 'worker',
    partnerId: pid,
    settlementId: settlement.settlementId,
    amount: amt,
    afterState: { status: 'PENDING', paymentMethod: method, utrReference: utr },
  });

  return settlement;
}

// ── Admin APIs ────────────────────────────────────────────────────────

async function getAdminFinanceOverview() {
  const models = getModels();
  const [accounts, pendingSettlements, approvedSettlements, activeCommission, pendingOutboxCount] = await Promise.all([
    models.PartnerFinancialAccount.find({}).sort({ outstandingCommission: -1 }).lean(),
    models.PartnerAdminSettlement.find({ status: 'PENDING' }).sort({ submittedAt: -1 }).lean(),
    models.PartnerAdminSettlement.find({ status: 'APPROVED' }).sort({ reviewedAt: -1 }).limit(50).lean(),
    getActiveCommissionConfig(),
    FinanceOutbox.countDocuments({ status: { $in: ['PENDING', 'FAILED'] } }),
  ]);

  const totals = accounts.reduce(
    (acc, a) => {
      acc.totalCodCollected = roundInr(acc.totalCodCollected + (a.totalCodCollected || 0));
      acc.totalGrossEarnings = roundInr(acc.totalGrossEarnings + (a.grossEarnings || 0));
      acc.totalNetEarnings = roundInr(acc.totalNetEarnings + (a.netEarnings || 0));
      acc.totalCommissionPayable = roundInr(acc.totalCommissionPayable + (a.totalCommissionPayable || 0));
      acc.totalCommissionReceived = roundInr(acc.totalCommissionReceived + (a.commissionPaid || 0));
      acc.totalOutstandingCommission = roundInr(acc.totalOutstandingCommission + (a.outstandingCommission || 0));
      acc.totalApprovedSettlementsAmount = roundInr(acc.totalApprovedSettlementsAmount + (a.totalSettlements || 0));
      return acc;
    },
    {
      totalCodCollected: 0,
      totalGrossEarnings: 0,
      totalNetEarnings: 0,
      totalCommissionPayable: 0,
      totalCommissionReceived: 0,
      totalOutstandingCommission: 0,
      totalApprovedSettlementsAmount: 0,
    }
  );

  return {
    currency: 'INR',
    overview: {
      ...totals,
      pendingSettlementsCount: pendingSettlements.length,
      approvedSettlementsCount: approvedSettlements.length,
      partnerAccountsCount: accounts.length,
      pendingSyncEventsCount: pendingOutboxCount,
    },
    commissionConfig: activeCommission,
    partnerAccounts: accounts,
    pendingSettlements,
    recentApprovedSettlements: approvedSettlements,
  };
}

async function getAdminPartnerAccount(partnerId) {
  const models = getModels();
  const pid = String(partnerId);
  const account = await getOrCreatePartnerAccount(models, pid);
  const [earnings, settlements, adjustments, ledger] = await Promise.all([
    models.PartnerEarning.find({ partnerId: pid }).sort({ earnedAt: -1 }).limit(100).lean(),
    models.PartnerAdminSettlement.find({ partnerId: pid }).sort({ submittedAt: -1 }).limit(100).lean(),
    models.FinancialAdjustment.find({ partnerId: pid }).sort({ createdAt: -1 }).limit(100).lean(),
    models.FinancialLedger.find({ partnerId: pid }).sort({ createdAt: -1 }).limit(150).lean(),
  ]);

  return {
    account,
    earnings,
    settlements,
    adjustments,
    ledger,
  };
}

async function reviewSettlement(settlementId, { action, adminId, reason }) {
  const models = getModels();
  const act = String(action || '').toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(act)) {
    const err = new Error('Action must be APPROVE or REJECT.');
    err.status = 400;
    throw err;
  }
  if (act === 'REJECT' && (!reason || !String(reason).trim())) {
    const err = new Error('A rejection reason is mandatory.');
    err.status = 400;
    throw err;
  }

  const targetStatus = act === 'APPROVE' ? 'APPROVED' : 'REJECTED';

  // Atomic transition from PENDING to APPROVED/REJECTED prevents duplicate approval race conditions
  const locked = await models.PartnerAdminSettlement.findOneAndUpdate(
    { settlementId: String(settlementId), status: 'PENDING' },
    {
      $set: {
        status: targetStatus,
        reviewedBy: String(adminId),
        reviewedAt: new Date(),
        rejectionReason: act === 'REJECT' ? String(reason).trim() : null,
      },
    },
    { new: true }
  );

  if (!locked) {
    const existing = await models.PartnerAdminSettlement.findOne({ settlementId: String(settlementId) }).lean();
    if (!existing) {
      const err = new Error('Settlement request not found.');
      err.status = 404;
      throw err;
    }
    const err = new Error(`Settlement has already been ${existing.status.toLowerCase()}. Duplicate review prevented.`);
    err.status = 409;
    err.code = 'DUPLICATE_SETTLEMENT_REVIEW';
    throw err;
  }

  const account = await getOrCreatePartnerAccount(models, locked.partnerId);
  const beforeOutstanding = roundInr(account.outstandingCommission);

  if (act === 'APPROVE') {
    const amt = roundInr(locked.amount);
    const afterOutstanding = roundInr(Math.max(0, beforeOutstanding - amt));

    await models.PartnerFinancialAccount.updateOne(
      { partnerId: locked.partnerId },
      {
        $inc: {
          commissionPaid: amt,
          totalSettlements: amt,
          pendingSettlementsCount: -1,
        },
        $set: {
          outstandingCommission: afterOutstanding,
          lastReconciledAt: new Date(),
        },
      }
    );

    await models.FinancialLedger.create({
      ledgerId: genId('led'),
      eventId: `settle_app_${locked.settlementId}`,
      partnerId: locked.partnerId,
      settlementId: locked.settlementId,
      entryType: 'SETTLEMENT_APPROVED',
      direction: 'CREDIT',
      amount: amt,
      currency: 'INR',
      balanceBefore: beforeOutstanding,
      balanceAfter: afterOutstanding,
      description: `Admin approved partner settlement ${locked.settlementId} (${locked.paymentMethod}, Ref: ${locked.utrReference})`,
      actorId: String(adminId),
      actorRole: 'admin',
      metadata: { utrReference: locked.utrReference, paymentMethod: locked.paymentMethod },
    });

    await models.FinancialAuditLog.create({
      auditId: genId('faud'),
      action: 'SETTLEMENT_APPROVED',
      actorId: String(adminId),
      actorRole: 'admin',
      partnerId: locked.partnerId,
      settlementId: locked.settlementId,
      amount: amt,
      beforeState: { outstandingCommission: beforeOutstanding, status: 'PENDING' },
      afterState: { outstandingCommission: afterOutstanding, status: 'APPROVED' },
    });
  } else {
    await models.PartnerFinancialAccount.updateOne(
      { partnerId: locked.partnerId },
      { $inc: { pendingSettlementsCount: -1 } }
    );

    await models.FinancialAuditLog.create({
      auditId: genId('faud'),
      action: 'SETTLEMENT_REJECTED',
      actorId: String(adminId),
      actorRole: 'admin',
      partnerId: locked.partnerId,
      settlementId: locked.settlementId,
      amount: roundInr(locked.amount),
      beforeState: { status: 'PENDING' },
      afterState: { status: 'REJECTED', rejectionReason: locked.rejectionReason },
    });
  }

  return locked;
}

async function createAdminAdjustment({ partnerId, type, amount, reason, adminId, idempotencyKey }) {
  const models = getModels();
  const pid = String(partnerId || '').trim();
  const adjType = String(type || '').toUpperCase();
  const amt = roundInr(amount);
  const cleanReason = String(reason || '').trim();

  if (!pid) {
    const err = new Error('Partner ID is required.');
    err.status = 400;
    throw err;
  }
  if (!['CREDIT', 'DEBIT'].includes(adjType)) {
    const err = new Error('Adjustment type must be CREDIT or DEBIT.');
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('Adjustment amount must be positive.');
    err.status = 400;
    throw err;
  }
  if (!cleanReason || cleanReason.length < 3) {
    const err = new Error('A mandatory reason is required for financial adjustments.');
    err.status = 400;
    throw err;
  }
  if (!adminId) {
    const err = new Error('Admin identity is mandatory.');
    err.status = 403;
    throw err;
  }

  const idemKey = idempotencyKey ? String(idempotencyKey) : genId('adj_idem');
  const existing = await models.FinancialAdjustment.findOne({ idempotencyKey: idemKey }).lean();
  if (existing) {
    return existing;
  }

  const account = await getOrCreatePartnerAccount(models, pid);
  const beforeOutstanding = roundInr(account.outstandingCommission);
  const beforeNet = roundInr(account.netEarnings);

  // CREDIT reduces partner's outstanding commission owed to platform (or adds to net earnings);
  // DEBIT increases partner's outstanding commission owed to platform (or deducts from net earnings).
  const afterOutstanding =
    adjType === 'CREDIT'
      ? roundInr(Math.max(0, beforeOutstanding - amt))
      : roundInr(beforeOutstanding + amt);
  const afterNet =
    adjType === 'CREDIT' ? roundInr(beforeNet + amt) : roundInr(beforeNet - amt);

  const adjustment = await models.FinancialAdjustment.create({
    adjustmentId: genId('adj'),
    idempotencyKey: idemKey,
    partnerId: pid,
    type: adjType,
    amount: amt,
    currency: 'INR',
    reason: cleanReason,
    adminId: String(adminId),
    beforeOutstanding,
    afterOutstanding,
    beforeNetEarnings: beforeNet,
    afterNetEarnings: afterNet,
  });

  await models.PartnerFinancialAccount.updateOne(
    { partnerId: pid },
    {
      $set: {
        outstandingCommission: afterOutstanding,
        netEarnings: afterNet,
        lastReconciledAt: new Date(),
      },
      $inc: {
        totalAdjustments: adjType === 'CREDIT' ? amt : -amt,
      },
    }
  );

  await models.FinancialLedger.create({
    ledgerId: genId('led'),
    eventId: `adj_${adjustment.adjustmentId}`,
    partnerId: pid,
    adjustmentId: adjustment.adjustmentId,
    entryType: adjType === 'CREDIT' ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT',
    direction: adjType,
    amount: amt,
    currency: 'INR',
    balanceBefore: beforeOutstanding,
    balanceAfter: afterOutstanding,
    description: `Admin ${adjType} adjustment: ${cleanReason}`,
    actorId: String(adminId),
    actorRole: 'admin',
    metadata: { beforeNetEarnings: beforeNet, afterNetEarnings: afterNet },
  });

  await models.FinancialAuditLog.create({
    auditId: genId('faud'),
    action: 'ADMIN_FINANCIAL_ADJUSTMENT',
    actorId: String(adminId),
    actorRole: 'admin',
    partnerId: pid,
    amount: amt,
    beforeState: { outstandingCommission: beforeOutstanding, netEarnings: beforeNet },
    afterState: { outstandingCommission: afterOutstanding, netEarnings: afterNet },
    metadata: { adjustmentId: adjustment.adjustmentId, type: adjType, reason: cleanReason },
  });

  return adjustment;
}

module.exports = {
  roundInr,
  getActiveCommissionConfig,
  setCommissionConfig,
  enqueueCodCollectionEvent,
  processFinanceOutbox,
  reconcileFinanceDatabase,
  getPartnerFinancialSummary,
  getPartnerFinancialHistory,
  submitPartnerSettlement,
  getAdminFinanceOverview,
  getAdminPartnerAccount,
  reviewSettlement,
  createAdminAdjustment,
};
