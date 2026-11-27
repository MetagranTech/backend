const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let financeConnection = null;
let financeMemoryServer = null;
let connectPromise = null;

const financeDbStatus = {
  isConnected: false,
  source: 'uninitialized',
  lastError: null,
};

function sanitizeUri(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().replace(/^['"]+|['"]+$/g, '').trim();
}

function deriveFinanceUriFromMain(mainUri) {
  if (!mainUri || typeof mainUri !== 'string') return '';
  try {
    const idx = mainUri.indexOf('?');
    const base = idx >= 0 ? mainUri.slice(0, idx) : mainUri;
    const query = idx >= 0 ? mainUri.slice(idx) : '';
    const lastSlash = base.lastIndexOf('/');
    if (lastSlash > base.indexOf('://') + 2) {
      const dbName = base.slice(lastSlash + 1);
      const financeDbName = dbName ? `${dbName}_finance` : 'homestepin_finance';
      return `${base.slice(0, lastSlash + 1)}${financeDbName}${query}`;
    }
    return `${base.replace(/\/$/, '')}/homestepin_finance${query}`;
  } catch {
    return '';
  }
}

async function connectFinanceDb(options = {}) {
  if (financeConnection && financeConnection.readyState === 1) {
    return financeConnection;
  }
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const isTest = process.env.NODE_ENV === 'test';
    const explicitUri = sanitizeUri(
      options.uri ||
      process.env.FINANCE_MONGODB_URI ||
      process.env.MONGO_FINANCE_URI ||
      ''
    );

    let targetUri = explicitUri;
    let source = 'env-finance-uri';

    if (!targetUri) {
      // Derive a separate finance database on the active MongoDB cluster/instance
      const mainClientUri =
        options.mainUri ||
        (mongoose.connection && mongoose.connection.client && mongoose.connection.client.s && mongoose.connection.client.s.url) ||
        process.env.MONGODB_URI ||
        '';

      if (mainClientUri && /^mongodb(\+srv)?:\/\//i.test(mainClientUri)) {
        targetUri = deriveFinanceUriFromMain(mainClientUri);
        source = isTest ? 'test-derived-finance-db' : 'derived-finance-db';
      }
    }

    if (!targetUri && isTest) {
      financeMemoryServer = await MongoMemoryServer.create({
        instance: { dbName: 'homestepin_finance_test' },
      });
      targetUri = financeMemoryServer.getUri();
      source = 'test-in-memory-finance';
    }

    if (!targetUri) {
      throw new Error('FINANCE_MONGODB_URI is not configured and could not be derived.');
    }

    const conn = mongoose.createConnection(targetUri, {
      maxPoolSize: 25,
      minPoolSize: 2,
      serverSelectionTimeoutMS: options.serverSelectionTimeoutMS || 8000,
    });

    conn.on('connected', () => {
      financeDbStatus.isConnected = true;
      financeDbStatus.lastError = null;
    });
    conn.on('disconnected', () => {
      financeDbStatus.isConnected = false;
    });
    conn.on('error', err => {
      financeDbStatus.lastError = err.message;
      if (conn.readyState !== 1) {
        financeDbStatus.isConnected = false;
      }
    });

    await conn.asPromise();
    financeConnection = conn;
    financeDbStatus.isConnected = true;
    financeDbStatus.source = source;
    financeDbStatus.lastError = null;
    console.log(`[Finance MongoDB] Connected successfully (source: ${source}, readyState: ${conn.readyState})`);
    return conn;
  })();

  try {
    return await connectPromise;
  } catch (err) {
    financeDbStatus.isConnected = false;
    financeDbStatus.lastError = err.message;
    throw err;
  } finally {
    connectPromise = null;
  }
}

async function disconnectFinanceDb() {
  connectPromise = null;
  if (financeConnection) {
    try {
      await financeConnection.close();
    } catch (_) {}
    financeConnection = null;
  }
  if (financeMemoryServer) {
    try {
      await financeMemoryServer.stop();
    } catch (_) {}
    financeMemoryServer = null;
  }
  financeDbStatus.isConnected = false;
}

function getFinanceConnection() {
  return financeConnection;
}

function getFinanceDbHealth() {
  const readyStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const state = financeConnection ? financeConnection.readyState : 0;
  const isHealthy = state === 1;
  return {
    status: isHealthy ? 'healthy' : 'degraded',
    readyState: readyStates[state] || 'disconnected',
    isConnected: isHealthy,
    source: financeDbStatus.source,
    error: isHealthy ? null : financeDbStatus.lastError,
  };
}

module.exports = {
  connectFinanceDb,
  disconnectFinanceDb,
  getFinanceConnection,
  getFinanceDbHealth,
  deriveFinanceUriFromMain,
};
