// Test script verifying MongoDB startup behavior, URI sanitization, and production protection
const assert = require('assert');

async function runTests() {
  console.log('=== Starting DB Startup & Production Protection Tests ===');

  // Test 1: Require db.js and verify exported methods
  const db = require('../src/db');
  assert(typeof db.connectDb === 'function', 'connectDb must be a function');
  assert(typeof db.disconnectDb === 'function', 'disconnectDb must be a function');
  assert(typeof db.getDbHealth === 'function', 'getDbHealth must be a function');
  console.log('[PASS] Test 1: db module exports required functions.');

  // Test 2: Test production invalid URI rejection (must throw, must not fall back to local)
  const originalEnv = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    process.env.MONGODB_URI = 'invalid-scheme-without-mongodb-prefix.net/db';

    let errorThrown = false;
    try {
      await db.connectDb();
    } catch (err) {
      errorThrown = true;
      assert(
        err.message.includes('[MongoDB Fatal] Invalid scheme in MONGODB_URI'),
        `Unexpected error message: ${err.message}`
      );
      assert(!err.message.includes('password'), 'Error message must not leak credentials');
      console.log(`[PASS] Test 2: In production, invalid URI properly rejected with clear error: "${err.message}"`);
    }
    assert(errorThrown, 'connectDb should have thrown on invalid URI in production');
  } finally {
    process.env = { ...originalEnv };
  }

  // Test 3: Test production missing URI rejection
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.MONGODB_URI;
    delete process.env.MONGO_URI;

    let errorThrown = false;
    try {
      await db.connectDb();
    } catch (err) {
      errorThrown = true;
      assert(
        err.message.includes('[MongoDB Fatal] Invalid scheme in MONGODB_URI'),
        `Unexpected error message: ${err.message}`
      );
      console.log(`[PASS] Test 3: In production, missing URI properly rejected without fallback: "${err.message}"`);
    }
    assert(errorThrown, 'connectDb should have thrown on missing URI in production');
  } finally {
    process.env = { ...originalEnv };
  }

  console.log('\n=== All DB Startup Protection Tests Passed Successfully ===');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
