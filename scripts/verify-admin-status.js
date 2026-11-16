const { connectDb, disconnectDb } = require('../src/db');
const User = require('../src/models/User');

(async () => {
  await connectDb();
  const admins = await User.find({ role: 'admin' }).select('+passwordHash').lean();
  console.log('--- Current Administrator Accounts in Database ---');
  admins.forEach(a => {
    console.log(`Email: ${a.email} | Role: ${a.role} | Status: ${a.status} | mustChangePassword: ${a.mustChangePassword} | HasPasswordHash: ${Boolean(a.passwordHash)}`);
  });
  await disconnectDb();
  process.exit(0);
})();
