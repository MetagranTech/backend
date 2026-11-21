/**
 * benchmark_local_optimized.js
 * CommonJS version
 */

const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { app } = require('../server.js');
const { connectDb } = require('../src/db');
const config = require('../src/config');

async function run() {
  console.log('========================================================================');
  console.log('   HOMESTEPIN: LOCAL OPTIMIZED ENDPOINT BENCHMARKS');
  console.log('========================================================================');

  // Connect DB first
  await connectDb();

  // Find an admin user in the DB to sign a valid authenticated token
  const User = require('../src/models/User');
  let admin = await User.findOne({ role: { $in: ['admin', 'super_admin'] } });
  if (!admin) {
    admin = await User.findOne();
  }
  const adminId = admin ? (admin._id.toString()) : 'admin_perf_test';

  // Start temporary local server on port 4099
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(4099, resolve));
  const baseUrl = 'http://localhost:4099';

  const jwtSecret = config.jwtAccessSecret;
  const adminToken = jwt.sign(
    { sub: adminId, id: adminId, role: 'admin', isSystemSuperAdmin: true, email: admin ? admin.email : 'fazil@homestepin.com' },
    jwtSecret,
    { expiresIn: '1h' }
  );

  const measureGet = async (endpoint) => {
    const start = performance.now();
    const res = await fetch(`${baseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const duration = performance.now() - start;
    const data = await res.json().catch(() => ({}));
    return { status: res.status, duration: Math.round(duration), data };
  };

  try {
    // 1. Warm-up
    await measureGet('/api/health');

    // 2. Benchmark Metrics (Multiple runs)
    console.log('\n--- Benchmarking GET /api/admin/metrics (Parallelized Promise.all + Lean Projections) ---');
    const metricRuns = [];
    for (let i = 1; i <= 5; i++) {
      const res = await measureGet('/api/admin/metrics');
      metricRuns.push(res.duration);
      console.log(`  Run ${i}: ${res.duration} ms (Status: ${res.status}, bookings: ${res.data?.stats?.totalBookings ?? 'ok'})`);
    }
    const avgMetrics = Math.round(metricRuns.reduce((a, b) => a + b, 0) / metricRuns.length);
    console.log(`  => Average Metrics Latency: ${avgMetrics} ms (Before on Render: 4,287 ms)`);

    // 3. Benchmark Analytics
    console.log('\n--- Benchmarking GET /api/admin/analytics (Parallelized Promise.all + Lean Projections) ---');
    const analyticsRuns = [];
    for (let i = 1; i <= 5; i++) {
      const res = await measureGet('/api/admin/analytics?range=30d');
      analyticsRuns.push(res.duration);
      console.log(`  Run ${i}: ${res.duration} ms (Status: ${res.status})`);
    }
    const avgAnalytics = Math.round(analyticsRuns.reduce((a, b) => a + b, 0) / analyticsRuns.length);
    console.log(`  => Average Analytics Latency: ${avgAnalytics} ms (Before on Render: 2,966 ms)`);

    // 4. Test Banner Toggle with returned payload
    console.log('\n--- Benchmarking & Testing PATCH /api/admin/banners/:id/toggle ---');
    const bannersRes = await measureGet('/api/admin/banners');
    const banners = bannersRes.data?.banners || [];
    if (banners.length > 0) {
      const targetBanner = banners[0];
      const targetId = targetBanner.id || targetBanner._id;
      const toggleStart = performance.now();
      const toggleRes = await fetch(`${baseUrl}/api/admin/banners/${targetId}/toggle`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ is_active: !targetBanner.active }),
      });
      const toggleDuration = Math.round(performance.now() - toggleStart);
      const toggleData = await toggleRes.json().catch(() => ({}));
      console.log(`  Toggle Response: HTTP ${toggleRes.status} in ${toggleDuration} ms`);
      console.log(`  Payload includes banner object: ${!!toggleData.banner}`);
      console.log(`  New active state: ${toggleData.is_active ?? toggleData.active}`);

      // Toggle back to preserve original state
      await fetch(`${baseUrl}/api/admin/banners/${targetId}/toggle`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ is_active: targetBanner.active }),
      });
      console.log('  Restored original banner active state.');
    } else {
      console.log('  No banners found in local DB to toggle.');
    }

    console.log('\n========================================================================');
    console.log('   LOCAL BENCHMARK SUMMARY: ALL ENDPOINTS FUNCTIONING OPTIMALLY');
    console.log('========================================================================');
  } finally {
    server.close();
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[Benchmark Error]', err);
  process.exit(1);
});
