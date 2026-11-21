const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { URL } = require('url');

let mongoServer = null;
let connectionPromise = null;

// Track connection state
const dbStatus = {
  isConnected: false,
  uri: '',
  source: '',
  lastError: null,
};

// ── Event Handlers ────────────────────────────────────────────────────
mongoose.connection.on('connected', () => {
  dbStatus.isConnected = true;
  dbStatus.lastError = null;
  console.log(`[MongoDB] Connected successfully (ReadyState: ${mongoose.connection.readyState})`);
});

mongoose.connection.on('disconnected', () => {
  dbStatus.isConnected = false;
  console.log('[MongoDB] Disconnected.');
});

mongoose.connection.on('reconnected', () => {
  dbStatus.isConnected = true;
  dbStatus.lastError = null;
  console.log('[MongoDB] Reconnected successfully.');
});

mongoose.connection.on('error', err => {
  // Only update isConnected to false if mongoose has truly lost connection
  if (mongoose.connection.readyState !== 1) {
    dbStatus.isConnected = false;
    dbStatus.lastError = err.message;
  }
  console.error('[MongoDB Error] Database connection issue:', err.message);
});

// ── Network & URI Helpers ─────────────────────────────────────────────

/**
 * Checks whether a TCP port is actively listening before passing the host to Mongoose.
 * Avoids registering unreachable hosts in Mongoose topology which causes repeated ECONNREFUSED loops.
 */
function isPortListening(host, port, timeoutMs = 300) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let isResolved = false;

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      if (!isResolved) {
        isResolved = true;
        cleanup();
        resolve(true);
      }
    });

    socket.once('timeout', () => {
      if (!isResolved) {
        isResolved = true;
        cleanup();
        resolve(false);
      }
    });

    socket.once('error', () => {
      if (!isResolved) {
        isResolved = true;
        cleanup();
        resolve(false);
      }
    });

    try {
      socket.connect(port, host);
    } catch {
      if (!isResolved) {
        isResolved = true;
        cleanup();
        resolve(false);
      }
    }
  });
}

