const https = require('https');

const HOST = 'backend-1-pm8b.onrender.com';

function request(path, token) {
  const start = Date.now();
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = https.request({ hostname: HOST, path, method: 'GET', headers, timeout: 20000 }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        resolve({ path, status: res.statusCode, duration: Date.now() - start, size: Buffer.byteLength(raw) });
      });
    });
    req.on('error', err => resolve({ path, status: 0, error: err.message, duration: Date.now() - start, size: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ path, status: 408, error: 'Timeout', duration: Date.now() - start, size: 0 }); });
    req.end();
  });
}

async function benchmark() {
  console.log('=== BENCHMARKING BEFORE TIMINGS ===');
  // Login first
  const loginStart = Date.now();
  const loginData = JSON.stringify({ email: 'fazil@homestepin.com', password: 'homestepin@fazil' });
  const loginRes = await new Promise(res => {
    const r = https.request({
      hostname: HOST, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginData) }
    }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    });
    r.write(loginData); r.end();
  });
  const token = loginRes.token;
  console.log(`Login time: ${Date.now() - loginStart}ms`);

  const endpoints = [
    '/api/admin/metrics',
    '/api/admin/analytics',
    '/api/admin/live-ops',
    '/api/admin/bookings?limit=50',
    '/api/admin/workers?limit=50',
    '/api/admin/customers?limit=50',
    '/api/admin/banners',
    '/api/admin/services',
    '/api/admin/coupons',
    '/api/admin/financials',
    '/api/admin/service-areas',
    '/api/admin/audit-logs?limit=20',
  ];

  for (const ep of endpoints) {
    const res = await request(ep, token);
    console.log(`${ep.padEnd(35)} : ${res.status} | ${res.duration}ms | ${(res.size / 1024).toFixed(1)} KB`);
  }
}

benchmark().catch(console.error);
