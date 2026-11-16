const { connectDb } = require('../src/db');
const mongoose = require('mongoose');

async function audit() {
  await connectDb();
  const collections = await mongoose.connection.db.listCollections().toArray();
  console.log('=== DATABASE COLLECTIONS AUDIT ===');
  for (const col of collections) {
    const count = await mongoose.connection.db.collection(col.name).countDocuments();
    console.log(`Collection: ${col.name.padEnd(25)} Count: ${count}`);
  }
  const users = await mongoose.connection.db.collection('users').find({}, { projection: { email: 1, name: 1, role: 1, adminRole: 1, customId: 1, isProtected: 1 } }).toArray();
  console.log('\n=== ALL USERS IN DB ===');
  console.log(JSON.stringify(users, null, 2));

  const bookings = await mongoose.connection.db.collection('bookings').find({}, { projection: { customId: 1, customerName: 1, providerName: 1, status: 1, serviceName: 1, createdAt: 1 } }).toArray();
  console.log('\n=== ALL BOOKINGS IN DB ===');
  console.log(JSON.stringify(bookings, null, 2));

  const services = await mongoose.connection.db.collection('services').find({}, { projection: { customId: 1, name: 1, imageUrl: 1, cloudinaryPublicId: 1 } }).toArray();
  console.log('\n=== ALL SERVICES IN DB ===');
  console.log(JSON.stringify(services, null, 2));

  process.exit(0);
}

audit().catch(err => {
  console.error(err);
  process.exit(1);
});

