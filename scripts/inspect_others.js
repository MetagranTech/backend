const { connectDb } = require('../src/db');
const mongoose = require('mongoose');

async function inspectOthers() {
  await connectDb();

  const outboxCount = await mongoose.connection.db.collection('notificationoutboxes').countDocuments();
  const sampleOutbox = await mongoose.connection.db.collection('notificationoutboxes').find().limit(3).toArray();
  console.log('=== NOTIFICATION OUTBOX SAMPLE ===');
  console.log('Total count:', outboxCount);
  console.log(JSON.stringify(sampleOutbox, null, 2));

  const banners = await mongoose.connection.db.collection('banners').find().toArray();
  console.log('\n=== BANNERS ===');
  console.log(JSON.stringify(banners, null, 2));

  const reviews = await mongoose.connection.db.collection('reviews').find().toArray();
  console.log('\n=== REVIEWS ===');
  console.log(JSON.stringify(reviews, null, 2));

  const complaints = await mongoose.connection.db.collection('complaints').find().toArray();
  console.log('\n=== COMPLAINTS ===');
  console.log(JSON.stringify(complaints, null, 2));

  const coupons = await mongoose.connection.db.collection('coupons').find().toArray();
  console.log('\n=== COUPONS ===');
  console.log(JSON.stringify(coupons, null, 2));

  process.exit(0);
}

inspectOthers().catch(err => {
  console.error(err);
  process.exit(1);
});

