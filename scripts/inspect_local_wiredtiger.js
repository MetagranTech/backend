const path = require('path');
const { MongoMemoryServer } = require('../node_modules/mongodb-memory-server');
const mongoose = require('../node_modules/mongoose');

async function inspectLocal() {
  const dataDir = path.resolve(__dirname, '..', 'data', 'db');
  console.log('Inspecting data directory:', dataDir);

  const server = await MongoMemoryServer.create({
    binary: { version: '4.4.26' },
    instance: { dbPath: dataDir, storageEngine: 'wiredTiger' }
  });
  const uri = server.getUri();
  console.log('Local MongoDB URI:', uri);

  const conn = await mongoose.createConnection(uri).asPromise();
  const admin = conn.db.admin();
  const dbs = await admin.listDatabases();
  console.log('Databases found in local instance:\n', JSON.stringify(dbs.databases, null, 2));

  for (const dbInfo of dbs.databases) {
    if (dbInfo.name === 'admin' || dbInfo.name === 'local') continue;
    const dbConn = await mongoose.createConnection(uri + dbInfo.name).asPromise();
    const cols = await dbConn.db.listCollections().toArray();
    console.log(`\n=== Database: ${dbInfo.name} ===`);
    for (const c of cols) {
      const count = await dbConn.db.collection(c.name).countDocuments();
      console.log(`  Collection ${c.name.padEnd(25)}: ${count} docs`);
    }
    await dbConn.close();
  }

  await conn.close();
  await server.stop();
  console.log('\nInspection complete.');
}

inspectLocal().catch(err => {
  console.error('Error inspecting local:', err);
  process.exit(1);
});
