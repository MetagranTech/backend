const fs = require('fs');
const path = require('path');

// 1. Admin Tabs & Actions
const appTsx = fs.readFileSync('admin/src/App.tsx', 'utf8');
const setTabMatches = [...appTsx.matchAll(/setActiveTab\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
const adminTabs = [...new Set(setTabMatches)];

// 2. Customer Mobile Navigation & Screens
const custNavPath = 'customer-mobile/src/navigation';
let custRoutes = [];
if (fs.existsSync(custNavPath)) {
  const files = fs.readdirSync(custNavPath);
  files.forEach(f => {
    const c = fs.readFileSync(path.join(custNavPath, f), 'utf8');
    const matches = [...c.matchAll(/name=['"]([^'"]+)['"]/g)];
    custRoutes.push(...matches.map(m => m[1]));
  });
}

// 3. Worker Mobile Navigation & Screens
const workNavPath = 'worker-mobile/src/navigation';
let workRoutes = [];
if (fs.existsSync(workNavPath)) {
  const files = fs.readdirSync(workNavPath);
  files.forEach(f => {
    const c = fs.readFileSync(path.join(workNavPath, f), 'utf8');
    const matches = [...c.matchAll(/name=['"]([^'"]+)['"]/g)];
    workRoutes.push(...matches.map(m => m[1]));
  });
}

// 4. Backend API Routes
const serverJs = fs.readFileSync('backend/server.js', 'utf8');
const routeMatches = [...serverJs.matchAll(/app\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g)];
const apiRoutes = routeMatches.map(m => ({ method: m[1].toUpperCase(), path: m[2] }));

// Group API routes by category
const routesByCategory = {};
apiRoutes.forEach(r => {
  const prefix = r.path.split('/')[2] || 'root';
  if (!routesByCategory[prefix]) routesByCategory[prefix] = [];
  routesByCategory[prefix].push(`${r.method} ${r.path}`);
});

// 5. Database Models
const modelsDir = 'backend/src/models';
const models = fs.readdirSync(modelsDir).filter(f => f.endsWith('.js')).map(f => f.replace('.js', ''));

// 6. WebSocket and WebRTC Events
const wsEvents = [...new Set([...serverJs.matchAll(/type\s*===\s*['"]([^'"]+)['"]/g)].map(m => m[1]))];

console.log(JSON.stringify({
  adminTabs,
  custRoutes: [...new Set(custRoutes)],
  workRoutes: [...new Set(workRoutes)],
  modelsCount: models.length,
  models,
  apiRoutesCount: apiRoutes.length,
  routesByCategory,
  wsEventsCount: wsEvents.length,
  wsEvents
}, null, 2));