function sanitizeMongoUri(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') return '';
  let uri = rawUri.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  uri = uri.replace(/^(MONGODB_URI|MONGO_URI|DATABASE_URL)\s*=\s*/i, '').trim();
  while (
    (uri.startsWith('"') && uri.endsWith('"')) ||
    (uri.startsWith("'") && uri.endsWith("'")) ||
    (uri.startsWith('“') && uri.endsWith('”')) ||
    (uri.startsWith('‘') && uri.endsWith('’'))
  ) {
    uri = uri.slice(1, -1).trim();
  }
  return uri.replace(/^['"]+|['"]+$/g, '').trim();
}

function isValidMongoScheme(uri) {
  if (!uri || typeof uri !== 'string') return false;
  return /^mongodb(\+srv)?:\/\//i.test(uri);
}

function isRemoteMongoUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  const cleaned = sanitizeMongoUri(uri);
  if (cleaned.startsWith('mongodb+srv://')) return true;
  const lower = cleaned.toLowerCase();
  return !lower.includes('127.0.0.1') && !lower.includes('localhost') && !lower.includes('::1');
}

function extractHostAndPort(uri) {
  try {
    if (!uri || uri.startsWith('mongodb+srv://')) return null;
    const dummyUrl = new URL(uri.replace(/^mongodb:\/\//i, 'http://'));
    return {
      host: dummyUrl.hostname || '127.0.0.1',
      port: Number(dummyUrl.port) || 27017,
      pathname: dummyUrl.pathname || '/homestepin',
    };
  } catch {
    return null;
  }
}

function sanitizeUri(uri) {
  if (!uri) return '';
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

function getSafeUriDiagnostics(rawUri, sanitizedUri) {
  const raw = rawUri || '';
  const sanitized = sanitizedUri || '';
  const schemeMatch = sanitized.match(/^mongodb(\+srv)?:\/\//i);
  const scheme = schemeMatch ? schemeMatch[0] : 'INVALID_OR_MISSING';

  let masked = '[no credentials]';
  let host = 'unknown';
  let dbName = 'unknown';

  if (isValidMongoScheme(sanitized)) {
    try {
      masked = sanitizeUri(sanitized);
      const withoutScheme = sanitized.replace(/^mongodb(?:\+srv)?:\/\//i, '');
      const hostPart = withoutScheme.split('/')[0].split('@').pop() || '';
      host = hostPart.split('?')[0];

      const afterSlash = withoutScheme.split('/')[1];
      if (afterSlash) {
        dbName = afterSlash.split('?')[0] || '';
      }
    } catch {
      masked = '[masking-error]';
    }
  }

  const rawPrefix = raw.length >= 12 ? raw.substring(0, 12) : raw;
  const rawSuffix = raw.length >= 6 ? raw.substring(raw.length - 6) : raw;

  return {
    rawLength: raw.length,
    sanitizedLength: sanitized.length,
    scheme,
    host,
    dbName,
    maskedUri: masked,
    rawPrefix: JSON.stringify(rawPrefix),
    rawSuffix: JSON.stringify(rawSuffix),
  };
}

// ── Database Connection Manager ───────────────────────────────────────

async function connectDb() {
  // 1. Return immediately if already connected
  if (mongoose.connection.readyState === 1) {
    dbStatus.isConnected = true;
    return mongoose.connection;
  }

  // 2. Return in-flight promise if connection attempt is already underway (Singleton Mutex)
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    const isProduction = process.env.NODE_ENV === 'production';
    const isTest = process.env.NODE_ENV === 'test';

    const rawUri = process.env.MONGODB_URI || process.env.MONGO_URI || (!isProduction ? 'mongodb://127.0.0.1:27017/homestepin' : '');
    const requestedUri = sanitizeMongoUri(rawUri);
    const totalWorkers = parseInt(process.env.CLUSTER_TOTAL_WORKERS || '1', 10);
    const maxPoolSize = Math.max(15, Math.floor(100 / totalWorkers));
    const minPoolSize = Math.max(2, Math.floor(10 / totalWorkers));

    const diag = getSafeUriDiagnostics(rawUri, requestedUri);

    // Strict validation for production mode
    if (isProduction) {
      if (!requestedUri || !isValidMongoScheme(requestedUri)) {
        console.error(`[MongoDB Fatal] Invalid MongoDB connection string in production.`);
        console.error(`[MongoDB Diagnostics] rawLength: ${diag.rawLength}, prefix: ${diag.rawPrefix}, scheme: ${diag.scheme}`);
        throw new Error(
          `[MongoDB Fatal] Invalid scheme in MONGODB_URI. Expected connection string to start with "mongodb://" or "mongodb+srv://", but received prefix ${diag.rawPrefix} (raw length: ${diag.rawLength}). Check the MONGODB_URI environment variable on Render.`
        );
      }
    }

    // ── PATH A: Cloud / Remote Deployment (Atlas, AWS, Docker Container) ──
    if (isProduction || isRemoteMongoUri(requestedUri)) {
      console.log(`[MongoDB] Connecting to remote cluster: host=${diag.host}, db=${diag.dbName}, scheme=${diag.scheme}, uriLength=${diag.sanitizedLength}...`);
      let lastErr = null;
      const maxAttempts = isProduction ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const connectOptions = {
            maxPoolSize,
            minPoolSize,
            serverSelectionTimeoutMS: isProduction ? 15000 : 3000,
            socketTimeoutMS: 45000,
            autoIndex: !isProduction,
          };
          if (!requestedUri.startsWith('mongodb+srv://') && process.env.MONGO_FORCE_IPV4 === 'true') {
            connectOptions.family = 4;
          }
          await mongoose.connect(requestedUri, connectOptions);
          dbStatus.isConnected = true;
          dbStatus.uri = sanitizeUri(requestedUri);
          dbStatus.source = 'cloud-remote';
          dbStatus.lastError = null;
          console.log(`[MongoDB] Connected successfully to remote database: ${diag.maskedUri}`);
          return mongoose.connection;
        } catch (err) {
          lastErr = err;
          console.warn(`[MongoDB Warning] Remote connection attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
          if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, attempt * 1500));
          }
        }
      }
      dbStatus.lastError = lastErr?.message;
      if (!isProduction) {
        console.warn(`[MongoDB Fallback] Remote cluster unreachable (check IP whitelist at https://cloud.mongodb.com/v2#/security/network/accessList). Falling back to persistent local MongoDB engine for development.`);
      } else {
        throw new Error(`[MongoDB Fatal] Remote MongoDB cluster unreachable in production after ${maxAttempts} attempts: ${lastErr?.message}. Aborting startup.`);
      }
    }

    // Explicit guard: In production, NEVER proceed to Path B!
    if (isProduction) {
      throw new Error(`[MongoDB Fatal] Production environment requires a valid remote MongoDB connection. Local database fallback is strictly disabled.`);
    }

    // ── PATH B: Local Development & Staging ──────────────────────────────
    const uriFile = path.resolve(__dirname, '..', 'data', 'active_mongo.json');
    const isSecondaryClusterWorker = parseInt(process.env.CLUSTER_WORKER_INDEX || '0', 10) > 0;

    // Check 1: Is the specified local MONGODB_URI (e.g. 127.0.0.1:27017) actively listening?
    const parsedTarget = extractHostAndPort(requestedUri);
    if (parsedTarget) {
      const isListening = await isPortListening(parsedTarget.host, parsedTarget.port, 250);
      if (isListening) {
        try {
          await mongoose.connect(requestedUri, {
            maxPoolSize,
            minPoolSize,
            serverSelectionTimeoutMS: 2000,
            connectTimeoutMS: 3000,
          });
          dbStatus.isConnected = true;
          dbStatus.uri = sanitizeUri(requestedUri);
          dbStatus.source = 'local-daemon';
          dbStatus.lastError = null;
          return mongoose.connection;
        } catch (e) {
          // If connection failed despite port being open, fall through
        }
      }
    }

    // Check 2: Check for active local shared MongoDB instance (e.g. cluster Worker 0 or running daemon)
    if (isSecondaryClusterWorker) {
      // Secondary cluster workers wait for Primary / Worker 0 to initialize database
      for (let waitStep = 0; waitStep < 120; waitStep++) {
        if (fs.existsSync(uriFile)) break;
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!isTest && fs.existsSync(uriFile)) {
      try {
        const fileContent = fs.readFileSync(uriFile, 'utf8');
        const { uri } = JSON.parse(fileContent);
        const parsedActive = extractHostAndPort(uri);

        // Pre-flight socket probe: Only connect if the active instance port is ACTUALLY listening!
        if (parsedActive && (await isPortListening(parsedActive.host, parsedActive.port, 250))) {
          await mongoose.connect(uri, {
            maxPoolSize,
            minPoolSize,
            serverSelectionTimeoutMS: 3000,
          });
          dbStatus.isConnected = true;
          dbStatus.uri = uri;
          dbStatus.source = 'shared-local-mongo';
          dbStatus.lastError = null;
          return mongoose.connection;
        } else {
          // Dead or stale instance file from a previous terminated run — delete cleanly
          try { fs.unlinkSync(uriFile); } catch {}
        }
      } catch (e) {
        try { fs.unlinkSync(uriFile); } catch {}
      }
    }

    if (isSecondaryClusterWorker) {
      throw new Error(`[Secondary Worker ${process.pid}] Timed out waiting for primary database initialization.`);
    }

    // Check 3: Start local MongoDB instance using MongoMemoryServer
    try {
      console.log(`[MongoDB] Initializing ${isTest ? 'isolated in-memory test' : 'persistent local'} MongoDB storage engine...`);
      const { MongoMemoryServer } = require('mongodb-memory-server');

      const instanceConfig = {
        dbName: isTest ? 'homestepin_test' : 'homestepin',
        launchTimeout: 60000,
      };

      let dataDir = null;
      if (!isTest) {
        // Cross-platform data directory path (configurable via MONGODB_LOCAL_DATA_DIR)
        dataDir = process.env.MONGODB_LOCAL_DATA_DIR
          ? path.resolve(process.env.MONGODB_LOCAL_DATA_DIR)
          : path.resolve(__dirname, '..', 'data', 'db');

        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        instanceConfig.dbPath = dataDir;
        instanceConfig.storageEngine = 'wiredTiger';
      }

      mongoServer = await MongoMemoryServer.create({
        binary: {
          version: '4.4.26',
        },
        instance: instanceConfig,
      });

      const embeddedUri = mongoServer.getUri();
      if (!isTest) {
        fs.writeFileSync(uriFile, JSON.stringify({ uri: embeddedUri, pid: process.pid }));
      }

      await mongoose.connect(embeddedUri, {
        maxPoolSize: 50,
        minPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
      });

      dbStatus.isConnected = true;
      dbStatus.uri = 'local-persistent-wiredTiger (data/db)';
      dbStatus.source = 'persistent-embedded';
      dbStatus.lastError = null;
      console.log(`[MongoDB] Persistent database online using WiredTiger engine at ${dataDir || 'in-memory'}`);

      return mongoose.connection;
    } catch (embeddedErr) {
      console.error(`[MongoDB Fatal] Could not establish database connection:`, embeddedErr.message);
      dbStatus.lastError = embeddedErr.message;
      dbStatus.isConnected = false;
      throw embeddedErr;
    }
  })();

  try {
    const conn = await connectionPromise;
    return conn;
  } finally {
    connectionPromise = null;
  }
}

async function disconnectDb() {
  connectionPromise = null;
  const isTest = process.env.NODE_ENV === 'test';
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    // Only stop mongoServer if THIS process created it
    if (mongoServer) {
      const uriFile = path.resolve(__dirname, '..', 'data', 'active_mongo.json');
      if (!isTest && fs.existsSync(uriFile)) {
        try { fs.unlinkSync(uriFile); } catch {}
      }
      await mongoServer.stop({ doCleanup: false, force: false });
      mongoServer = null;
    }
    dbStatus.isConnected = false;
    console.log('[MongoDB] Connection closed cleanly.');
  } catch (err) {
    console.error('[MongoDB Error] Error during disconnection:', err.message);
  }
}

function getDbHealth() {
  const readyStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const isHealthy = mongoose.connection.readyState === 1;
  return {
    status: isHealthy ? 'healthy' : 'degraded',
    readyState: readyStates[mongoose.connection.readyState] || 'unknown',
    isConnected: isHealthy,
    source: dbStatus.source,
    error: isHealthy ? null : dbStatus.lastError,
  };
}

module.exports = {
  connectDb,
  disconnectDb,
  getDbHealth,
};
