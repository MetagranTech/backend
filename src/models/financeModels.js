const mongoose = require('mongoose');

function getFinanceModels(conn) {
  if (!conn) {
    throw new Error('Finance MongoDB connection is not initialized.');
  }

  if (conn.models && conn.models.PartnerFinancialAccount) {
    return {
      PartnerFinancialAccount: conn.models.PartnerFinancialAccount,
      PartnerEarning: conn.models.PartnerEarning,
      CODCollection: conn.models.CODCollection,
      PlatformCommission: conn.models.PlatformCommission,
      PartnerAdminSettlement: conn.models.PartnerAdminSettlement,
      FinancialAdjustment: conn.models.FinancialAdjustment,
      FinancialLedger: conn.models.FinancialLedger,
      FinancialAuditLog: conn.models.FinancialAuditLog,
    };
  }

  const partnerFinancialAccountSchema = new mongoose.Schema(
    {
      partnerId: { type: String, required: true, unique: true, index: true },
      partnerName: { type: String, default: '' },
      currency: { type: String, default: 'INR' },
      totalCodCollected: { type: Number, default: 0 },
      grossEarnings: { type: Number, default: 0 },
      netEarnings: { type: Number, default: 0 },
      totalCommissionPayable: { type: Number, default: 0 },
      commissionPaid: { type: Number, default: 0 },
      outstandingCommission: { type: Number, default: 0 },
      totalAdjustments: { type: Number, default: 0 },
      totalSettlements: { type: Number, default: 0 },
      pendingSettlementsCount: { type: Number, default: 0 },
      completedCodBookingsCount: { type: Number, default: 0 },
      lastReconciledAt: { type: Date, default: null },
    },
    { timestamps: true }
  );

  const partnerEarningSchema = new mongoose.Schema(
    {
      earningId: { type: String, required: true, unique: true, index: true },
      eventId: { type: String, required: true, unique: true, index: true },
      bookingId: { type: String, required: true, unique: true, index: true },
      partnerId: { type: String, required: true, index: true },
      customerId: { type: String, default: null },
      service: { type: String, default: 'Home Service' },
      grossAmount: { type: Number, required: true },
      commissionRatePercent: { type: Number, required: true },
      commissionAmount: { type: Number, required: true },
      netAmount: { type: Number, required: true },
      currency: { type: String, default: 'INR' },
      status: { type: String, enum: ['EARNED', 'REVERSED'], default: 'EARNED', index: true },
      earnedAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true }
  );

  const codCollectionSchema = new mongoose.Schema(
    {
      collectionId: { type: String, required: true, unique: true, index: true },
      eventId: { type: String, required: true, unique: true, index: true },
      bookingId: { type: String, required: true, unique: true, index: true },
      partnerId: { type: String, required: true, index: true },
      customerId: { type: String, default: null },
      amount: { type: Number, required: true },
      currency: { type: String, default: 'INR' },
      collectedBy: { type: String, required: true },
      collectedAt: { type: Date, required: true, index: true },
      status: { type: String, enum: ['COLLECTED', 'REVERSED'], default: 'COLLECTED', index: true },
    },
    { timestamps: true }
  );

  const platformCommissionSchema = new mongoose.Schema(
    {
      commissionId: { type: String, required: true, unique: true, index: true },
      ratePercent: { type: Number, required: true, min: 0, max: 100 },
      effectiveFrom: { type: Date, required: true, index: true },
      isActive: { type: Boolean, default: true, index: true },
      updatedBy: { type: String, required: true },
      reason: { type: String, default: 'Platform commission policy' },
    },
    { timestamps: true }
  );

  const partnerAdminSettlementSchema = new mongoose.Schema(
    {
      settlementId: { type: String, required: true, unique: true, index: true },
      idempotencyKey: { type: String, unique: true, sparse: true, index: true },
      partnerId: { type: String, required: true, index: true },
      amount: { type: Number, required: true, min: 0.01 },
      currency: { type: String, default: 'INR' },
      paymentMethod: { type: String, enum: ['UPI', 'GPAY', 'BANK_TRANSFER'], required: true },
      utrReference: { type: String, required: true },
      paymentProofUrl: { type: String, default: null },
      notes: { type: String, default: '' },
      status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', index: true },
      submittedAt: { type: Date, default: Date.now, index: true },
      reviewedBy: { type: String, default: null },
      reviewedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null },
    },
    { timestamps: true }
  );

  const financialAdjustmentSchema = new mongoose.Schema(
    {
      adjustmentId: { type: String, required: true, unique: true, index: true },
      idempotencyKey: { type: String, required: true, unique: true, index: true },
      partnerId: { type: String, required: true, index: true },
      type: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
      amount: { type: Number, required: true, min: 0.01 },
      currency: { type: String, default: 'INR' },
      reason: { type: String, required: true },
      adminId: { type: String, required: true },
      beforeOutstanding: { type: Number, required: true },
      afterOutstanding: { type: Number, required: true },
      beforeNetEarnings: { type: Number, required: true },
      afterNetEarnings: { type: Number, required: true },
    },
    { timestamps: true }
  );

  const financialLedgerSchema = new mongoose.Schema(
    {
      ledgerId: { type: String, required: true, unique: true, index: true },
      eventId: { type: String, required: true, unique: true, index: true },
      partnerId: { type: String, required: true, index: true },
      bookingId: { type: String, default: null, index: true },
      settlementId: { type: String, default: null, index: true },
      adjustmentId: { type: String, default: null, index: true },
      entryType: {
        type: String,
        enum: [
          'COD_COLLECTED',
          'COMMISSION_ACCRUED',
          'PARTNER_NET_EARNING',
          'SETTLEMENT_APPROVED',
          'ADJUSTMENT_CREDIT',
          'ADJUSTMENT_DEBIT',
          'REVERSAL',
          'REFUND',
        ],
        required: true,
        index: true,
      },
      direction: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
      amount: { type: Number, required: true },
      currency: { type: String, default: 'INR' },
      balanceBefore: { type: Number, required: true },
      balanceAfter: { type: Number, required: true },
      description: { type: String, required: true },
      actorId: { type: String, required: true },
      actorRole: { type: String, required: true },
      metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
  );

  const financialAuditLogSchema = new mongoose.Schema(
    {
      auditId: { type: String, required: true, unique: true, index: true },
      action: { type: String, required: true, index: true },
      actorId: { type: String, required: true },
      actorRole: { type: String, required: true },
      partnerId: { type: String, default: null, index: true },
      bookingId: { type: String, default: null, index: true },
      settlementId: { type: String, default: null, index: true },
      amount: { type: Number, default: 0 },
      beforeState: { type: mongoose.Schema.Types.Mixed, default: null },
      afterState: { type: mongoose.Schema.Types.Mixed, default: null },
      metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
      ipAddress: { type: String, default: null },
    },
    { timestamps: true }
  );

  return {
    PartnerFinancialAccount: conn.model('PartnerFinancialAccount', partnerFinancialAccountSchema),
    PartnerEarning: conn.model('PartnerEarning', partnerEarningSchema),
    CODCollection: conn.model('CODCollection', codCollectionSchema),
    PlatformCommission: conn.model('PlatformCommission', platformCommissionSchema),
    PartnerAdminSettlement: conn.model('PartnerAdminSettlement', partnerAdminSettlementSchema),
    FinancialAdjustment: conn.model('FinancialAdjustment', financialAdjustmentSchema),
    FinancialLedger: conn.model('FinancialLedger', financialLedgerSchema),
    FinancialAuditLog: conn.model('FinancialAuditLog', financialAuditLogSchema),
  };
}

module.exports = { getFinanceModels };
