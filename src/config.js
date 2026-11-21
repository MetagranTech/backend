const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config(); // Fallback to cwd if present

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const FORBIDDEN_PROD_VALUES = new Set([
  'dev-access-secret-change',
  'dev-refresh-secret-change',
  'dev-payment-webhook-secret',
  'dev-otp-secret-long-random-hash-key-homestepin-local',
  'replace-with-long-random-access-secret',
  'replace-with-long-random-refresh-secret',
  'replace-with-payment-webhook-secret',
  'your_long_random_secret_at_least_32_characters',
  'your_brevo_api_key',
  'your_brevo_smtp_key',
  'your_resend_api_key',
  'ChangeMe_Admin_1',
]);

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

function required(name, fallback, minLength = 0) {
  let value = process.env[name];
  if (!value && name === 'MONGODB_URI') {
    value = process.env.MONGO_URI;
  }
  value = value || (!isProduction ? fallback : undefined);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  if (typeof value === 'string' && (name === 'MONGODB_URI' || name === 'MONGO_URI')) {
    value = sanitizeMongoUri(value);
  }
  if (isProduction) {
    if (FORBIDDEN_PROD_VALUES.has(value)) {
      throw new Error(`Insecure default value detected for ${name} in production mode`);
    }
    if (minLength > 0 && value.length < minLength) {
      throw new Error(`Environment variable ${name} must be at least ${minLength} characters in production`);
    }
  }
  return value;
}

function csv(name, fallback = '') {
  return (process.env[name] || fallback)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

module.exports = {
  port: Number(process.env.PORT || 4001),
  mongoUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/homestepin'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET', 'dev-access-secret-change', 32),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET', 'dev-refresh-secret-change', 32),
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || '15m',
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL || '14d',
  paymentWebhookSecret: required('PAYMENT_WEBHOOK_SECRET', 'dev-payment-webhook-secret', 16),
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || 'dev-payment-webhook-secret',
  // Initial admin bootstrapping is optional in production.
  // When omitted or set to development defaults, existing admin accounts in MongoDB are preserved and startup succeeds normally.
  adminBootstrapEmail: (() => {
    let rawEmail = process.env.ADMIN_BOOTSTRAP_EMAIL;
    if (isProduction && rawEmail === 'admin@homestepin.local') {
      rawEmail = null;
    }
    const candidate = rawEmail || process.env.INITIAL_ADMIN_EMAIL;
    if (candidate && typeof candidate === 'string' && candidate.trim()) {
      const email = candidate.trim().toLowerCase();
      if (isProduction && email === 'admin@homestepin.local') {
        return null;
      }
      return email;
    }
    return !isProduction ? 'admin@homestepin.local' : null;
  })(),
  adminBootstrapPassword: (() => {
    const rawPw = process.env.INITIAL_ADMIN_PASSWORD || process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (rawPw && typeof rawPw === 'string' && rawPw.trim()) {
      const pw = rawPw.trim();
      if (isProduction) {
        if (FORBIDDEN_PROD_VALUES.has(pw)) {
          // Ignore dev default passwords in production to preserve existing MongoDB admin accounts
          return null;
        }
        if (pw.length < 12) {
          throw new Error('When provided in production, INITIAL_ADMIN_PASSWORD or ADMIN_BOOTSTRAP_PASSWORD must be a strong unique password of at least 12 characters');
        }
      }
      return pw;
    }
    // Optional in production: missing bootstrap credentials must never block startup
    return !isProduction ? 'ChangeMe_Admin_1' : null;
  })(),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:4001',
  corsOrigins: isProduction
    ? csv('CORS_ALLOWED_ORIGINS', required('CORS_ALLOWED_ORIGINS'))
    : csv('CORS_ALLOWED_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4001,http://127.0.0.1:4001,http://localhost:8081,http://127.0.0.1:8081'),
  // Stored here for the forthcoming server-side Razorpay adapter. They are not
  // required until that adapter is enabled, so cash-on-service can launch safely.
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  gmailSenderEmail: process.env.GMAIL_SENDER_EMAIL || '',
  googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
  googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  googleOauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB || 8),
  enterHomeMaxMeters: Number(process.env.ENTER_HOME_MAX_METERS || 180),
  // Mappls (MapmyIndia) Credentials for server-side REST APIs
  // Supports either OAuth 2.0 (Client ID & Secret) or direct API Key / Access Token
  mapplsClientId: process.env.MAPPLS_CLIENT_ID || '',
  mapplsClientSecret: process.env.MAPPLS_CLIENT_SECRET || '',
  // =========================================
  // Brevo Email Delivery Configuration
  // =========================================
  emailProvider: (process.env.EMAIL_PROVIDER || 'api').trim().toLowerCase(),
  emailFallbackProvider: (process.env.EMAIL_FALLBACK_PROVIDER || 'none').trim().toLowerCase(),

  // Brevo Email API
  brevoApiKey: (process.env.BREVO_API_KEY || '').trim(),

  // Brevo SMTP
  brevoSmtpHost: (process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com').trim(),
  brevoSmtpPort: Number(process.env.BREVO_SMTP_PORT || 587),
  brevoSmtpSecure: process.env.BREVO_SMTP_SECURE === 'true',
  brevoSmtpLogin: (process.env.BREVO_SMTP_LOGIN || '').trim(),
  brevoSmtpKey: (process.env.BREVO_SMTP_KEY || '').trim(),

  // Email Sender
  emailFrom: (process.env.EMAIL_FROM || 'support@homestepin.com').trim(),
  emailFromName: (process.env.EMAIL_FROM_NAME || 'HomeStepIn').trim(),

  // =========================================
  // Resend Email Delivery Configuration (Customer & Worker OTP)
  // =========================================
  resendApiKey: (process.env.RESEND_API_KEY || '').trim(),
  resendFromEmail: (process.env.RESEND_FROM_EMAIL || 'HomeStepIn <onboarding@resend.dev>').trim(),

  // =========================================
  // OneSignal Push Notification Configuration
  // =========================================
  oneSignalAppId: (process.env.ONESIGNAL_APP_ID || '').trim(),
  oneSignalRestApiKey: (process.env.ONESIGNAL_REST_API_KEY || '').trim(),

  otpSecret: required('OTP_SECRET', 'dev-otp-secret-long-random-hash-key-homestepin-local', 32),
  nodeEnv,
  isProduction,
};
