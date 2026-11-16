const https = require('https');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const config = require('../config');

// Standard public Firebase Web API Key for project step-in-6dbd6
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDuA5cItec-EDPZfABrBurgmUZ7EaffRDE';

// In-memory replay prevention cache for verified Firebase tokens
// Tokens are single-use for account registration / verification actions
const usedFirebaseTokens = new Set();
setInterval(() => {
  usedFirebaseTokens.clear();
}, 30 * 60 * 1000).unref();

let firebaseApp = null;
let firebaseAuth = null;
let firebaseInitError = null;

function initializeFirebase() {
  if (firebaseApp && firebaseAuth) {
    return { app: firebaseApp, auth: firebaseAuth, error: null };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    firebaseInitError = new Error('Firebase credentials (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) not fully configured in environment.');
    console.warn('[Firebase Service] Warning:', firebaseInitError.message);
    return { app: null, auth: null, error: firebaseInitError };
  }

  // Format private key correctly (handling escaped newlines)
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  try {
    const existingApps = getApps();
    if (existingApps.length > 0) {
      firebaseApp = existingApps[0];
    } else {
      firebaseApp = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    }

    firebaseAuth = getAuth(firebaseApp);
    firebaseInitError = null;
    console.log(`[Firebase Service] Successfully initialized Firebase Admin for project: ${projectId}`);
    return { app: firebaseApp, auth: firebaseAuth };
  } catch (err) {
    firebaseInitError = err;
    console.error('[Firebase Service] Failed to initialize Firebase Admin SDK:', err.message);
    return { app: null, auth: null, error: err };
  }
}

// Auto-initialize on module load
initializeFirebase();

/**
 * Helper: Call Firebase Identity Toolkit REST API
 */
function callFirebaseRest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = https.request(
      {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/v1/${endpoint}?key=${FIREBASE_WEB_API_KEY}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) {
              const err = new Error(parsed?.error?.message || `Firebase REST error ${res.statusCode}`);
              err.status = res.statusCode;
              err.code = parsed?.error?.message || 'FIREBASE_REST_ERROR';
              return reject(err);
            }
            resolve(parsed);
          } catch (_) {
            if (res.statusCode >= 400) {
              const err = new Error(`Firebase REST error ${res.statusCode}: ${raw}`);
              err.status = res.statusCode;
              return reject(err);
            }
            resolve(raw);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Verify a Firebase ID Token received from client app for Email/Password authentication.
 * Server-side cryptographic check via Firebase Admin SDK.
 * 
 * @param {string} idToken - The Firebase ID token from client
 * @param {string} [expectedEmail] - Optional expected email to cross-validate
 * @returns {Promise<{ valid: boolean, uid: string, email: string, emailVerified: boolean, claims: object }>}
 */
async function verifyFirebaseEmailToken(idToken, expectedEmail = null) {
  if (!idToken || typeof idToken !== 'string') {
    const err = new Error('Firebase ID token is required.');
    err.code = 'FIREBASE_TOKEN_MISSING';
    err.status = 400;
    throw err;
  }

  const { auth, error } = initializeFirebase();
  if (!auth) {
    const err = new Error('Firebase Authentication is not available on the server.');
    err.code = 'FIREBASE_UNAVAILABLE';
    err.status = 503;
    err.details = error ? error.message : 'Missing configuration';
    throw err;
  }

  // Token replay prevention check (last 32 chars)
  const tokenFingerprint = idToken.slice(-32);
  if (usedFirebaseTokens.has(tokenFingerprint)) {
    const err = new Error('This Firebase verification token has already been used. Please sign in again.');
    err.code = 'FIREBASE_TOKEN_REPLAY';
    err.status = 400;
    throw err;
  }

  try {
    const decodedToken = await auth.verifyIdToken(idToken, true);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const authTime = decodedToken.auth_time || decodedToken.iat;
    if (nowSeconds - authTime > 60 * 60) { // Fresh within 60 minutes
      const err = new Error('Firebase authentication session has expired. Please sign in again.');
      err.code = 'FIREBASE_TOKEN_EXPIRED';
      err.status = 401;
      throw err;
    }

    const tokenEmail = (decodedToken.email || '').trim().toLowerCase();
    if (!tokenEmail) {
      const err = new Error('The provided Firebase token does not contain an email address.');
      err.code = 'FIREBASE_NO_EMAIL';
      err.status = 400;
      throw err;
    }

    if (expectedEmail) {
      const normalizedExpected = String(expectedEmail).trim().toLowerCase();
      if (tokenEmail !== normalizedExpected) {
        const err = new Error(`Email mismatch: Token was verified for ${tokenEmail}, but request specified ${normalizedExpected}.`);
        err.code = 'EMAIL_MISMATCH';
        err.status = 400;
        throw err;
      }
    }

    return {
      valid: true,
      uid: decodedToken.uid,
      email: tokenEmail,
      emailVerified: Boolean(decodedToken.email_verified),
      claims: decodedToken,
    };
  } catch (err) {
    if (err.code && (err.code.startsWith('FIREBASE_') || err.code === 'EMAIL_MISMATCH')) {
      throw err;
    }
    if (err.code === 'auth/id-token-expired') {
      const customErr = new Error('Firebase verification token has expired. Please sign in again.');
      customErr.code = 'FIREBASE_TOKEN_EXPIRED';
      customErr.status = 401;
      throw customErr;
    }
    if (err.code === 'auth/argument-error' || err.code === 'auth/invalid-id-token') {
      const customErr = new Error('Invalid Firebase verification token.');
      customErr.code = 'FIREBASE_TOKEN_INVALID';
      customErr.status = 401;
      throw customErr;
    }

    const customErr = new Error(`Firebase token verification failed: ${err.message}`);
    customErr.code = 'FIREBASE_VERIFICATION_FAILED';
    customErr.status = 400;
    throw customErr;
  }
}

/**
 * Mark a token fingerprint as consumed to prevent replay attack
 */
function markTokenAsUsed(idToken) {
  if (idToken && typeof idToken === 'string') {
    usedFirebaseTokens.add(idToken.slice(-32));
  }
}

/**
 * Send Firebase Email Verification using Firebase Identity Toolkit REST API
 */
async function sendFirebaseVerificationEmail(idToken) {
  if (!idToken) throw new Error('ID token required to dispatch verification email');
  return callFirebaseRest('accounts:sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken,
  });
}

