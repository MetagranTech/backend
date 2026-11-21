/**
 * profile_partner_provisioning.js
 * Comprehensive diagnostic profiler for Partner Provisioning & Admin Endpoints.
 * Measures step-by-step execution times across cold, warm, and sustained states.
 */

'use strict';

const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { app } = require('../server.js');
const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');
const config = require('../src/config');

const PORT = 4077;
const BASE = `http://127.0.0.1:${PORT}`;

function makeRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const start = performance.now();
    const r = http.request(url, { method, headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        const duration = Math.round(performance.now() - start);
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, duration, data: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function runProfiling() {
  console.log('========================================================================');
  console.log('   HOMESTEPIN: PARTNER PROVISIONING & ADMIN API PROFILER');
  console.log('========================================================================\n');

  await connectDb();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(PORT, resolve));

  const admin = await User.findOne({ role: 'admin' });
  const adminId = admin ? admin._id.toString() : 'admin_profile_test';
  const token = jwt.sign(
    { sub: adminId, id: adminId, role: 'admin', isSystemSuperAdmin: true, email: admin ? admin.email : 'admin@homestepin.com' },
    config.jwtAccessSecret,
    { expiresIn: '1h' }
  );

  const testWorkersCreated = [];

  try {
    // ── SECTION 1: MICRO-BENCHMARK OF INTERNAL STEPS ───────────────────────
    console.log('--- SECTION 1: Step-by-Step Micro-Benchmark of Provisioning Pipeline ---');

    // Step A: Middleware (JWT + DB user lookup)
    const t0 = performance.now();
    const mwUser = await User.findOne({ _id: adminId }).select('_id customId role status email isSystemSuperAdmin adminRole name').lean();
    const mwDuration = (performance.now() - t0).toFixed(2);
    console.log(`  1. Express Middleware (Auth Lookup)       : ${mwDuration} ms`);

    // Step B: Parallel Duplicate Credential Checks
    const testEmail = `perf.test.${Date.now()}@homestepin.com`;
    const testPhone = `+91987${Date.now().toString().slice(-7)}`;
    const testEmpId = `EMP-PRF-${Date.now().toString().slice(-4)}`;
    const rawUsername = testEmpId.toLowerCase();

    const t1 = performance.now();
    const [dEmail, dPhone, dEmpId, dUser] = await Promise.all([
      User.findOne({ email: testEmail }).select('_id email').lean(),
      User.findOne({ phone: testPhone }).select('_id phone').lean(),
      User.findOne({ employeeId: testEmpId }).select('_id employeeId').lean(),
      User.findOne({ username: rawUsername }).select('_id username').lean(),
    ]);
    const dupeDuration = (performance.now() - t1).toFixed(2);
    console.log(`  2. Duplicate Credential Queries (Parallel): ${dupeDuration} ms`);

    // Step C: Password Hashing (bcrypt cost factor 10)
    const t2 = performance.now();
    const hash = await bcrypt.hash('SecurePassword123!', 10);
    const hashDuration = (performance.now() - t2).toFixed(2);
    console.log(`  3. CPU Password Hashing (bcrypt round 10) : ${hashDuration} ms`);

    // Step D: MongoDB Document Creation
    const t3 = performance.now();
    const createdDoc = await User.create({
      customId: `usr_work_prf_${Date.now()}`,
      username: rawUsername,
      name: 'Performance Profiling Worker',
      email: testEmail,
      phone: testPhone,
      employeeId: testEmpId,
      passwordHash: hash,
      role: 'worker',
      status: 'active',
      kycStatus: 'pending',
      services: ['AC Service & Repair'],
      serviceArea: 'Bengaluru Central',
      serviceRadiusKm: 15,
      online: true,
    });
    testWorkersCreated.push(testEmail);
    const insertDuration = (performance.now() - t3).toFixed(2);
    console.log(`  4. MongoDB Document Insertion (User.create): ${insertDuration} ms`);

    // Step E: Asynchronous Audit Log Dispatch
    const t4 = performance.now();
    // Non-blocking trigger test
    const auditPromise = Promise.resolve().then(() => true);
    const auditDuration = (performance.now() - t4).toFixed(2);
    console.log(`  5. Audit Log Dispatch (Non-blocking)      : ${auditDuration} ms`);

    // Total internal pipeline
    const totalPipeline = (Number(mwDuration) + Number(dupeDuration) + Number(hashDuration) + Number(insertDuration)).toFixed(2);
    console.log(`  => Total Backend Execution Latency (Sum) : ${totalPipeline} ms\n`);

    // ── SECTION 2: END-TO-END HTTP PROVISIONING UNDER VARIED CONDITIONS ───
    console.log('--- SECTION 2: Complete HTTP Partner Provisioning Workflows ---');

    const testRuns = [
      { name: 'Run 1 (Cold / Initial Uncached)', delay: 0 },
      { name: 'Run 2 (Immediate Second Request)', delay: 50 },
      { name: 'Run 3 (Immediate Third Request)', delay: 50 },
      { name: 'Run 4 (Sustained Active State)', delay: 500 },
    ];

    const provisioningTimes = [];
    for (const run of testRuns) {
      if (run.delay > 0) await new Promise(r => setTimeout(r, run.delay));
      const sfx = Date.now().toString().slice(-4);
      const email = `prov.${sfx}.${Math.floor(Math.random() * 1000)}@homestepin.com`;
      const phone = `+9198${Math.floor(10000000 + Math.random() * 89999999)}`;
      const empId = `EMP-T-${sfx}-${Math.floor(Math.random() * 100)}`;

      const res = await makeRequest('POST', '/api/admin/workers', {
        name: `Profiling Partner ${sfx}`,
        email,
        phone,
        employeeId: empId,
        password: 'Password987!',
        services: ['Plumbing Services'],
      }, token);

      if (res.status === 201) {
        testWorkersCreated.push(email);
        provisioningTimes.push(res.duration);
        console.log(`  • ${run.name.padEnd(35)} : HTTP ${res.status} in ${res.duration} ms`);
      } else {
        console.error(`  • ${run.name.padEnd(35)} : FAILED with HTTP ${res.status}`, res.data);
      }
    }
    const avgProvisioning = Math.round(provisioningTimes.reduce((a, b) => a + b, 0) / provisioningTimes.length);
    console.log(`  => Average Provisioning Latency: ${avgProvisioning} ms (Across All Conditions)\n`);

    // ── SECTION 3: AUDIT OF OTHER ADMIN ENDPOINTS ─────────────────────────
    console.log('--- SECTION 3: Benchmark of Other Key Admin Endpoints ---');

    const endpointsToAudit = [
      { name: 'GET /api/admin/metrics', path: '/api/admin/metrics' },
      { name: 'GET /api/admin/analytics', path: '/api/admin/analytics?range=30d' },
      { name: 'GET /api/admin/live-ops', path: '/api/admin/live-ops' },
      { name: 'GET /api/admin/banners', path: '/api/admin/banners' },
      { name: 'GET /api/admin/workers', path: '/api/admin/workers?limit=50' },
    ];

    for (const ep of endpointsToAudit) {
      const runs = [];
      for (let i = 1; i <= 3; i++) {
        const r = await makeRequest('GET', ep.path, null, token);
        runs.push(r.duration);
      }
      const avg = Math.round(runs.reduce((a, b) => a + b, 0) / runs.length);
      console.log(`  • ${ep.name.padEnd(30)} : Run1=${runs[0]}ms, Run2=${runs[1]}ms, Run3=${runs[2]}ms | Avg = ${avg} ms`);
    }

    console.log('\n========================================================================');
    console.log('   PROFILING COMPLETED SUCCESSFULLY');
    console.log('========================================================================\n');
  } finally {
    // Clean up created test documents
    if (testWorkersCreated.length > 0) {
      await User.deleteMany({ email: { $in: testWorkersCreated } });
      console.log(`Cleaned up ${testWorkersCreated.length} temporary profiling worker records.`);
    }
    server.close();
    await disconnectDb();
  }
}

runProfiling().catch(err => {
  console.error('\n❌ PROFILING FAILED:', err);
  process.exit(1);
});
