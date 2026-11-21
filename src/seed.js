const bcrypt = require('bcryptjs');
const User = require('./models/User');
const Service = require('./models/Service');
const Category = require('./models/Category');
const Booking = require('./models/Booking');
const Message = require('./models/Message');
const Notification = require('./models/Notification');
const Coupon = require('./models/Coupon');
const PlatformSetting = require('./models/PlatformSetting');

/**
 * 1. Global Product & Administrative Baseline (Always Kept / Bootstrapped)
 * Does NOT seed demo customers, demo workers, or demo bookings.
 */
async function bootstrapSystemDefaults() {
  console.log('[DB Bootstrap] Checking system catalog & global configuration...');

  // 1. Categories
  const defaultCategories = [
    { name: 'AC & Appliances', slug: 'ac-appliances', description: 'Air conditioner and home appliance repairs' },
    { name: 'Electrician & Power', slug: 'electrician-power', description: 'Electrical repairs, wiring, and power solutions' },
    { name: 'Plumbing & Water', slug: 'plumbing-water', description: 'Plumbing fixes, leakages, and bathroom fixtures' },
    { name: 'Deep Cleaning', slug: 'deep-cleaning', description: 'Deep home, kitchen, and bathroom cleaning' },
    { name: 'Carpentry & Furniture', slug: 'carpentry-furniture', description: 'Furniture repair, assembly, and woodwork' },
    { name: 'Painting & Wall Care', slug: 'painting-wall-care', description: 'Interior and exterior wall painting and care' },
    { name: 'AC & Climate', slug: 'ac-climate', description: 'Cooling and heating system maintenance' },
    { name: 'Electrical', slug: 'electrical', description: 'General electrical installations and repairs' },
    { name: 'Plumbing', slug: 'plumbing', description: 'Water pipelines and sanitation services' },
    { name: 'Appliances', slug: 'appliances', description: 'Home appliances diagnostics and maintenance' },
    { name: 'Painting', slug: 'painting', description: 'Wall painting and moisture protection' },
    { name: 'Carpentry', slug: 'carpentry', description: 'General wood and furniture repair' },
    { name: 'Pest Control', slug: 'pest-control', description: 'Pest elimination and disinfection' },
    { name: 'Home Repairs', slug: 'home-repairs', description: 'General home maintenance and repairs' },
    { name: 'Cleaning', slug: 'cleaning', description: 'Standard residential cleaning' },
    { name: 'Home Improvement', slug: 'home-improvement', description: 'Home remodeling and upgrades' },
  ];

  for (const cat of defaultCategories) {
    const existing = await Category.findOne({
      $or: [
        { name: cat.name },
        { slug: cat.slug },
      ],
    });
    if (!existing) {
      await Category.create(cat);
    }
  }

  // 2. Services
  const defaultServices = [
    { customId: 'srv_ac', name: 'AC Service & Repair', shortName: 'AC Service', category: 'AC & Climate', icon: 'HVAC', priceStart: '₹499', priceNum: 499, popular: true, duration: '45 mins', displayOrder: 1, is_visible: true, active: true },
    { customId: 'srv_elec', name: 'Electrician Services', shortName: 'Electrician', category: 'Electrical', icon: 'ELECTRICAL', priceStart: '₹199', priceNum: 199, popular: true, duration: '30 mins', displayOrder: 2, is_visible: true, active: true },
    { customId: 'srv_clean', name: 'Full Deep Cleaning', shortName: 'Deep Clean', category: 'Deep Cleaning', icon: 'CLEANING', priceStart: '₹899', priceNum: 899, popular: true, duration: '2 hours', displayOrder: 3, is_visible: true, active: true },
    { customId: 'srv_plumb', name: 'Plumbing Works', shortName: 'Plumbing', category: 'Plumbing', icon: 'PLUMBING', priceStart: '₹249', priceNum: 249, popular: false, duration: '40 mins', displayOrder: 4, is_visible: true, active: true },
    { customId: 'srv_app', name: 'Appliance Repair', shortName: 'Appliances', category: 'Appliances', icon: 'APPLIANCE', priceStart: '₹349', priceNum: 349, popular: false, duration: '60 mins', displayOrder: 5, is_visible: true, active: true },
    { customId: 'srv_paint', name: 'Home Painting', shortName: 'Painting', category: 'Painting', icon: 'PAINTING', priceStart: '₹1,499', priceNum: 1499, popular: false, duration: '1 day', displayOrder: 6, is_visible: true, active: true },
    { customId: 'srv_carp', name: 'Carpentry & Woodwork', shortName: 'Carpentry', category: 'Carpentry', icon: 'CARPENTRY', priceStart: '₹299', priceNum: 299, popular: false, duration: '45 mins', displayOrder: 7, is_visible: true, active: true },
    { customId: 'srv_pest', name: 'Pest Control & Sanitization', shortName: 'Pest Control', category: 'Pest Control', icon: 'PEST CONTROL', priceStart: '₹699', priceNum: 699, popular: true, duration: '90 mins', displayOrder: 8, is_visible: true, active: true },
  ];

  for (const srv of defaultServices) {
    const existing = await Service.findOne({ customId: srv.customId });
    if (!existing) {
      await Service.create(srv);
    } else {
      await Service.updateOne({ customId: srv.customId }, { $set: { is_visible: existing.is_visible !== undefined ? existing.is_visible : true, displayOrder: existing.displayOrder || srv.displayOrder } });
    }
  }
  await Service.updateMany({ is_visible: { $exists: false } }, { $set: { is_visible: true } });

  // 3. Coupons (Only seeded if explicitly requested via SEED_DEFAULT_COUPONS=true)
  if (process.env.SEED_DEFAULT_COUPONS === 'true') {
    const defaultCoupons = [
      { code: 'WELCOME50', title: 'Welcome Flat ₹50 OFF', description: 'Save ₹50 on your first home service', amount: 50, percent: 0, minOrderAmount: 200, maxDiscount: 50, is_visible: true, active: true, displayOrder: 1 },
      { code: 'HOMESTEP10', title: '10% Instant Discount', description: 'Get 10% off on all home bookings', amount: 0, percent: 10, minOrderAmount: 300, maxDiscount: 200, is_visible: true, active: true, displayOrder: 2 },
      { code: 'SAVE100', title: 'Flat ₹100 Mega Saver', description: 'Save ₹100 on orders above ₹400', amount: 100, percent: 0, minOrderAmount: 400, maxDiscount: 100, is_visible: true, active: true, displayOrder: 3 },
      { code: 'SUPER20', title: 'Super 20% Discount', description: 'Get 20% off on premium repairs & cleaning', amount: 0, percent: 20, minOrderAmount: 500, maxDiscount: 250, is_visible: true, active: true, displayOrder: 4 },
      { code: 'FIRST100', title: 'First Booking Special', description: 'Special ₹100 discount for valued customers', amount: 100, percent: 15, minOrderAmount: 350, maxDiscount: 150, is_visible: true, active: true, displayOrder: 5 },
    ];
    for (const c of defaultCoupons) {
      const existing = await Coupon.findOne({ code: c.code });
      if (!existing) {
        await Coupon.create(c);
      } else {
        await Coupon.updateOne({ code: c.code }, { $set: { is_visible: existing.is_visible !== undefined ? existing.is_visible : true, displayOrder: existing.displayOrder || c.displayOrder } });
      }
    }
    await Coupon.updateMany({ is_visible: { $exists: false } }, { $set: { is_visible: true } });
  }

  // 4. Platform Settings
  const existingSetting = await PlatformSetting.findOne({ key: 'global_config' });
  if (!existingSetting) {
    await PlatformSetting.create({ key: 'global_config' });
  }

  // 5. System Administrator Accounts Initialization
  const isProduction = process.env.NODE_ENV === 'production';
  const existingAdminCount = await User.countDocuments({ role: 'admin' });

  if (existingAdminCount > 0) {
    console.log(`[DB Bootstrap] Preserving ${existingAdminCount} existing admin account(s). All passwords, roles, and permissions kept intact.`);
  } else {
    // No admin accounts exist in the database at all
    const bootstrapEmail = (
      process.env.ADMIN_BOOTSTRAP_EMAIL ||
      process.env.INITIAL_ADMIN_EMAIL ||
      process.env.INITIAL_SUPERADMIN_1_EMAIL ||
      ''
    ).trim().toLowerCase();

    const bootstrapPassword = (
      process.env.INITIAL_ADMIN_PASSWORD ||
      process.env.ADMIN_BOOTSTRAP_PASSWORD ||
      process.env.INITIAL_SUPERADMIN_1_PASSWORD ||
      ''
    ).trim();

    if (isProduction) {
      if (!bootstrapEmail || !bootstrapPassword) {
        console.warn('[DB Bootstrap Notice] No admin account exists in production MongoDB, and no bootstrap credentials were provided. Skipping automatic creation to prevent insecure defaults. Run an explicit secure admin setup when ready.');
      } else {
        const FORBIDDEN_PROD_VALUES = new Set([
          'ChangeMe_Admin_1',
          'homestepin@fazil',
          'homestepin@vinothan',
          'password123',
          'admin123',
        ]);
        if (bootstrapPassword.length < 12 || FORBIDDEN_PROD_VALUES.has(bootstrapPassword)) {
          throw new Error('[DB Bootstrap Error] Admin bootstrap password in production must be at least 12 characters and not a known default.');
        }
        const passwordHash = await bcrypt.hash(bootstrapPassword, 10);
        const customId = `usr_adm_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;
        await User.create({
          customId,
          name: process.env.ADMIN_BOOTSTRAP_NAME || 'System Administrator',
          email: bootstrapEmail,
          phone: process.env.ADMIN_BOOTSTRAP_PHONE || '+919876543200',
          passwordHash,
          role: 'admin',
          adminRole: 'SUPER_ADMIN',
          isSystemSuperAdmin: true,
          isProtected: true,
          status: 'active',
          emailVerified: true,
          mustChangePassword: false,
        });
        console.log(`[DB Bootstrap] Provisioned initial secure Super Admin in production: ${bootstrapEmail}`);
      }
    } else {
      // Development & Testing baseline (only created when 0 admins exist)
      const superAdmin1Email = bootstrapEmail || 'fazil@homestepin.com';
      const superAdmin1Pass = bootstrapPassword || 'homestepin@fazil';
      const superAdmin2Email = (process.env.INITIAL_SUPERADMIN_2_EMAIL || 'vinothan@homestepin.com').trim().toLowerCase();
      const superAdmin2Pass = process.env.INITIAL_SUPERADMIN_2_PASSWORD || 'homestepin@vinothan';

      const initialSuperAdmins = [
        { email: superAdmin1Email, displayName: 'Fazil', phone: '+919876543201', password: superAdmin1Pass },
        { email: superAdmin2Email, displayName: 'Vinothan', phone: '+919876543202', password: superAdmin2Pass },
      ];

      for (const adm of initialSuperAdmins) {
        const passwordHash = await bcrypt.hash(adm.password, 10);
        const customId = `usr_adm_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;
        await User.create({
          customId,
          name: adm.displayName,
          email: adm.email,
          phone: adm.phone,
          passwordHash,
          role: 'admin',
          adminRole: 'SUPER_ADMIN',
          isSystemSuperAdmin: true,
          isProtected: true,
          status: 'active',
          emailVerified: true,
          mustChangePassword: false,
        });
        console.log(`[DB Bootstrap] Provisioned development Super Admin: ${adm.email}`);
      }
    }
  }



  console.log('[DB Bootstrap] Global services, catalog and administrative accounts verified.');
}

