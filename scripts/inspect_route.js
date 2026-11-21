const { execSync } = require('child_process');
const content = execSync('git show origin/main:backend/server.js', { maxBuffer: 30 * 1024 * 1024 }).toString();
const target = "app.post(['/api/auth/register-customer'";
const idx = content.indexOf(target);
if (idx !== -1) {
  console.log(content.slice(idx + 4000, idx + 5500));
} else {
  console.log('Not found');
}
