/**
 * Comprehensive WebRTC Calling Verification Test Suite
 *
 * Verifies:
 * 1. WebRTC ICE Servers endpoint (/api/webrtc/ice-servers)
 * 2. Authenticated user call initiation (Customer <-> Worker)
 * 3. Real-time incoming call signaling via WebSocket
 * 4. Call accept flow and connected timestamp state transition
 * 5. WebRTC SDP Offer exchange over signaling room
 * 6. WebRTC SDP Answer exchange over signaling room
 * 7. ICE Candidate exchange over signaling room
 * 8. Call rejection flow (CALL_REJECTED, 0s duration, clean dismissal)
 * 9. Call end flow (CALL_ENDED, duration tracking, clean resource teardown)
 * 10. Security & participant access control
 */

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');

// Configure test environment on port 4006
process.env.NODE_ENV = 'test';
process.env.PORT = '4006';
process.env.TURN_SERVER_URLS = 'turn:turn.homestepin.com:3478?transport=udp';
process.env.TURN_SECRET = 'test_turn_secret_for_homestepin_calls';

const { app, server, startServer } = require('./server');
const config = require('./src/config');
const Booking = require('./src/models/Booking');
const User = require('./src/models/User');
const CallSession = require('./src/models/CallSession');

const JWT_SECRET = config.jwtAccessSecret;
const TEST_PORT = 4006;
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`;

function makeRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (e) {
            data = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createAuthenticatedWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const messages = [];
    let authenticated = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        messages.push(parsed);
        if (parsed.type === 'authenticated') {
          authenticated = true;
          resolve({ ws, messages });
        }
      } catch (e) {}
    });

    ws.on('error', (err) => {
      if (!authenticated) reject(err);
    });

    setTimeout(() => {
      if (!authenticated) {
        resolve({ ws, messages });
      }
    }, 2500);
  });
}

async function runTestSuite() {
  console.log('\n======================================================');
  console.log('  HOMESTEPIN WEBRTC CALLING COMPREHENSIVE E2E SUITE');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`• ${name} ... `);
    try {
      await fn();
      console.log('PASSED ✓');
      passed++;
    } catch (err) {
      console.log('FAILED ✗');
      console.error(err);
      failed++;
    }
  }

  // 1. Start Server
  await startServer();

  const ts = Date.now();
  const custMongoId = new mongoose.Types.ObjectId();
  const workMongoId = new mongoose.Types.ObjectId();
  const strangerMongoId = new mongoose.Types.ObjectId();

  const custCustomId = `USR-CUST-RTC-${ts}`;
  const workCustomId = `USR-WORK-RTC-${ts}`;
  const strangerCustomId = `USR-STRANGER-RTC-${ts}`;

  const custUser = {
    sub: custMongoId.toString(),
    id: custMongoId.toString(),
    customId: custCustomId,
    name: 'Vino Customer',
    phone: `+9198${ts.toString().slice(-8)}`,
    role: 'customer',
  };

  const workUser = {
    sub: workMongoId.toString(),
    id: workMongoId.toString(),
    customId: workCustomId,
    name: 'Rajesh Partner',
    phone: `+9197${ts.toString().slice(-8)}`,
    role: 'worker',
  };

  const strangerUser = {
    sub: strangerMongoId.toString(),
    id: strangerMongoId.toString(),
    customId: strangerCustomId,
    name: 'Unauthorized Stranger',
    phone: `+9196${ts.toString().slice(-8)}`,
    role: 'customer',
  };

  const custToken = jwt.sign(custUser, JWT_SECRET, { expiresIn: '1h' });
  const workToken = jwt.sign(workUser, JWT_SECRET, { expiresIn: '1h' });
  const strangerToken = jwt.sign(strangerUser, JWT_SECRET, { expiresIn: '1h' });

  await User.create([
    { _id: custMongoId, customId: custCustomId, name: custUser.name, phone: custUser.phone, role: 'customer', status: 'active', passwordHash: 'hash' },
    { _id: workMongoId, customId: workCustomId, name: workUser.name, phone: workUser.phone, role: 'worker', status: 'active', passwordHash: 'hash' },
    { _id: strangerMongoId, customId: strangerCustomId, name: strangerUser.name, phone: strangerUser.phone, role: 'customer', status: 'active', passwordHash: 'hash' },
  ]);

  // Create booking
  const bookingCustomId = `BK-RTC-${ts}`;
  const testBooking = await Booking.create({
    customId: bookingCustomId,
    customerId: custCustomId,
    customer: custMongoId,
    customerName: custUser.name,
    customerPhone: custUser.phone,
    providerId: workCustomId,
    worker: workMongoId,
    providerName: workUser.name,
    providerPhone: workUser.phone,
    service: 'Full Home AC Repair',
    category: 'AC & Climate',
    status: 'WORKER_ACCEPTED',
    price: '₹499',
    priceNum: 499,
    address: '10, Promenade Road, Cantonment, Tiruchirappalli',
    latitude: 10.790483,
    longitude: 78.704672,
  });

  // Setup WebSocket Connections
  const custWsObj = await createAuthenticatedWs(custToken);
  const workWsObj = await createAuthenticatedWs(workToken);

  // Join booking room
  custWsObj.ws.send(JSON.stringify({ type: 'join_room', token: custToken, bookingId: bookingCustomId }));
  workWsObj.ws.send(JSON.stringify({ type: 'join_room', token: workToken, bookingId: bookingCustomId }));

  await new Promise((r) => setTimeout(r, 400));

  try {
    // -------------------------------------------------------------------------
    // TEST 1: STUN/TURN ICE Servers Endpoint
    // -------------------------------------------------------------------------
    await test('1. GET /api/webrtc/ice-servers returns STUN and dynamic HMAC TURN config', async () => {
      const res = await makeRequest('GET', '/api/webrtc/ice-servers', null, custToken);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert(Array.isArray(res.data.iceServers), 'iceServers must be an array');
      assert(res.data.iceServers.length >= 2, 'Should include STUN and configured TURN server');

      const stunEntry = res.data.iceServers.find((s) => JSON.stringify(s.urls).includes('stun.l.google.com'));
      assert(stunEntry, 'Must include Google STUN server');

      const turnEntry = res.data.iceServers.find((s) => JSON.stringify(s.urls).includes('turn.homestepin.com'));
      assert(turnEntry, 'Must include configured TURN relay');
      assert(turnEntry.username, 'TURN entry must include username');
      assert(turnEntry.credential, 'TURN entry must include HMAC credential');
    });

    // -------------------------------------------------------------------------
    // TEST 2: Outgoing Call Initiation (Customer -> Partner)
    // -------------------------------------------------------------------------
    let activeCallSession = null;
    await test('2. Initiate Call (Customer -> Partner) via HTTP and WebSocket', async () => {
      workWsObj.messages.length = 0;
      custWsObj.messages.length = 0;

      const res = await makeRequest('POST', `/api/bookings/${bookingCustomId}/call/initiate`, {}, custToken);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert(res.data.callSession, 'Must return callSession object');
      assert.strictEqual(res.data.callSession.status, 'CALL_RINGING');
      assert.strictEqual(res.data.callSession.caller, custUser.name);
      assert.strictEqual(res.data.callSession.callee, workUser.name);
      assert(res.data.iceServers, 'Response must include ICE servers');

      activeCallSession = res.data.callSession;

      // Check partner received incoming_call WebSocket event
      await new Promise((r) => setTimeout(r, 600));
      const incoming = workWsObj.messages.find((m) => m.type === 'incoming_call');
      assert(incoming, 'Worker WebSocket must receive incoming_call event');
      assert.strictEqual(incoming.callSession.callSessionId, activeCallSession.callSessionId);
      assert.strictEqual(incoming.callSession.callerName, custUser.name);
      assert(incoming.callSession.iceServers, 'Incoming call payload must deliver ICE servers');
    });

    // -------------------------------------------------------------------------
    // TEST 3: Call Acceptance & Connected State
    // -------------------------------------------------------------------------
    await test('3. Accept Call (Partner accepts Customer call)', async () => {
      workWsObj.messages.length = 0;
      custWsObj.messages.length = 0;

      const res = await makeRequest(
        'POST',
        `/api/bookings/${bookingCustomId}/call/${activeCallSession.callSessionId}/accept`,
        {},
        workToken
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'CALL_CONNECTED');
      assert(res.data.connectedAt, 'Must set connectedAt timestamp');
      assert(res.data.iceServers, 'Accept response must include ICE servers');

      // Both caller and callee must receive call_connected broadcast
      await new Promise((r) => setTimeout(r, 500));
      const custConn = custWsObj.messages.find((m) => m.type === 'call_connected');
      const workConn = workWsObj.messages.find((m) => m.type === 'call_connected');
      assert(custConn, 'Caller (Customer) must receive call_connected event');
      assert(workConn, 'Receiver (Partner) must receive call_connected event');
      assert.strictEqual(custConn.callSessionId, activeCallSession.callSessionId);
    });

    // -------------------------------------------------------------------------
    // TEST 4: WebRTC SDP Offer Exchange
    // -------------------------------------------------------------------------
    await test('4. WebRTC Offer Transmission and Routing', async () => {
      workWsObj.messages.length = 0;

      const mockOffer = {
        type: 'offer',
        sdp: 'v=0\r\no=- 42 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
      };

      // Customer sends call_offer via WebSocket frame
      custWsObj.ws.send(
        JSON.stringify({
          type: 'call_offer',
          token: custToken,
          callSessionId: activeCallSession.callSessionId,
          sdp: mockOffer,
        })
      );

      await new Promise((r) => setTimeout(r, 600));
      const offerMsg = workWsObj.messages.find((m) => m.type === 'call_offer');
      assert(offerMsg, 'Partner must receive call_offer message via WebSocket');
      assert.strictEqual(offerMsg.callSessionId, activeCallSession.callSessionId);
      assert.strictEqual(offerMsg.sdp.type, 'offer');
      assert(offerMsg.sdp.sdp.includes('m=audio'), 'Must preserve audio SDP payload');
    });

    // -------------------------------------------------------------------------
    // TEST 5: WebRTC SDP Answer Exchange
    // -------------------------------------------------------------------------
    await test('5. WebRTC Answer Transmission and Routing', async () => {
      custWsObj.messages.length = 0;

      const mockAnswer = {
        type: 'answer',
        sdp: 'v=0\r\no=- 43 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
      };

      // Partner sends call_answer via WebSocket frame
      workWsObj.ws.send(
        JSON.stringify({
          type: 'call_answer',
          token: workToken,
          callSessionId: activeCallSession.callSessionId,
          sdp: mockAnswer,
        })
      );

      await new Promise((r) => setTimeout(r, 600));
      const answerMsg = custWsObj.messages.find((m) => m.type === 'call_answer');
      assert(answerMsg, 'Customer must receive call_answer message via WebSocket');
      assert.strictEqual(answerMsg.callSessionId, activeCallSession.callSessionId);
      assert.strictEqual(answerMsg.sdp.type, 'answer');
    });

    // -------------------------------------------------------------------------
    // TEST 6: WebRTC ICE Candidate Exchange (Bidirectional)
    // -------------------------------------------------------------------------
    await test('6. WebRTC ICE Candidate Exchange (Bidirectional)', async () => {
      workWsObj.messages.length = 0;
      custWsObj.messages.length = 0;

      const mockCandidate1 = {
        candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      };

      const mockCandidate2 = {
        candidate: 'candidate:2 1 UDP 1686052863 203.0.113.50 54322 typ srflx',
        sdpMid: '0',
        sdpMLineIndex: 0,
      };

      // Customer sends candidate to Partner
      custWsObj.ws.send(
        JSON.stringify({
          type: 'call_ice_candidate',
          token: custToken,
          callSessionId: activeCallSession.callSessionId,
          candidate: mockCandidate1,
        })
      );

      // Partner sends candidate to Customer
      workWsObj.ws.send(
        JSON.stringify({
          type: 'call_ice_candidate',
          token: workToken,
          callSessionId: activeCallSession.callSessionId,
          candidate: mockCandidate2,
        })
      );

      await new Promise((r) => setTimeout(r, 600));

      const workerCandidateMsg = workWsObj.messages.find((m) => m.type === 'call_ice_candidate');
      const custCandidateMsg = custWsObj.messages.find((m) => m.type === 'call_ice_candidate');

      assert(workerCandidateMsg, 'Partner must receive Customer ICE candidate');
      assert(custCandidateMsg, 'Customer must receive Partner ICE candidate');
      assert.strictEqual(workerCandidateMsg.candidate.sdpMid, '0');
      assert.strictEqual(custCandidateMsg.candidate.sdpMid, '0');
    });

    // -------------------------------------------------------------------------
    // TEST 7: Normal Call Termination and Duration Calculation
    // -------------------------------------------------------------------------
    await test('7. Normal Call Termination and Resource Teardown', async () => {
      workWsObj.messages.length = 0;
      custWsObj.messages.length = 0;

      // Small delay to simulate active call duration
      await new Promise((r) => setTimeout(r, 1100));

      const res = await makeRequest(
        'POST',
        `/api/bookings/${bookingCustomId}/call/${activeCallSession.callSessionId}/end`,
        { reason: 'normal' },
        custToken
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'CALL_ENDED');
      assert(res.data.durationSeconds >= 1, 'Duration must be at least 1 second');

      await new Promise((r) => setTimeout(r, 500));
      const custEnded = custWsObj.messages.find((m) => m.type === 'call_ended');
      const workEnded = workWsObj.messages.find((m) => m.type === 'call_ended');
      assert(custEnded, 'Customer received call_ended broadcast');
      assert(workEnded, 'Partner received call_ended broadcast');
      assert.strictEqual(workEnded.reason, 'normal');
    });

    // -------------------------------------------------------------------------
    // TEST 8: Call Rejection Flow (0s duration, CALL_REJECTED)
    // -------------------------------------------------------------------------
    await test('8. Call Rejection Flow (Partner calls, Customer rejects)', async () => {
      workWsObj.messages.length = 0;
      custWsObj.messages.length = 0;

      // Partner initiates call
      const initRes = await makeRequest('POST', `/api/bookings/${bookingCustomId}/call/initiate`, {}, workToken);
      assert.strictEqual(initRes.status, 200);
      const call2 = initRes.data.callSession;

      await new Promise((r) => setTimeout(r, 500));

      // Customer rejects call
      const rejectRes = await makeRequest(
        'POST',
        `/api/bookings/${bookingCustomId}/call/${call2.callSessionId}/end`,
        { reason: 'declined' },
        custToken
      );
      assert.strictEqual(rejectRes.status, 200);
      assert.strictEqual(rejectRes.data.status, 'CALL_REJECTED');
      assert.strictEqual(rejectRes.data.durationSeconds, 0, 'Rejected call duration must be 0s');

      await new Promise((r) => setTimeout(r, 500));
      const workRejected = workWsObj.messages.find((m) => m.type === 'call_ended');
      assert(workRejected, 'Partner received call_ended rejection broadcast');
      assert.strictEqual(workRejected.reason, 'declined');
    });

    // -------------------------------------------------------------------------
    // TEST 9: Security & Participant Permissions
    // -------------------------------------------------------------------------
    await test('9. Unauthorized stranger blocked from call initiation', async () => {
      const unauthorizedRes = await makeRequest(
        'POST',
        `/api/bookings/${bookingCustomId}/call/initiate`,
        {},
        strangerToken
      );
      assert.strictEqual(unauthorizedRes.status, 403, 'Unauthorized stranger must receive 403 Forbidden');
    });

    // -------------------------------------------------------------------------
    // TEST 10: Call History Verification
    // -------------------------------------------------------------------------
    await test('10. GET /api/bookings/:id/call/history returns recorded calls', async () => {
      const historyRes = await makeRequest('GET', `/api/bookings/${bookingCustomId}/call/history`, null, custToken);
      assert.strictEqual(historyRes.status, 200);
      assert(Array.isArray(historyRes.data.calls), 'Calls must be an array');
      assert(historyRes.data.calls.length >= 2, 'Must record both completed and rejected calls');
    });

  } finally {
    custWsObj.ws.close();
    workWsObj.ws.close();
    await Booking.deleteOne({ customId: bookingCustomId });
    await CallSession.deleteMany({ bookingId: bookingCustomId });
    server.close();
  }

  console.log('\n======================================================');
  console.log(`  WEBRTC CALLING TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