/**
 * 2. Explicit Development/Test Demo Data Seed
 * Only executed when explicitly invoked (e.g. npm run seed:development or SEED_DEMO_DATA=true).
 */
async function seedDemoData() {
  if (process.env.NODE_ENV === 'production' || (process.env.APP_ENV || '').toLowerCase() === 'production') {
    throw new Error('[Fatal Error] Demo data seeding is strictly prohibited in production environments.');
  }
  console.log('[DB Seed] Seeding explicit development demo users & bookings...');
  await bootstrapSystemDefaults();

  const demoUsers = [
    {
      customId: 'usr_cust_01',
      name: 'Priya Sharma',
      email: 'customer@homestep.in',
      phone: '+919876543210',
      passwordHash: await bcrypt.hash('password123', 10),
      role: 'customer',
      status: 'active',
      address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
      addresses: [
        { id: 'addr_1', label: 'Home', address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru', landmark: 'Near EcoSpace', isDefault: true },
        { id: 'addr_2', label: 'Work', address: 'Block B, RMZ Ecoworld, Outer Ring Road, Bengaluru', landmark: 'Tower 4', isDefault: false },
      ],
    },
    {
      customId: 'usr_work_01',
      name: 'Rajesh Kumar (Verified Pro)',
      email: 'worker@homestep.in',
      phone: '+919876543211',
      employeeId: 'EMP-8801',
      passwordHash: await bcrypt.hash('password123', 10),
      role: 'worker',
      status: 'active',
      kycStatus: 'approved',
      services: ['AC Service & Repair', 'Appliance Repair'],
      approvedServices: ['AC Service & Repair', 'Appliance Repair'],
      serviceArea: 'Cantonment, Thillai Nagar, Tiruchirappalli (Trichy)',
      serviceRadiusKm: 18,
      ratingAvg: 4.92,
      ratingCount: 128,
      online: true,
      todayEarnings: 2479,
      walletBalance: 4250,
    },
    {
      customId: 'usr_work_02',
      name: 'Suresh Patil (Master Plumber)',
      email: 'suresh.plumb@homestep.in',
      phone: '+919876543212',
      employeeId: 'EMP-8802',
      passwordHash: await bcrypt.hash('password123', 10),
      role: 'worker',
      status: 'active',
      kycStatus: 'approved',
      services: ['Plumbing Works'],
      approvedServices: ['Plumbing Works'],
      serviceArea: 'KK Nagar, TVS Tollgate, Tiruchirappalli (Trichy)',
      serviceRadiusKm: 18,
      ratingAvg: 4.88,
      ratingCount: 94,
      online: true,
      todayEarnings: 1200,
      walletBalance: 3100,
    },
    {
      customId: 'usr_work_03',
      name: 'Vikram Singh (Certified Electrician)',
      email: 'vikram.elec@homestep.in',
      phone: '+919876543213',
      employeeId: 'EMP-8803',
      passwordHash: await bcrypt.hash('password123', 10),
      role: 'worker',
      status: 'active',
      kycStatus: 'approved',
      services: ['Electrician Services'],
      approvedServices: ['Electrician Services'],
      serviceArea: 'Srirangam, Chatram, Tiruchirappalli (Trichy)',
      serviceRadiusKm: 18,
      ratingAvg: 4.95,
      ratingCount: 162,
      online: true,
      todayEarnings: 1850,
      walletBalance: 5400,
    },
  ];

  for (const u of demoUsers) {
    const existing = await User.findOne({
      $or: [{ email: u.email }, ...(u.employeeId ? [{ employeeId: u.employeeId }] : []), ...(u.customId ? [{ customId: u.customId }] : [])],
    });
    if (!existing) {
      await User.create(u);
    }
  }

  const demoBookings = [
    {
      customId: 'BK-1082',
      customerId: 'usr_cust_01',
      customerName: 'Priya Sharma',
      customerPhone: '+919876543210',
      service: 'AC Service & Repair',
      category: 'AC & Appliances',
      providerId: 'usr_work_01',
      providerName: 'Rajesh Kumar (Verified Pro)',
      providerPhone: '+919876543211',
      date: new Date().toISOString().split('T')[0],
      time: '2:30 PM',
      address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
      latitude: 12.9279,
      longitude: 77.6771,
      price: '₹799',
      priceNum: 799,
      status: 'TRAVELLING',
      startOtp: '8392',
      etaMinutes: 14,
      paymentStatus: 'PAID',
    },
  ];

  for (const b of demoBookings) {
    const existing = await Booking.findOne({ customId: b.customId });
    if (!existing) {
      await Booking.create(b);
    }
  }

  console.log('[DB Seed] Demo dataset seeding completed.');
}

async function seedDatabase() {
  await bootstrapSystemDefaults();
}

module.exports = {
  bootstrapSystemDefaults,
  seedDemoData,
  seedDatabase,
};
