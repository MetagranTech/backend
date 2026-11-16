/**
 * HomeStepIn — Resend Email Delivery Service
 *
 * Dedicated provider for Customer six-digit email OTPs:
 * - Customer registration verification OTP
 * - Customer password-reset OTP
 * - OTP resend functionality
 *
 * Exclusively uses the official Resend Node.js SDK (`resend`).
 * Strictly protects credentials and enforces operational safety.
 */

'use strict';

const { Resend } = require('resend');
const config = require('../config');

// In-memory test inbox for deterministic testing (strictly gated to NODE_ENV === 'test')
let testTransport = null;
const testInbox = [];

/**
 * Initialize Resend client instance.
 * Reads API key strictly from environment variables / backend configuration.
 */
function getResendClient() {
  const apiKey = (process.env.RESEND_API_KEY || config.resendApiKey || '').trim();
  if (!apiKey || apiKey.startsWith('your_') || apiKey.startsWith('re_your_')) {
    const err = new Error('Resend API key is not configured. Please set RESEND_API_KEY in backend/.env');
    err.code = 'RESEND_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }
  return new Resend(apiKey);
}

/**
 * Validate Resend configuration status.
 * @returns {{ configured: boolean, hasApiKey: boolean, isPlaceholder: boolean, senderEmail: string }}
 */
function validateResendConfig() {
  const apiKey = (process.env.RESEND_API_KEY || config.resendApiKey || '').trim();
  const senderEmail = (process.env.RESEND_FROM_EMAIL || config.resendFromEmail || 'HomeStepIn <onboarding@resend.dev>').trim();
  const hasApiKey = Boolean(apiKey && apiKey.startsWith('re_'));
  const isPlaceholder = Boolean(apiKey.includes('your') || apiKey.includes('placeholder'));
  const configured = hasApiKey && !isPlaceholder;

  return {
    configured,
    hasApiKey,
    isPlaceholder,
    senderEmail,
  };
}

/**
 * Configure test transport hook for automated testing.
 * Strictly gated to NODE_ENV === 'test'.
 */
function setTestResendTransport(transport) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Test transport hooks are strictly forbidden outside of NODE_ENV === "test"');
  }
  testTransport = transport;
}

/**
 * Retrieve latest OTP sent to an email address in test mode.
 */
function getLatestTestOtp(email) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  for (let i = testInbox.length - 1; i >= 0; i--) {
    if (testInbox[i].to === normalized) {
      return testInbox[i].otp;
    }
  }
  return null;
}

/**
 * Inspect in-memory test inbox.
 */
function getTestInbox() {
  return [...testInbox];
}

/**
 * Clear in-memory test inbox.
 */
function clearTestInbox() {
  testInbox.length = 0;
}

/**
 * Branded dark-purple HTML email template generator for HomeStepIn OTPs.
 * Consistent with HomeStepIn mobile app dark-purple theme (#0f0728 / #7c3aed).
 */
