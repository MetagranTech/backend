// Automated test verifying flexible Admin ID / username / email resolution in login
const assert = require('assert');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'a-super-long-test-jwt-access-secret-32-chars-minimum';
process.env.JWT_REFRESH_SECRET = 'a-super-long-test-jwt-refresh-secret-32-chars-minimum';

const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');

async function testAdminLoginResolution() {
  console.log('=== Test Suite: Admin Login Flexible Identifier Resolution ===\n');

  await connectDb();

  const testPassword = 'TestAdminPass123!';
  const passwordHash = await bcrypt.hash(testPassword, 10);

  // Create mock admin similar to seed/production (no username, customId timestamp, displayName Fazil)
  const testAdminEmail = `fazil_test_${Date.now()}@homestepin.com`;
  const customId = `usr_adm_${Date.now()}_999`;

  const admin = await User.create({
    customId,
    name: 'Fazil',
    email: testAdminEmail,
    phone: '+919876543291',
    passwordHash,
    role: 'admin',
    adminRole: 'SUPER_ADMIN',
    status: 'active',
    isSystemSuperAdmin: true,
    emailVerified: true,
  });

  try {
    // Helper to simulate the exact server.js orQueries builder
    function buildOrQueries(identifier) {
      const rawId = String(identifier).trim();
      const cleanId = rawId.toLowerCase();
      const rawDigits = rawId.replace(/\D/g, '');

      const orQueries = [
        { email: cleanId },
        { username: cleanId },
        { phone: rawId },
        { employeeId: cleanId.toUpperCase() },
        { employeeId: rawId },
        { customId: rawId },
        { customId: cleanId },
      ];

      if (rawDigits.length === 10) {
        orQueries.push({ phone: `+91${rawDigits}` });
        orQueries.push({ phone: rawDigits });
      }

      if (cleanId.startsWith('emp-')) {
        orQueries.push({ employeeId: cleanId.slice(4).toUpperCase() });
      } else {
        orQueries.push({ employeeId: `EMP-${cleanId.toUpperCase()}` });
      }

      if (cleanId.startsWith('adm-') || cleanId.startsWith('adm_')) {
        const bare = cleanId.slice(4);
        orQueries.push({ employeeId: `ADM-${bare.toUpperCase()}` });
        orQueries.push({ employeeId: bare.toUpperCase() });
        orQueries.push({ username: bare });
        orQueries.push({ customId: `usr_adm_${bare}` });
        orQueries.push({ email: `${bare}@homestepin.com` });
        orQueries.push({ email: `${bare}@homestep.in` });
      } else {
        orQueries.push({ employeeId: `ADM-${cleanId.toUpperCase()}` });
        orQueries.push({ customId: `usr_adm_${cleanId}` });
      }

      if (!cleanId.includes('@') && !rawId.startsWith('+')) {
        const escaped = rawId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        orQueries.push({ email: `${cleanId}@homestepin.com` });
        orQueries.push({ email: `${cleanId}@homestep.in` });
        orQueries.push({
          role: 'admin',
          name: { $regex: new RegExp(`^${escaped}$`, 'i') },
        });
        orQueries.push({
          role: 'admin',
          username: { $regex: new RegExp(`^${cleanId}$`, 'i') },
        });
      }

      return orQueries;
    }

    // TEST 1: Lookup by full email
    const byEmail = await User.findOne({ $or: buildOrQueries(testAdminEmail) }).select('+passwordHash');
    assert(byEmail, 'Must find admin by full email');
    assert(await bcrypt.compare(testPassword, byEmail.passwordHash), 'Password must match');
    console.log('✓ [PASS] TEST 1: Resolved admin by full email (fazil_test...@homestepin.com)');

    // TEST 2: Lookup by short name "Fazil"
    const byName = await User.findOne({ $or: buildOrQueries('Fazil') }).select('+passwordHash');
    assert(byName, 'Must find admin by case-insensitive name "Fazil"');
    assert.strictEqual(byName.role, 'admin');
    console.log('✓ [PASS] TEST 2: Resolved admin by short name ("Fazil")');

    // TEST 3: Lookup by lowercase "fazil"
    const byLowerName = await User.findOne({ $or: buildOrQueries('fazil') }).select('+passwordHash');
    assert(byLowerName, 'Must find admin by lowercase name ("fazil")');
    console.log('✓ [PASS] TEST 3: Resolved admin by lowercase identifier ("fazil")');

    // TEST 4: Lookup by phone
    const byPhone = await User.findOne({ $or: buildOrQueries('+919876543291') }).select('+passwordHash');
    assert(byPhone, 'Must find admin by phone');
    console.log('✓ [PASS] TEST 4: Resolved admin by phone number');

    // TEST 5: Lookup by 10-digit phone without country code
    const by10Phone = await User.findOne({ $or: buildOrQueries('9876543291') }).select('+passwordHash');
    assert(by10Phone, 'Must find admin by 10-digit phone');
    console.log('✓ [PASS] TEST 5: Resolved admin by 10-digit phone ("9876543291")');

    // TEST 6: Incorrect password returns false
    const matchWrong = await bcrypt.compare('WrongPassword999', byEmail.passwordHash);
    assert.strictEqual(matchWrong, false, 'Wrong password must return false');
    console.log('✓ [PASS] TEST 6: Wrong password correctly rejected');

    console.log('\n=== All Admin Login Resolution Tests Passed (6/6) ===');
  } finally {
    await User.deleteOne({ _id: admin._id });
    await disconnectDb();
  }
}

testAdminLoginResolution().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
