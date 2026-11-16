/**
 * HomeStepIn — Complete Fresh Start & Demo Data Cleanup Script
 *
 * SAFELY purges all demo content, synthetic test fixtures, sample bookings,
 * fake earnings/reviews, and placeholder data prior to production launch while preserving:
 *  - Permanent System Super Admins: fazil@homestepin.com & vinothan@homestepin.com
 *  - System Category Taxonomy (Category collection)
 *  - System Service Catalog (Service collection)
 *  - System Service Boundary (ServiceArea collection - Trichy)
 *  - Platform Configuration (PlatformSetting collection)
 *  - All collection schemas and database indexes
 *
 * Modes:
 *  - Dry Run (default): node backend/scripts/clean-demo-data.js
 *  - Live Execution:    node backend/scripts/clean-demo-data.js --execute
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config();

const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');
const Booking = require('../src/models/Booking');
const Message = require('../src/models/Message');
const Notification = require('../src/models/Notification');
const NotificationOutbox = require('../src/models/NotificationOutbox');
const Payment = require('../src/models/Payment');
const Review = require('../src/models/Review');
const Complaint = require('../src/models/Complaint');
const Coupon = require('../src/models/Coupon');
const CouponUsage = require('../src/models/CouponUsage');
const Banner = require('../src/models/Banner');
const AuditLog = require('../src/models/AuditLog');
const HomeServiceRecord = require('../src/models/HomeServiceRecord');
const ServiceGuarantee = require('../src/models/ServiceGuarantee');
const CallSession = require('../src/models/CallSession');
const OutOfAreaAttempt = require('../src/models/OutOfAreaAttempt');
const IdempotencyKey = require('../src/models/IdempotencyKey');
const PlatformSetting = require('../src/models/PlatformSetting');
const Service = require('../src/models/Service');
const Category = require('../src/models/Category');
const ServiceArea = require('../src/models/ServiceArea');

// Protected system Super Admins — MUST NEVER BE DELETED
const PROTECTED_SUPER_ADMIN_EMAILS = [
  'fazil@homestepin.com',
  'vinothan@homestepin.com',
];

async function runCompleteFreshStartCleanup(isDryRun = true) {
  console.log(`\n===============================================================`);
  console.log(`  HOMESTEPIN FRESH START CLEANUP — ${isDryRun ? 'DRY RUN (AUDIT MODE)' : 'LIVE EXECUTION'}`);
  console.log(`===============================================================\n`);

  // 1. Audit Users
  const allUsers = await User.find({}).lean();
  const superAdminsToKeep = allUsers.filter(u =>
    PROTECTED_SUPER_ADMIN_EMAILS.includes(String(u.email || '').trim().toLowerCase())
  );
  const demoUsersToDelete = allUsers.filter(u =>
    !PROTECTED_SUPER_ADMIN_EMAILS.includes(String(u.email || '').trim().toLowerCase())
  );

  console.log(`[1. Users Audit]`);
  console.log(`  • Total users in database:     ${allUsers.length}`);
  console.log(`  • Preserved Super Admins:      ${superAdminsToKeep.length}`);
  superAdminsToKeep.forEach(a => {
    console.log(`    ✔ Preserving Super Admin: ${a.name} (${a.email}) [ID: ${a.customId || a._id}]`);
  });
  console.log(`  • Demo/Test users to remove:   ${demoUsersToDelete.length}`);
  demoUsersToDelete.slice(0, 10).forEach(u => {
    console.log(`    - [${u.role.toUpperCase()}] ${u.name} (${u.email}) [ID: ${u.customId || u._id}]`);
  });
  if (demoUsersToDelete.length > 10) {
    console.log(`    ... and ${demoUsersToDelete.length - 10} more test user records.`);
  }

  if (superAdminsToKeep.length === 0) {
    throw new Error('CRITICAL SAFETY ABORT: Protected Super Admin accounts not found! Aborting purge.');
  }

  // 2. Audit Bookings & Related Records
  const totalBookings = await Booking.countDocuments();
  const totalHomeRecords = await HomeServiceRecord.countDocuments();
  const totalGuarantees = await ServiceGuarantee.countDocuments();
  const totalCallSessions = await CallSession.countDocuments();
  const totalReviews = await Review.countDocuments();
  const totalComplaints = await Complaint.countDocuments();
  const totalOutOfArea = await OutOfAreaAttempt.countDocuments();
  const totalCouponUsages = await CouponUsage.countDocuments();
  const totalCoupons = await Coupon.countDocuments();
  const totalBanners = await Banner.countDocuments();
  const totalMessages = await Message.countDocuments();
  const totalNotifications = await Notification.countDocuments();
  const totalNotificationOutboxes = await NotificationOutbox.countDocuments();
  const totalAuditLogs = await AuditLog.countDocuments();
  const totalPayments = await Payment.countDocuments();
  const totalIdempotencyKeys = await IdempotencyKey.countDocuments();

  // Preserved Baseline
  const totalCategories = await Category.countDocuments();
  const totalServices = await Service.countDocuments();
  const totalServiceAreas = await ServiceArea.countDocuments();
  const totalPlatformSettings = await PlatformSetting.countDocuments();

  console.log(`\n[2. Operational Collections Audit (To be purged for Fresh Start)]`);
  console.log(`  • Bookings:             ${totalBookings}`);
  console.log(`  • Home Service Records: ${totalHomeRecords}`);
  console.log(`  • Service Guarantees:   ${totalGuarantees}`);
  console.log(`  • Call Sessions:        ${totalCallSessions}`);
  console.log(`  • Reviews & Ratings:    ${totalReviews}`);
  console.log(`  • Complaints:           ${totalComplaints}`);
  console.log(`  • Out-of-Area Attempts: ${totalOutOfArea}`);
  console.log(`  • Coupon Usages:        ${totalCouponUsages}`);
  console.log(`  • Demo Coupons:         ${totalCoupons}`);
  console.log(`  • Demo Banners:         ${totalBanners}`);
  console.log(`  • Chat Messages:        ${totalMessages}`);
  console.log(`  • Notifications:        ${totalNotifications}`);
  console.log(`  • Outbox Deliveries:    ${totalNotificationOutboxes}`);
  console.log(`  • Admin Audit Logs:     ${totalAuditLogs}`);
  console.log(`  • Payments:             ${totalPayments}`);
  console.log(`  • Idempotency Keys:     ${totalIdempotencyKeys}`);

  console.log(`\n[3. System Baseline Collections (Preserved Intact)]`);
  console.log(`  • Categories:           ${totalCategories} (AC, Electrical, Cleaning, Plumbing, etc.)`);
  console.log(`  • Services:             ${totalServices} (AC Service, Electrician, etc.)`);
  console.log(`  • Service Areas:        ${totalServiceAreas} (Tiruchirappalli Operational Boundary)`);
  console.log(`  • Platform Settings:    ${totalPlatformSettings} (Global configuration)`);

  if (isDryRun) {
    console.log(`\n[DRY RUN SUMMARY]`);
    console.log(`  No modifications made to the database.`);
    console.log(`  To execute the purge, run: node backend/scripts/clean-demo-data.js --execute`);
    return {
      mode: 'dry-run',
      demoUsersCount: demoUsersToDelete.length,
      preservedAdminsCount: superAdminsToKeep.length,
      bookingsCount: totalBookings,
    };
  }

  // LIVE PURGE EXECUTION
  console.log(`\n[EXECUTING COMPLETE DATABASE FRESH START PURGE]`);

  // Delete operational and test collections
  const delMessages = await Message.deleteMany({});
  console.log(`  ✔ Deleted ${delMessages.deletedCount} chat messages.`);

  const delNotifs = await Notification.deleteMany({});
  console.log(`  ✔ Deleted ${delNotifs.deletedCount} notifications.`);

  const delOutbox = await NotificationOutbox.deleteMany({});
  console.log(`  ✔ Deleted ${delOutbox.deletedCount} notification outbox records.`);

  const delCalls = await CallSession.deleteMany({});
  console.log(`  ✔ Deleted ${delCalls.deletedCount} call sessions.`);

  const delReviews = await Review.deleteMany({});
  console.log(`  ✔ Deleted ${delReviews.deletedCount} reviews.`);

  const delComplaints = await Complaint.deleteMany({});
  console.log(`  ✔ Deleted ${delComplaints.deletedCount} complaints.`);

  const delOutOfArea = await OutOfAreaAttempt.deleteMany({});
  console.log(`  ✔ Deleted ${delOutOfArea.deletedCount} out-of-area attempts.`);

  const delPayments = await Payment.deleteMany({});
  console.log(`  ✔ Deleted ${delPayments.deletedCount} payments.`);

  const delHomeRecords = await HomeServiceRecord.deleteMany({});
  console.log(`  ✔ Deleted ${delHomeRecords.deletedCount} home service records.`);

  const delGuarantees = await ServiceGuarantee.deleteMany({});
  console.log(`  ✔ Deleted ${delGuarantees.deletedCount} service guarantees.`);

  const delBookings = await Booking.deleteMany({});
  console.log(`  ✔ Deleted ${delBookings.deletedCount} bookings.`);

  const delCouponUsages = await CouponUsage.deleteMany({});
  console.log(`  ✔ Deleted ${delCouponUsages.deletedCount} coupon usages.`);

  const delCoupons = await Coupon.deleteMany({});
  console.log(`  ✔ Deleted ${delCoupons.deletedCount} coupons.`);

  const delBanners = await Banner.deleteMany({});
  console.log(`  ✔ Deleted ${delBanners.deletedCount} banners.`);

  const delAudit = await AuditLog.deleteMany({});
  console.log(`  ✔ Deleted ${delAudit.deletedCount} audit logs.`);

  const delIdempotency = await IdempotencyKey.deleteMany({});
  console.log(`  ✔ Deleted ${delIdempotency.deletedCount} idempotency keys.`);

  // Delete all users except protected Super Admins
  const delUsers = await User.deleteMany({
    email: { $nin: PROTECTED_SUPER_ADMIN_EMAILS },
  });
  console.log(`  ✔ Deleted ${delUsers.deletedCount} demo/test users.`);

  // Reset wallet, earnings, and statistics on any preserved admin users if they had any
  await User.updateMany(
    { email: { $in: PROTECTED_SUPER_ADMIN_EMAILS } },
    {
      $set: {
        walletBalance: 0,
        loyaltyPoints: 0,
        todayEarnings: 0,
        ratingAvg: null,
        ratingCount: 0,
      },
    }
  );

  // Verification of remaining records
  const remainingUsers = await User.find({}).lean();
  const remainingBookings = await Booking.countDocuments();
  const remainingCoupons = await Coupon.countDocuments();
  const remainingBanners = await Banner.countDocuments();
  const remainingServices = await Service.countDocuments();
  const remainingCategories = await Category.countDocuments();
  const remainingServiceAreas = await ServiceArea.countDocuments();

  console.log(`\n[POST-CLEANUP VERIFICATION]`);
  console.log(`  • Users remaining:         ${remainingUsers.length} (Super Admins only)`);
  remainingUsers.forEach(u => {
    console.log(`    ✔ ${u.name} (${u.email}) [role: ${u.role}, adminRole: ${u.adminRole}]`);
  });
  console.log(`  • Bookings remaining:      ${remainingBookings}`);
  console.log(`  • Coupons remaining:       ${remainingCoupons}`);
  console.log(`  • Banners remaining:       ${remainingBanners}`);
  console.log(`  • Services remaining:      ${remainingServices} (System Catalog)`);
  console.log(`  • Categories remaining:    ${remainingCategories} (System Catalog)`);
  console.log(`  • Service Areas remaining: ${remainingServiceAreas} (Trichy)`);

  console.log(`\n===============================================================`);
  console.log(`  HOMESTEPIN FRESH START CLEANUP COMPLETE — READY FOR PRODUCTION`);
  console.log(`===============================================================\n`);

  return {
    success: true,
    mode: 'executed',
    deletedCounts: {
      users: delUsers.deletedCount,
      bookings: delBookings.deletedCount,
      messages: delMessages.deletedCount,
      notifications: delNotifs.deletedCount,
      outbox: delOutbox.deletedCount,
      callSessions: delCalls.deletedCount,
      reviews: delReviews.deletedCount,
      complaints: delComplaints.deletedCount,
      outOfArea: delOutOfArea.deletedCount,
      payments: delPayments.deletedCount,
      homeRecords: delHomeRecords.deletedCount,
      guarantees: delGuarantees.deletedCount,
      couponUsages: delCouponUsages.deletedCount,
      coupons: delCoupons.deletedCount,
      banners: delBanners.deletedCount,
      auditLogs: delAudit.deletedCount,
      idempotencyKeys: delIdempotency.deletedCount,
    },
    preservedSuperAdmins: remainingUsers.length,
    preservedServices: remainingServices,
    preservedCategories: remainingCategories,
    preservedServiceAreas: remainingServiceAreas,
  };
}

if (require.main === module) {
  const isExecute = process.argv.includes('--execute');
  (async () => {
    try {
      await connectDb();
      await runCompleteFreshStartCleanup(!isExecute);
      await disconnectDb();
      process.exit(0);
    } catch (err) {
      console.error('\n❌ Cleanup Script Error:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = { runCompleteFreshStartCleanup };
