const https = require('https');

const HOST = 'backend-1-pm8b.onrender.com';

function request(method, path, body = null, token = null) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({ hostname: HOST, path, method, headers, timeout: 20000 }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', err => resolve({ status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 408, error: 'Timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  console.log('Querying live Render backend...');
  const login = await request('POST', '/api/auth/login', { email: 'fazil@homestepin.com', password: 'homestepin@fazil' });
  const token = login.data?.token || login.data?.accessToken;
  if (!token) {
    console.error('Login failed:', login.data);
    return;
  }
  console.log('Logged in successfully as admin.');

  const metrics = await request('GET', '/api/admin/metrics', null, token);
  console.log('\n--- Live Metrics Stats ---');
  console.log(JSON.stringify(metrics.data?.stats, null, 2));

  const bookingsRes = await request('GET', '/api/admin/bookings?limit=5', null, token);
  console.log('\n--- Bookings Query ---');
  console.log('Total bookings returned:', bookingsRes.data?.pagination?.total || bookingsRes.data?.bookings?.length);
  console.log('Summary:', bookingsRes.data?.summary);
  console.log('First booking sample:', bookingsRes.data?.bookings?.[0]);

  const customersRes = await request('GET', '/api/admin/customers?limit=5', null, token);
  console.log('\n--- Customers Query ---');
  console.log('Total customers returned:', customersRes.data?.pagination?.total || customersRes.data?.customers?.length);

  const workersRes = await request('GET', '/api/admin/workers?limit=5', null, token);
  console.log('\n--- Workers Query ---');
  console.log('Total workers returned:', workersRes.data?.pagination?.total || workersRes.data?.workers?.length);
}

run().catch(console.error);
