const mongoose = require('mongoose');
const { connectDb, disconnectDb } = require('../src/db');

async function check() {
  await connectDb();
  const db = mongoose.connection.db;
  const cols = await db.collections();
  console.log('=== LOCAL DB COLLECTIONS & COUNTS ===');
  for (const c of cols) {
    const count = await c.countDocuments();
    console.log(`${c.collectionName}: ${count}`);
  }
  await disconnectDb();
}

check().catch(console.error);
