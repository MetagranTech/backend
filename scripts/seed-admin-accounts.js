const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const config = require('../src/config');
const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');

const REQUIRED_ADMINS = [
  {
    email: (process.env.INITIAL_SUPERADMIN_1_EMAIL || 'fazil@homestepin.com').trim().toLowerCase(),
    name: 'Fazil',
    phone: '+919876543201',
    adminRole: 'SUPER_ADMIN',
    password: process.env.INITIAL_SUPERADMIN_1_PASSWORD || 'homestepin@fazil',
  },
  {
    email: (process.env.INITIAL_SUPERADMIN_2_EMAIL || 'vinothan@homestepin.com').trim().toLowerCase(),
    name: 'Vinothan',
    phone: '+919876543202',
    adminRole: 'SUPER_ADMIN',
    password: process.env.INITIAL_SUPERADMIN_2_PASSWORD || 'homestepin@vinothan',
  },
];

async function seedAdminAccounts() {
  console.log('[Admin Seed] Checking administrator accounts...');

  const results = [];

  for (const adminDef of REQUIRED_ADMINS) {
    const normalizedEmail = adminDef.email.trim().toLowerCase();

    // Check if account already exists
    const existing = await User.findOne({ email: normalizedEmail }).select('+passwordHash');

    if (existing) {
      let needsSave = false;
      if (existing.role !== 'admin') {
        existing.role = 'admin';
        needsSave = true;
      }
      if (existing.adminRole !== 'SUPER_ADMIN') {
        existing.adminRole = 'SUPER_ADMIN';
        needsSave = true;
      }
      if (!existing.isSystemSuperAdmin) {
        existing.isSystemSuperAdmin = true;
        needsSave = true;
      }
      if (!existing.isProtected) {
        existing.isProtected = true;
        needsSave = true;
      }
      if (existing.status !== 'active') {
        existing.status = 'active';
        needsSave = true;
      }

      // Check password match, update if needed
      const isMatch = await bcrypt.compare(adminDef.password, existing.passwordHash || '');
      if (!isMatch) {
        existing.passwordHash = await bcrypt.hash(adminDef.password, 10);
        existing.mustChangePassword = false;
        needsSave = true;
        console.log(`[Admin Seed] Synchronized credentials for Super Admin ${normalizedEmail}.`);
      }

      if (needsSave) {
        await existing.save();
        console.log(`[Admin Seed] Updated existing account ${normalizedEmail} with SUPER_ADMIN privileges.`);
      }
      results.push({ email: adminDef.email, status: 'EXISTS', id: existing.customId || existing._id.toString() });
    } else {
      // Create new administrator with hashed password
      const passwordHash = await bcrypt.hash(adminDef.password, 10);
      const customId = `usr_adm_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;

      const newAdmin = await User.create({
        customId,
        name: adminDef.name,
        email: normalizedEmail,
        phone: adminDef.phone,
        passwordHash,
        role: 'admin',
        adminRole: 'SUPER_ADMIN',
        isSystemSuperAdmin: true,
        isProtected: true,
        status: 'active',
        emailVerified: true,
        mustChangePassword: false,
      });

      console.log(`[Admin Seed] Successfully created Super Admin ${adminDef.email} (customId: ${customId}).`);
      results.push({ email: adminDef.email, status: 'CREATED', id: newAdmin.customId });
    }
  }

  return results;
}

// Allow direct CLI invocation
if (require.main === module) {
  (async () => {
    try {
      await connectDb();
      await seedAdminAccounts();
      await disconnectDb();
      console.log('[Admin Seed] Admin setup complete.');
      process.exit(0);
    } catch (err) {
      console.error('[Admin Seed Error]:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = { seedAdminAccounts, REQUIRED_ADMINS };
