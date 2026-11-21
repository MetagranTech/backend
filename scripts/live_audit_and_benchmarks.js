const https = require('https');

const HOST = 'backend-1-pm8b.onrender.com';

function request(method, path, body = null, token = null) {
  const start = Date.now();
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({ hostname: HOST, path, method, headers, timeout: 20000 }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        const duration = Date.now() - start;
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed, duration, headers: res.headers });
      });
    });

    req.on('error', (err) => {
      resolve({ status: 0, error: err.message, duration: Date.now() - start });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 408, error: 'Timeout', duration: Date.now() - start });
    });

    if (data) req.write(data);
    req.end();
  });
}

async function runLiveAudit() {
  const results = [];

  console.log('========================================================================');
  console.log('   HOMESTEPIN LIVE PRODUCTION API AUDIT & SECURITY BENCHMARKS');
  console.log('   Target: https://' + HOST);
  console.log('========================================================================\n');

  // 1. Health & Readiness
  const health = await request('GET', '/api/health?metrics=true');
  results.push({ name: 'System Health & DB Readiness', endpoint: 'GET /api/health', status: health.status, duration: health.duration, pass: health.status === 200 && health.data?.database?.isConnected === true });

  // 2. Unauthenticated Access Protection (Security)
  const unauthMe = await request('GET', '/api/auth/me');
  results.push({ name: 'Auth Protection (No Token)', endpoint: 'GET /api/auth/me', status: unauthMe.status, duration: unauthMe.duration, pass: unauthMe.status === 401 });

  const unauthAdmin = await request('GET', '/api/admin/metrics');
  results.push({ name: 'RBAC Protection (No Token on Admin)', endpoint: 'GET /api/admin/metrics', status: unauthAdmin.status, duration: unauthAdmin.duration, pass: unauthAdmin.status === 401 });

  // 3. Admin Authentication
  const adminLogin = await request('POST', '/api/auth/login', { email: 'fazil@homestepin.com', password: 'homestepin@fazil' });
  const adminToken = adminLogin.data?.token || adminLogin.data?.accessToken;
  results.push({ name: 'Super Admin Login', endpoint: 'POST /api/auth/login', status: adminLogin.status, duration: adminLogin.duration, pass: adminLogin.status === 200 && Boolean(adminToken) });

  // 4. Invalid Password Rejection (Security)
  const badLogin = await request('POST', '/api/auth/login', { email: 'fazil@homestepin.com', password: 'wrongpassword' });
  results.push({ name: 'Invalid Password Rejection', endpoint: 'POST /api/auth/login', status: badLogin.status, duration: badLogin.duration, pass: badLogin.status === 401 });

  // 5. Public Catalogs & Discovery
  const services = await request('GET', '/api/services');
  const servicesCount = Array.isArray(services.data?.services || services.data) ? (services.data?.services || services.data).length : 0;
  results.push({ name: 'Public Services Catalog', endpoint: 'GET /api/services', status: services.status, duration: services.duration, pass: services.status === 200 && servicesCount > 0, detail: `${servicesCount} services` });

  const categories = await request('GET', '/api/categories');
  const catCount = Array.isArray(categories.data?.categories || categories.data) ? (categories.data?.categories || categories.data).length : 0;
  results.push({ name: 'Public Categories Catalog', endpoint: 'GET /api/categories', status: categories.status, duration: categories.duration, pass: categories.status === 200, detail: `${catCount} categories` });

  const banners = await request('GET', '/api/banners');
  results.push({ name: 'Public Banners API', endpoint: 'GET /api/banners', status: banners.status, duration: banners.duration, pass: banners.status === 200 });

  // 6. Admin Core Workflows (using admin token)
  const metrics = await request('GET', '/api/admin/metrics', null, adminToken);
  results.push({ name: 'Admin Metrics & KPIs', endpoint: 'GET /api/admin/metrics', status: metrics.status, duration: metrics.duration, pass: metrics.status === 200 });

  const liveOps = await request('GET', '/api/admin/live-ops', null, adminToken);
  results.push({ name: 'Admin Live Operations', endpoint: 'GET /api/admin/live-ops', status: liveOps.status, duration: liveOps.duration, pass: liveOps.status === 200 });

  const adminBookings = await request('GET', '/api/admin/bookings?limit=10', null, adminToken);
  results.push({ name: 'Admin Bookings Directory', endpoint: 'GET /api/admin/bookings', status: adminBookings.status, duration: adminBookings.duration, pass: adminBookings.status === 200 });

  const adminWorkers = await request('GET', '/api/admin/workers?limit=10', null, adminToken);
  results.push({ name: 'Admin Workers Directory', endpoint: 'GET /api/admin/workers', status: adminWorkers.status, duration: adminWorkers.duration, pass: adminWorkers.status === 200 });

  const adminCustomers = await request('GET', '/api/admin/customers?limit=10', null, adminToken);
  results.push({ name: 'Admin Customers Directory', endpoint: 'GET /api/admin/customers', status: adminCustomers.status, duration: adminCustomers.duration, pass: adminCustomers.status === 200 });

  const adminCoupons = await request('GET', '/api/admin/coupons', null, adminToken);
  results.push({ name: 'Admin Coupons Management', endpoint: 'GET /api/admin/coupons', status: adminCoupons.status, duration: adminCoupons.duration, pass: adminCoupons.status === 200 });

  const adminServiceAreas = await request('GET', '/api/admin/service-areas', null, adminToken);
  results.push({ name: 'Admin Service Areas', endpoint: 'GET /api/admin/service-areas', status: adminServiceAreas.status, duration: adminServiceAreas.duration, pass: adminServiceAreas.status === 200 });

  const adminFinancials = await request('GET', '/api/admin/financials', null, adminToken);
  results.push({ name: 'Admin Financials & Ledger', endpoint: 'GET /api/admin/financials', status: adminFinancials.status, duration: adminFinancials.duration, pass: adminFinancials.status === 200 });

  const adminAuditLogs = await request('GET', '/api/admin/audit-logs?limit=5', null, adminToken);
  results.push({ name: 'Admin Audit Logs', endpoint: 'GET /api/admin/audit-logs', status: adminAuditLogs.status, duration: adminAuditLogs.duration, pass: adminAuditLogs.status === 200 });

  // 7. Payments Configuration
  const paymentsConfig = await request('GET', '/api/payments/config', null, adminToken);
  results.push({ name: 'Razorpay Gateway Config', endpoint: 'GET /api/payments/config', status: paymentsConfig.status, duration: paymentsConfig.duration, pass: paymentsConfig.status === 200 && Boolean(paymentsConfig.data?.keyId) });

  // 8. WebRTC ICE Configuration
  const iceServers = await request('GET', '/api/webrtc/ice-servers', null, adminToken);
  results.push({ name: 'WebRTC ICE Servers Endpoint', endpoint: 'GET /api/webrtc/ice-servers', status: iceServers.status, duration: iceServers.duration, pass: iceServers.status === 200 && Array.isArray(iceServers.data?.iceServers) });

  // 9. Location & Geo Validation
  const trichyValidation = await request('POST', '/api/admin/service-areas/test-location', { latitude: 10.7905, longitude: 78.7047 }, adminToken);
  results.push({ name: 'Trichy Service Area Geofence Test', endpoint: 'POST /api/admin/service-areas/test-location', status: trichyValidation.status, duration: trichyValidation.duration, pass: trichyValidation.status === 200, detail: JSON.stringify(trichyValidation.data).substring(0, 80) });

  // Summary display
  console.log(JSON.stringify(results, null, 2));

  const totalDuration = results.reduce((acc, r) => acc + r.duration, 0);
  const avgDuration = Math.round(totalDuration / results.length);
  const slowest = [...results].sort((a, b) => b.duration - a.duration)[0];
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log('\n========================================================================');
  console.log(` SUMMARY: ${passed} PASSED, ${failed} FAILED across ${results.length} production endpoints`);
  console.log(` Average Response Time: ${avgDuration}ms | Slowest Endpoint: ${slowest.name} (${slowest.duration}ms)`);
  console.log('========================================================================');
}

runLiveAudit().catch(console.error);
