const https = require('https');

const HOST = 'backend-dp08.onrender.com';

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
  const login = await request('POST', '/api/auth/login', { email: 'fazil@homestepin.com', password: 'homestepin@fazil' });
  const token = login.data?.token;

  const res = await request('GET', '/api/admin/bookings?limit=200', null, token);
  const bookings = res.data?.bookings || [];
  console.log(`Fetched ${bookings.length} bookings.`);

  const statusMap = {};
  const customerMap = {};
  const dates = [];

  bookings.forEach(b => {
    statusMap[b.status] = (statusMap[b.status] || 0) + 1;
    const custId = b.customerId || b.user || b.customer || 'none';
    customerMap[custId] = (customerMap[custId] || 0) + 1;
    if (b.createdAt) dates.push(b.createdAt.slice(0, 10));
  });

  console.log('\nStatus breakdown:');
  console.log(JSON.stringify(statusMap, null, 2));

  console.log('\nCustomer references:');
  console.log(JSON.stringify(customerMap, null, 2));

  const uniqueDates = [...new Set(dates)].sort();
  console.log('\nCreated dates:');
  console.log(uniqueDates);

  // Check first 3 bookings
  console.log('\nFirst 3 bookings:');
  console.log(JSON.stringify(bookings.slice(0, 3).map(b => ({
    id: b.id || b._id,
    service: b.service || b.serviceName,
    status: b.status,
    customer: b.customerId || b.customer || b.userName,
    createdAt: b.createdAt
  })), null, 2));
}

run().catch(console.error);