function buildCustomerOtpEmailHtml({ otp, expiresInMinutes = 5 }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your HomeStepIn verification code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f0728; color: #f5f3ff; margin: 0; padding: 24px; }
    .card { max-width: 480px; margin: 0 auto; background-color: #1a103c; border-radius: 16px; border: 1px solid #3b1d82; padding: 32px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
    .header { text-align: center; padding-bottom: 24px; border-bottom: 1px solid #2e1065; }
    .logo { display: inline-block; font-size: 26px; font-weight: 900; color: #a855f7; letter-spacing: -0.5px; text-decoration: none; }
    .logo span { color: #f5f3ff; }
    .tag { display: inline-block; background: #2e1065; color: #c084fc; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 12px; border-radius: 999px; margin-top: 8px; border: 1px solid #581c87; letter-spacing: 0.8px; }
    .body { padding: 28px 0; text-align: center; }
    .instruction { font-size: 15px; color: #ddd6fe; line-height: 1.5; margin: 0 0 20px 0; font-weight: 500; }
    .otp-box { background: #110b27; border: 2px dashed #7c3aed; border-radius: 12px; padding: 18px 24px; display: inline-block; margin: 8px auto 20px auto; }
    .otp-code { font-size: 36px; font-weight: 900; letter-spacing: 10px; color: #c084fc; font-family: 'Courier New', Courier, monospace; }
    .expiry { font-size: 13px; color: #a78bfa; margin-top: 6px; font-weight: 600; }
    .notice { font-size: 13px; color: #94a3b8; line-height: 1.5; margin-top: 24px; padding: 12px 16px; background: rgba(30, 27, 75, 0.45); border-radius: 8px; border-left: 3px solid #7c3aed; text-align: left; }
    .footer { text-align: center; padding-top: 24px; border-top: 1px solid #2e1065; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo">Home<span>StepIn</span></div>
      <div><span class="tag">VERIFICATION CODE</span></div>
    </div>
    <div class="body">
      <p class="instruction">Your verification code is:</p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
      </div>
      <div class="expiry">This code expires in ${expiresInMinutes} minutes.</div>
      <div class="notice">
        If you did not request this code, ignore this email. Never share this code with anyone.
      </div>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} HomeStepIn Technologies. All rights reserved.
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Branded dark-purple HTML email template generator for HomeStepIn Partner OTPs.
 * Uses emerald/teal accent colors (#00A878 / #34d399) matching the Partner app theme.
 */
function buildWorkerOtpEmailHtml({ otp, expiresInMinutes = 5 }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HomeStepIn Partner - Password Reset Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f0728; color: #f5f3ff; margin: 0; padding: 24px; }
    .card { max-width: 480px; margin: 0 auto; background-color: #1a103c; border-radius: 16px; border: 1px solid #1e3a5f; padding: 32px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
    .header { text-align: center; padding-bottom: 24px; border-bottom: 1px solid #1e293b; }
    .logo { display: inline-block; font-size: 26px; font-weight: 900; color: #00A878; letter-spacing: -0.5px; text-decoration: none; }
    .logo span { color: #f5f3ff; }
    .tag { display: inline-block; background: #064e3b; color: #34d399; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 12px; border-radius: 999px; margin-top: 8px; border: 1px solid #059669; letter-spacing: 0.8px; }
    .body { padding: 28px 0; text-align: center; }
    .instruction { font-size: 15px; color: #cbd5e1; line-height: 1.5; margin: 0 0 20px 0; font-weight: 500; }
    .otp-box { background: #0f172a; border: 2px dashed #00A878; border-radius: 12px; padding: 18px 24px; display: inline-block; margin: 8px auto 20px auto; }
    .otp-code { font-size: 36px; font-weight: 900; letter-spacing: 10px; color: #34d399; font-family: 'Courier New', Courier, monospace; }
    .expiry { font-size: 13px; color: #38bdf8; margin-top: 6px; font-weight: 600; }
    .notice { font-size: 13px; color: #94a3b8; line-height: 1.5; margin-top: 24px; padding: 12px 16px; background: rgba(15, 23, 42, 0.6); border-radius: 8px; border-left: 3px solid #00A878; text-align: left; }
    .footer { text-align: center; padding-top: 24px; border-top: 1px solid #1e293b; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo">Home<span>StepIn</span> Partner</div>
      <div><span class="tag">PARTNER PASSWORD RESET</span></div>
    </div>
    <div class="body">
      <p class="instruction">Your password reset verification code is:</p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
      </div>
      <div class="expiry">This code expires in ${expiresInMinutes} minutes.</div>
      <div class="notice">
        If you did not request this password reset code, please ignore this email or contact HomeStepIn support. Never share this code with anyone.
      </div>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} HomeStepIn Technologies. All rights reserved.
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Core dispatch engine for OTP via Resend (Customer & Worker).
 * @param {{ to: string, otp: string, purpose?: string }} params
 */
async function sendResendOtpEmail({ to, otp, purpose = 'verification' }) {
  if (!to || !to.includes('@')) {
    const err = new Error('Valid recipient email address is required.');
    err.code = 'INVALID_RECIPIENT';
    err.status = 400;
    throw err;
  }

  const cleanOtp = String(otp || '').trim();
  if (!/^\d{6}$/.test(cleanOtp)) {
    const err = new Error('Valid 6-digit numeric OTP is required.');
    err.code = 'INVALID_OTP';
    err.status = 400;
    throw err;
  }

  const normalizedEmail = to.trim().toLowerCase();
  const isWorkerReset = purpose === 'worker_password_reset';
  const subject = isWorkerReset
    ? 'Your HomeStepIn Partner password reset code'
    : 'Your HomeStepIn verification code';
  const html = isWorkerReset
    ? buildWorkerOtpEmailHtml({ otp: cleanOtp, expiresInMinutes: 5 })
    : buildCustomerOtpEmailHtml({ otp: cleanOtp, expiresInMinutes: 5 });
  const text = isWorkerReset
    ? `HomeStepIn Partner\n\nYour password reset code is:\n${cleanOtp}\n\nThis code expires in 5 minutes.\n\nIf you did not request this code, ignore this email.`
    : `HomeStepIn\n\nYour verification code is:\n${cleanOtp}\n\nThis code expires in 5 minutes.\n\nIf you did not request this code, ignore this email.`;

  // 1. In test environment, handle mock transport or test inbox
  if (process.env.NODE_ENV === 'test') {
    if (testTransport) {
      return testTransport.send({
        to: normalizedEmail,
        otp: cleanOtp,
        subject,
        html,
        text,
        purpose,
        provider: 'resend',
      });
    }

    const testRecord = {
      id: `resend_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      to: normalizedEmail,
      otp: cleanOtp,
      subject,
      purpose,
      timestamp: new Date(),
    };
    testInbox.push(testRecord);
    return { id: testRecord.id, provider: 'resend-test', status: 'delivered' };
  }

  // 2. Production / Staging delivery via official Resend SDK
  const resend = getResendClient();
  const fromEmail = (process.env.RESEND_FROM_EMAIL || config.resendFromEmail || 'HomeStepIn <onboarding@resend.dev>').trim();

  const response = await resend.emails.send({
    from: fromEmail,
    to: normalizedEmail,
    subject,
    html,
    text,
  });

  if (response.error) {
    const resendErr = response.error;
    const err = new Error(resendErr.message || 'Failed to dispatch email via Resend.');
    err.code = resendErr.name || 'RESEND_ERROR';
    err.status = resendErr.statusCode || 500;

    // Categorize common domain verification and access errors
    if (/domain.*not verified/i.test(resendErr.message)) {
      err.code = 'RESEND_DOMAIN_UNVERIFIED';
      err.status = 403;
    } else if (/restricted_api_key/i.test(resendErr.message) || resendErr.statusCode === 401) {
      err.code = 'RESEND_AUTH_FAILED';
      err.status = 401;
    } else if (resendErr.name === 'validation_error') {
      err.code = 'RESEND_VALIDATION_ERROR';
      err.status = 422;
    }

    throw err;
  }

  return {
    id: response.data?.id,
    provider: 'resend',
    status: 'accepted',
  };
}

/**
 * Dispatch Customer Registration Verification OTP via Resend.
 */
async function sendCustomerRegistrationOtp({ to, otp }) {
  return sendResendOtpEmail({ to, otp, purpose: 'customer_registration' });
}

/**
 * Dispatch Customer Password Reset OTP via Resend.
 */
async function sendCustomerPasswordResetOtp({ to, otp }) {
  return sendResendOtpEmail({ to, otp, purpose: 'customer_password_reset' });
}

/**
 * Dispatch Partner / Worker Password Reset OTP via Resend.
 */
async function sendWorkerPasswordResetOtp({ to, otp }) {
  return sendResendOtpEmail({ to, otp, purpose: 'worker_password_reset' });
}

module.exports = {
  getResendClient,
  validateResendConfig,
  buildCustomerOtpEmailHtml,
  buildWorkerOtpEmailHtml,
  sendResendOtpEmail,
  sendCustomerRegistrationOtp,
  sendCustomerPasswordResetOtp,
  sendWorkerPasswordResetOtp,
  setTestResendTransport,
  getLatestTestOtp,
  getTestInbox,
  clearTestInbox,
};