/**
 * Send Firebase Password Reset Email using Firebase Identity Toolkit REST API
 */
async function sendFirebasePasswordResetEmail(email) {
  if (!email) throw new Error('Email required for password reset');
  return callFirebaseRest('accounts:sendOobCode', {
    requestType: 'PASSWORD_RESET',
    email: email.trim().toLowerCase(),
  });
}

/**
 * Generate password reset link via Firebase Admin SDK
 */
async function generateFirebasePasswordResetLink(email) {
  const { auth } = initializeFirebase();
  if (!auth) throw new Error('Firebase Authentication is not available.');
  return auth.generatePasswordResetLink(email.trim().toLowerCase());
}

/**
 * Generate email verification link via Firebase Admin SDK
 */
async function generateFirebaseEmailVerificationLink(email) {
  const { auth } = initializeFirebase();
  if (!auth) throw new Error('Firebase Authentication is not available.');
  return auth.generateEmailVerificationLink(email.trim().toLowerCase());
}

/**
 * Fetch Firebase User Record by email using Admin SDK
 */
async function getFirebaseUserByEmail(email) {
  const { auth } = initializeFirebase();
  if (!auth) return null;
  try {
    return await auth.getUserByEmail(email.trim().toLowerCase());
  } catch (err) {
    if (err.code === 'auth/user-not-found') return null;
    throw err;
  }
}

/**
 * Create or sync user in Firebase Authentication
 */
async function syncFirebaseUser({ email, password, displayName = null, emailVerified = false }) {
  const { auth } = initializeFirebase();
  if (!auth) throw new Error('Firebase Authentication is not available.');
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const existing = await auth.getUserByEmail(normalizedEmail);
    return existing;
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      return auth.createUser({
        email: normalizedEmail,
        password: password || undefined,
        displayName: displayName || undefined,
        emailVerified: Boolean(emailVerified),
      });
    }
    throw err;
  }
}

/**
 * Update emailVerified status on a Firebase user.
 */
async function setFirebaseUserEmailVerified(uid, emailVerified = true) {
  const { auth } = initializeFirebase();
  if (!auth || !uid) return null;
  try {
    return await auth.updateUser(uid, { emailVerified: Boolean(emailVerified) });
  } catch (err) {
    console.warn('[Firebase setFirebaseUserEmailVerified Warning]:', err.message);
    return null;
  }
}

/**
 * Safe status getter for health/diagnostic checks (without exposing secrets).
 */
function getFirebaseStatus() {
  return {
    configured: !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY),
    projectId: process.env.FIREBASE_PROJECT_ID || null,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL ? `${process.env.FIREBASE_CLIENT_EMAIL.split('@')[0]}@...` : null,
    initialized: !!firebaseAuth,
    initError: firebaseInitError ? firebaseInitError.message : null,
  };
}

module.exports = {
  initializeFirebase,
  verifyFirebaseEmailToken,
  markTokenAsUsed,
  sendFirebaseVerificationEmail,
  sendFirebasePasswordResetEmail,
  generateFirebasePasswordResetLink,
  generateFirebaseEmailVerificationLink,
  getFirebaseUserByEmail,
  syncFirebaseUser,
  setFirebaseUserEmailVerified,
  getFirebaseStatus,
  FIREBASE_WEB_API_KEY,
};
