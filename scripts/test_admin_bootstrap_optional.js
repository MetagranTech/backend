// Automated test verifying optional admin bootstrap in production and password preservation
const assert = require('assert');
const bcrypt = require('bcryptjs');

async function runTests() {
  console.log('=== Test Suite: Optional Admin Bootstrap & Credential Preservation ===\n');

  const originalEnv = { ...process.env };

  try {
    // ── TEST 1: Production Startup WITHOUT Admin Bootstrap Credentials ──
    delete process.env.INITIAL_ADMIN_PASSWORD;
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    delete process.env.INITIAL_ADMIN_EMAIL;
    delete process.env.ADMIN_BOOTSTRAP_EMAIL;
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = 'a-very-long-production-jwt-access-secret-32-chars-min';
    process.env.JWT_REFRESH_SECRET = 'a-very-long-production-jwt-refresh-secret-32-chars-min';
    process.env.PAYMENT_WEBHOOK_SECRET = 'a-very-long-payment-webhook-secret-16-chars';
    process.env.OTP_SECRET = 'a-very-long-otp-secret-at-least-32-chars-long-here';
    process.env.CORS_ALLOWED_ORIGINS = 'https://admin.homestepin.com';
    process.env.MONGODB_URI = 'mongodb+srv://dummyUser:dummyPass@cluster.mongodb.net/homestepin';

    // Clear module cache to re-evaluate config.js
    delete require.cache[require.resolve('../src/config')];

    let prodConfig = null;
    let prodError = null;
    try {
      prodConfig = require('../src/config');
    } catch (err) {
      prodError = err;
    }

    assert(!prodError, `Production config MUST NOT throw when admin bootstrap credentials are missing! Error: ${prodError?.message}`);
    assert.strictEqual(prodConfig.adminBootstrapPassword, null, 'adminBootstrapPassword should be null when not provided or default in production');
    assert.strictEqual(prodConfig.adminBootstrapEmail, null, 'adminBootstrapEmail should be null when not provided or default in production');
    console.log('✓ [PASS] TEST 1: Production startup succeeds without admin bootstrap credentials (returns null)');

    // ── TEST 2: Production Rejects Short Password When Provided ──
    process.env.INITIAL_ADMIN_PASSWORD = 'short';
    delete require.cache[require.resolve('../src/config')];

    let shortErrorThrown = false;
    try {
      require('../src/config');
    } catch (err) {
      shortErrorThrown = true;
      assert(err.message.includes('must be a strong unique password of at least 12 characters'), `Unexpected error: ${err.message}`);
    }
    assert(shortErrorThrown, 'Config should reject passwords shorter than 12 characters in production');
    console.log('✓ [PASS] TEST 2: Passwords shorter than 12 characters strictly rejected when provided in production');

    // ── TEST 3: Production Accepts Strong Admin Bootstrap Password When Provided ──
    process.env.INITIAL_ADMIN_PASSWORD = 'MySuperUniqueAdminPassword2026!';
    process.env.INITIAL_ADMIN_EMAIL = 'custom-admin@homestepin.com';
    delete require.cache[require.resolve('../src/config')];

    const strongConfig = require('../src/config');
    assert.strictEqual(strongConfig.adminBootstrapPassword, 'MySuperUniqueAdminPassword2026!');
    assert.strictEqual(strongConfig.adminBootstrapEmail, 'custom-admin@homestepin.com');
    console.log('✓ [PASS] TEST 3: Strong admin bootstrap credentials accepted cleanly when provided');

    // ── TEST 4: Development Environment Fallbacks Preserved ──
    process.env.NODE_ENV = 'development';
    delete process.env.INITIAL_ADMIN_PASSWORD;
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    delete process.env.INITIAL_ADMIN_EMAIL;
    delete process.env.ADMIN_BOOTSTRAP_EMAIL;
    delete require.cache[require.resolve('../src/config')];

    const devConfig = require('../src/config');
    assert.strictEqual(devConfig.adminBootstrapPassword, 'ChangeMe_Admin_1');
    assert.strictEqual(devConfig.adminBootstrapEmail, 'admin@homestepin.local');
    console.log('✓ [PASS] TEST 4: Development fallback preserved for local dev environments');

    // ── TEST 5: Admin Seed Logic Preserves Existing Admin Password & Permissions ──
    process.env.NODE_ENV = 'test';
    delete require.cache[require.resolve('../src/config')];

    const { connectDb, disconnectDb } = require('../src/db');
    await connectDb();
    const User = require('../src/models/User');

    // Create a mock existing admin with a custom password hash
    const testAdminEmail = `existing_admin_test_${Date.now()}@test.homestepin.com`;
    const originalCustomPassword = 'MySecretAdminPassword99!';
    const originalPasswordHash = await bcrypt.hash(originalCustomPassword, 10);

    const existingAdmin = await User.create({
      customId: `usr_adm_test_${Date.now()}`,
      name: 'Existing SuperAdmin',
      email: testAdminEmail,
      phone: '+919876599999',
      passwordHash: originalPasswordHash,
      role: 'admin',
      adminRole: 'SUPER_ADMIN',
      isSystemSuperAdmin: true,
      isProtected: true,
      status: 'active',
      emailVerified: true,
      mustChangePassword: false,
    });

    // Run seed/bootstrap logic
    const { bootstrapSystemDefaults } = require('../src/seed');
    await bootstrapSystemDefaults();

    // Verify existing admin password was NOT overwritten or reset
    const adminAfterSeed = await User.findOne({ email: testAdminEmail }).select('+passwordHash');
    assert(adminAfterSeed, 'Existing admin must still exist after bootstrap');
    assert.strictEqual(adminAfterSeed.passwordHash, originalPasswordHash, 'Password hash must NOT be changed or reset by bootstrap');
    const isPasswordStillValid = await bcrypt.compare(originalCustomPassword, adminAfterSeed.passwordHash);
    assert(isPasswordStillValid, 'Original password must still verify successfully');
    assert.strictEqual(adminAfterSeed.role, 'admin', 'Role must remain admin');
    assert.strictEqual(adminAfterSeed.adminRole, 'SUPER_ADMIN', 'adminRole must remain SUPER_ADMIN');

    // Cleanup test record
    await User.deleteOne({ _id: existingAdmin._id });
    await disconnectDb();

    console.log('✓ [PASS] TEST 5: Existing admin account and custom password preserved 100% untouched by bootstrap');

  } finally {
    process.env = { ...originalEnv };
    delete require.cache[require.resolve('../src/config')];
  }

  console.log('\n=== All Admin Bootstrap & Credential Preservation Tests Passed (5/5) ===');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
