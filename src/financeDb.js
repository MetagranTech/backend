const mongoose = require('mongoose');

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
  let uri = raw.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  uri = uri.replace(/^(FINANCE_MONGODB_URI|MONGO_FINANCE_URI|MONGODB_URI)\s*=\s*/i, '').trim();
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

function getSafeFinanceUriDiagnostics(uri, source) {
  const safe = uri || '';
  const schemeMatch = safe.match(/^mongodb(\+srv)?:\/\//i);
  const scheme = schemeMatch ? schemeMatch[0] : 'INVALID_OR_MISSING';
  let host = 'unknown';
  let dbName = 'default';
  let queryKeys = [];

  if (schemeMatch) {
    try {
      const withoutScheme = safe.replace(/^mongodb(?:\+srv)?:\/\//i, '');
      const atIdx = withoutScheme.indexOf('@');
      const afterCreds = atIdx >= 0 ? withoutScheme.slice(atIdx + 1) : withoutScheme;
      const slashIdx = afterCreds.indexOf('/');
      const qIdx = afterCreds.indexOf('?');

      if (slashIdx >= 0) {
        host = afterCreds.slice(0, slashIdx) || 'unknown';
        const afterSlash = afterCreds.slice(slashIdx + 1);
        const qInPath = afterSlash.indexOf('?');
        dbName = (qInPath >= 0 ? afterSlash.slice(0, qInPath) : afterSlash) || 'default';
        if (qInPath >= 0) {
          queryKeys = afterSlash
            .slice(qInPath + 1)
            .split('&')
            .map(p => p.split('=')[0])
            .filter(Boolean);
        }
      } else if (qIdx >= 0) {
        host = afterCreds.slice(0, qIdx) || 'unknown';
        queryKeys = afterCreds
          .slice(qIdx + 1)
          .split('&')
          .map(p => p.split('=')[0])
          .filter(Boolean);
      } else {
        host = afterCreds || 'unknown';
      }
    } catch {
      host = 'parse-error';
    }
  }

  return {
    source,
    scheme,
    host,
    dbName,
    queryKeys,
    hasAuthSource: queryKeys.includes('authSource'),
    uriLength: safe.length,
  };
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
    const isProduction = process.env.NODE_ENV === 'production';
    const isTest = process.env.NODE_ENV === 'test';
    const explicitUri = sanitizeUri(
      options.uri ||
      process.env.FINANCE_MONGODB_URI ||
      process.env.MONGO_FINANCE_URI ||
      ''
    );

    if (isProduction && (!explicitUri || !/^mongodb(\+srv)?:\/\//i.test(explicitUri))) {
      throw new Error(
        'FINANCE_MONGODB_URI is required in production (separate cluster/database; never falling back to MONGODB_URI or in-memory DB).'
      );
    }

    let targetUri = explicitUri;
    let source = 'env-finance-uri';

    if (!targetUri && !isProduction) {
      // Non-production convenience: derive a separate finance database on the active local/test instance
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

    if (!targetUri && isTest && !isProduction) {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      financeMemoryServer = await MongoMemoryServer.create({
        instance: { dbName: 'homestepin_finance_test' },
      });
      targetUri = financeMemoryServer.getUri();
      source = 'test-in-memory-finance';
    }

    if (!targetUri) {
      throw new Error('FINANCE_MONGODB_URI is not configured and could not be derived.');
    }

    const diag = getSafeFinanceUriDiagnostics(targetUri, source);
    console.log(
      `[Finance MongoDB] Connecting: source=${diag.source}, host=${diag.host}, db=${diag.dbName}, scheme=${diag.scheme}, hasAuthSource=${diag.hasAuthSource}, queryKeys=[${diag.queryKeys.join(',')}], uriLength=${diag.uriLength}`
    );

    const conn = mongoose.createConnection(targetUri, {
      maxPoolSize: 25,
      minPoolSize: 2,
      serverSelectionTimeoutMS: options.serverSelectionTimeoutMS || (isProduction ? 15000 : 8000),
      socketTimeoutMS: 45000,
      autoIndex: !isProduction,
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

    try {
      await conn.asPromise();
    } catch (err) {
      console.error(
        `[Finance MongoDB Error] Connection failed: source=${diag.source}, host=${diag.host}, db=${diag.dbName}, errorName=${err?.name || 'Error'}, reason=${err?.message || 'unknown'}`
      );
      throw err;
    }
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
