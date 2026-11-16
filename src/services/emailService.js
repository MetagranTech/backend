const dns = require('dns');
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

const nodemailer = require('nodemailer');
const config = require('../config');

let testEmailTransport = null;
const testInbox = [];
let smtpTransporterInstance = null;

/**
 * Asserts that the current environment is strictly NODE_ENV === 'test'.
 * Throws a security violation error otherwise.
 */
function assertTestEnvironment(hookName) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `[Security Violation] Test email hook "${hookName}" is strictly forbidden outside of NODE_ENV === 'test' (current: ${process.env.NODE_ENV})`
    );
  }
}

/**
 * Asserts that no test transports or mock inboxes are active when running in production.
 * Must fail startup if violated.
 */
function assertProductionSafety() {
  if (process.env.NODE_ENV === 'production') {
    if (testEmailTransport !== null || testInbox.length > 0) {
      throw new Error('[Fatal Security Error] Test email provider or mock state detected in production environment');
    }
  }
}

// Enforce fail-fast check at module load time
if (process.env.NODE_ENV === 'production') {
  assertProductionSafety();
}

/**
 * Configure a test transport hook for automated testing.
 * Strictly gated to NODE_ENV === 'test'.
 * @param {Function|null} transport - Custom delivery handler or null to reset.
 */
function setTestEmailTransport(transport) {
  assertTestEnvironment('setTestEmailTransport');
  testEmailTransport = transport;
}

/**
 * Retrieve the latest OTP sent to a specific email address from the in-memory test inbox.
 * Strictly gated to NODE_ENV === 'test'.
 * @param {string} email
 * @returns {string|null}
 */
function getLatestTestOtp(email) {
  assertTestEnvironment('getLatestTestOtp');
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
 * Inspect test inbox contents.
 * Strictly gated to NODE_ENV === 'test'.
 * @returns {Array}
 */
function getTestInbox() {
  assertTestEnvironment('getTestInbox');
  return [...testInbox];
}

/**
 * Clear test inbox.
 * Strictly gated to NODE_ENV === 'test'.
 */
function clearTestInbox() {
  assertTestEnvironment('clearTestInbox');
  testInbox.length = 0;
}

/**
 * Reset cached SMTP transporter (used for testing credentials switching).
 */
function resetSmtpTransporter() {
  if (smtpTransporterInstance) {
    try {
      smtpTransporterInstance.close();
    } catch (_) {}
    smtpTransporterInstance = null;
  }
}

/**
 * Mask an email address for safe responses & logs (e.g. j***e@example.com).
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const [local, domain] = email.trim().toLowerCase().split('@');
  if (!domain) return email;
  if (local.length <= 2) {
    return `${local[0]}*@${domain}`;
  }
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 4))}${local[local.length - 1]}@${domain}`;
}

/**
 * Branded HTML email generator for HomeStepIn OTPs.
 */
function buildOtpEmailHtml({ otp, purposeLabel, expiresInMinutes = 5 }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your HomeStepIn Verification Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b1513; color: #f0fdf4; margin: 0; padding: 24px; }
    .card { max-width: 480px; margin: 0 auto; background-color: #12231f; border-radius: 16px; border: 1px solid #1e3a34; padding: 32px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
    .header { text-align: center; padding-bottom: 24px; border-bottom: 1px solid #1e3a34; }
    .logo { display: inline-block; font-size: 24px; font-weight: 800; color: #10b981; letter-spacing: -0.5px; text-decoration: none; }
    .tag { display: inline-block; background: #064e3b; color: #6ee7b7; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; margin-top: 8px; }
    .body { padding: 24px 0; text-align: center; }
    .instruction { font-size: 15px; color: #cbd5e1; line-height: 1.5; margin: 0 0 20px 0; }
    .otp-box { background: #071712; border: 2px dashed #10b981; border-radius: 12px; padding: 18px 24px; display: inline-block; margin: 8px auto 20px auto; }
    .otp-code { font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #34d399; font-family: 'Courier New', Courier, monospace; }
    .expiry { font-size: 13px; color: #94a3b8; margin-top: 4px; }
    .warning { background: #1f2937; border-left: 4px solid #f59e0b; padding: 12px 16px; text-align: left; border-radius: 4px; font-size: 12px; color: #d1d5db; margin-top: 20px; line-height: 1.4; }
    .footer { text-align: center; padding-top: 24px; border-top: 1px solid #1e3a34; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo">HomeStepIn</div>
      <div><span class="tag">${purposeLabel}</span></div>
    </div>
    <div class="body">
      <p class="instruction">Use the verification code below to complete your authentication request:</p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
      </div>
      <div class="expiry">Expires in ${expiresInMinutes} minutes.</div>
      <div class="warning">
        <strong>Security Notice:</strong> Never share this verification code with anyone. HomeStepIn support staff will never ask for your code. If you did not request this, you can safely ignore this email.
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
 * Evaluate email delivery configuration based on environment settings.
 * Validates whether the active provider (Brevo API or Brevo SMTP) is properly configured.
 * @returns {Object} { isConfigured, isEligible, senderAddress, provider, reason, code }
 */
function getEmailDeliveryEligibility(email = '') {
  if (process.env.NODE_ENV === 'test') {
    return {
      isConfigured: true,
      isEligible: true,
      senderAddress: (config.emailFrom || 'test@homestepin.local').trim(),
      provider: 'in-memory-test',
      code: null,
      reason: null,
    };
  }

  const provider = (config.emailProvider || 'api').trim().toLowerCase();
  const senderEmail = (config.emailFrom || '').trim();

  const hasSender = Boolean(senderEmail && !senderEmail.startsWith('your_') && senderEmail.includes('@'));
  const hasApiConfig = Boolean(
    config.brevoApiKey &&
    !config.brevoApiKey.startsWith('your_') &&
    !config.brevoApiKey.startsWith('mock_')
  );
  const hasSmtpConfig = Boolean(
    config.brevoSmtpLogin &&
    !config.brevoSmtpLogin.startsWith('your_') &&
    config.brevoSmtpKey &&
    !config.brevoSmtpKey.startsWith('your_')
  );

  const isConfigured = provider === 'smtp' ? (hasSmtpConfig && hasSender) : (hasApiConfig && hasSender);

  if (!isConfigured) {
    const missing = provider === 'smtp' ? 'BREVO_SMTP_LOGIN/BREVO_SMTP_KEY' : 'BREVO_API_KEY';
    return {
      isConfigured: false,
      isEligible: false,
      senderAddress: senderEmail,
      provider,
      code: 'EMAIL_NOT_CONFIGURED',
      reason: `Email delivery is not configured. Valid ${missing} and EMAIL_FROM are required.`,
    };
  }

  return {
    isConfigured: true,
    isEligible: true,
    senderAddress: senderEmail,
    provider,
    code: null,
    reason: null,
  };
}

/**
 * Deliver transactional email using Brevo API (POST https://api.brevo.com/v3/smtp/email).
 */
async function sendViaBrevoApi({ to, subject, html, text }) {
  if (!config.brevoApiKey || config.brevoApiKey.startsWith('your_')) {
    const err = new Error('Brevo API key is not configured. Please set BREVO_API_KEY in backend/.env');
    err.code = 'EMAIL_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const senderEmail = (config.emailFrom || '').trim();
  const senderName = (config.emailFromName || 'HomeStepIn').trim();

  if (!senderEmail || senderEmail.startsWith('your_') || !senderEmail.includes('@')) {
    const err = new Error('Valid sender email is required. Please set EMAIL_FROM in backend/.env');
    err.code = 'INVALID_SENDER_EMAIL';
    err.status = 503;
    throw err;
  }

  const payload = {
    sender: { name: senderName, email: senderEmail },
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': config.brevoApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (netErr) {
    clearTimeout(timeoutId);
    if (netErr.name === 'AbortError') {
      const err = new Error('Brevo API request timed out.');
      err.code = 'EMAIL_TIMEOUT';
      err.status = 504;
      throw err;
    }
    const err = new Error(`Brevo API network connection failure: ${netErr.message}`);
    err.code = 'EMAIL_DELIVERY_FAILED';
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data.message || `Brevo API returned status ${response.status}`;
    if (response.status === 401 || data.code === 'unauthorized') {
      const isIpRestriction = errorMsg.includes('unrecognised IP') || errorMsg.includes('authorised_ips');
      const ipMatch = errorMsg.match(/(?:unrecognised IP address\s+)([a-fA-F0-9:.]+)/);
      const detectedIp = ipMatch ? ipMatch[1].replace(/[.,;:]+$/, '') : '';

      const message = isIpRestriction
        ? `Brevo API rejected email: Server IP (${detectedIp || 'current IP'}) is not authorised in your Brevo account. Please whitelist it at https://app.brevo.com/security/authorised_ips`
        : `Brevo API authentication failed: ${errorMsg}`;

      console.warn(`[Brevo API Auth Error] ${message}`);
      const err = new Error(message);
      err.code = isIpRestriction ? 'BREVO_IP_UNAUTHORIZED' : 'EMAIL_NOT_CONFIGURED';
      err.status = 503;
      err.unauthorisedIp = detectedIp;
      err.whitelistUrl = 'https://app.brevo.com/security/authorised_ips';
      throw err;
    }
    if (response.status === 400 || data.code === 'invalid_parameter') {
      console.warn(`[Brevo API Validation Error] ${errorMsg}`);
      const err = new Error(`Brevo invalid parameter or recipient: ${errorMsg}`);
      err.code = 'INVALID_RECIPIENT';
      err.status = 400;
      throw err;
    }
    if (response.status === 429) {
      console.warn(`[Brevo API Rate Limited] ${errorMsg}`);
      const err = new Error('Brevo API rate limit reached. Please try again shortly.');
      err.code = 'EMAIL_RATE_LIMITED';
      err.status = 429;
      throw err;
    }
    console.error(`[Brevo API Error ${response.status}] ${errorMsg}`);
    const err = new Error(`Brevo API email delivery failed: ${errorMsg}`);
    err.code = 'EMAIL_DELIVERY_FAILED';
    err.status = response.status >= 500 ? 502 : response.status;
    throw err;
  }

  return {
    accepted: true,
    provider: 'brevo-api',
    id: data.messageId || `brevo_api_${Date.now()}`,
    recipient: to,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build or retrieve cached Nodemailer SMTP transporter.
 */
function getSmtpTransporter() {
  if (!smtpTransporterInstance) {
    if (
      !config.brevoSmtpLogin ||
      config.brevoSmtpLogin.startsWith('your_') ||
      !config.brevoSmtpKey ||
      config.brevoSmtpKey.startsWith('your_')
    ) {
      const err = new Error('Brevo SMTP credentials not configured. Please set BREVO_SMTP_LOGIN and BREVO_SMTP_KEY.');
      err.code = 'EMAIL_NOT_CONFIGURED';
      err.status = 503;
      throw err;
    }

    smtpTransporterInstance = nodemailer.createTransport({
      host: config.brevoSmtpHost || 'smtp-relay.brevo.com',
      port: config.brevoSmtpPort || 587,
      secure: config.brevoSmtpSecure || false,
      auth: {
        user: config.brevoSmtpLogin,
        pass: config.brevoSmtpKey,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });
  }
  return smtpTransporterInstance;
}

/**
 * Deliver transactional email using Brevo SMTP.
 */
async function sendViaBrevoSmtp({ to, subject, html, text }) {
  if (
    !config.brevoSmtpLogin ||
    config.brevoSmtpLogin.startsWith('your_') ||
    !config.brevoSmtpKey ||
    config.brevoSmtpKey.startsWith('your_')
  ) {
    const err = new Error('Brevo SMTP credentials missing. Please configure BREVO_SMTP_LOGIN and BREVO_SMTP_KEY.');
    err.code = 'EMAIL_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const senderEmail = (config.emailFrom || '').trim();
  const senderName = (config.emailFromName || 'HomeStepIn').trim();

  if (!senderEmail || senderEmail.startsWith('your_') || !senderEmail.includes('@')) {
    const err = new Error('Valid sender email is required. Please set EMAIL_FROM in backend/.env');
    err.code = 'INVALID_SENDER_EMAIL';
    err.status = 503;
    throw err;
  }

  const transporter = getSmtpTransporter();

  try {
    const info = await transporter.sendMail({
      from: `"${senderName}" <${senderEmail}>`,
      to,
      subject,
      html,
      text,
    });

    return {
      accepted: true,
      provider: 'brevo-smtp',
      id: info.messageId || `brevo_smtp_${Date.now()}`,
      recipient: to,
      timestamp: new Date().toISOString(),
    };
  } catch (smtpErr) {
    const errorMsg = smtpErr.message || '';
    if (smtpErr.responseCode === 525 || errorMsg.includes('Unauthorized IP') || errorMsg.includes('525')) {
      const message = `Brevo SMTP rejected request: IP address is not authorised. Whitelist your IP at https://app.brevo.com/security/authorised_ips`;
      console.warn(`[Brevo SMTP IP Error] ${message}`);
      const err = new Error(message);
      err.code = 'BREVO_IP_UNAUTHORIZED';
      err.status = 503;
      throw err;
    }
    if (smtpErr.responseCode === 535 || errorMsg.includes('auth') || errorMsg.includes('Invalid login') || errorMsg.includes('Username and Password not accepted')) {
      console.warn(`[Brevo SMTP Auth Error] Credentials rejected: ${errorMsg}`);
      const err = new Error('Brevo SMTP authentication failed. Please check BREVO_SMTP_LOGIN and BREVO_SMTP_KEY.');
      err.code = 'EMAIL_NOT_CONFIGURED';
      err.status = 503;
      throw err;
    }
    console.error(`[Brevo SMTP Error] ${errorMsg}`);
    const err = new Error(`Brevo SMTP delivery failed: ${errorMsg}`);
    err.code = 'EMAIL_DELIVERY_FAILED';
    err.status = 502;
    throw err;
  }
}

/**
 * Core dispatch function.
 * Evaluates configured provider (api or smtp), applies optional fallback, and records receipt.
 */
async function dispatchEmail({ to, subject, html, text, otp = null, purpose = null }) {
  const normalizedEmail = (to || '').trim().toLowerCase();

  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    const err = new Error('Invalid recipient email address.');
    err.code = 'INVALID_RECIPIENT';
    err.status = 400;
    throw err;
  }

  // 1. In test environment, deliver to in-memory fake email provider or test transport
  if (process.env.NODE_ENV === 'test') {
    if (testEmailTransport) {
      return testEmailTransport.send({
        from: config.emailFrom,
        to: normalizedEmail,
        subject,
        html,
        text,
        otp,
        purpose,
      });
    }

    const testRecord = {
      id: `test_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      to: normalizedEmail,
      otp,
      purpose,
      subject,
      text,
      html,
      timestamp: new Date().toISOString(),
    };
    testInbox.push(testRecord);
    return {
      accepted: true,
      provider: 'in-memory-test',
      id: testRecord.id,
      recipient: normalizedEmail,
      timestamp: testRecord.timestamp,
    };
  }

  // 2. Pre-check: Verify eligibility
  const eligibility = getEmailDeliveryEligibility(normalizedEmail);
  if (!eligibility.isConfigured) {
    console.warn(`[EmailService Pre-check] Delivery to ${maskEmail(normalizedEmail)} prevented: ${eligibility.reason}`);
    const err = new Error(eligibility.reason);
    err.code = eligibility.code || 'EMAIL_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const primaryProvider = (config.emailProvider || 'api').trim().toLowerCase();
  const fallbackProvider = (config.emailFallbackProvider || 'none').trim().toLowerCase();

  const sendWithProvider = (provider) => {
    if (provider === 'smtp') {
      return sendViaBrevoSmtp({ to: normalizedEmail, subject, html, text });
    }
    return sendViaBrevoApi({ to: normalizedEmail, subject, html, text });
  };

  console.log(`[EmailService Diagnostic] Outbound email attempt: provider=${primaryProvider}, recipient=${maskEmail(normalizedEmail)}, purpose=${purpose || 'general'}, timestamp=${new Date().toISOString()}`);

  try {
    const result = await sendWithProvider(primaryProvider);
    console.log(`[EmailService Diagnostic Success] Outbound email delivered: provider=${primaryProvider}, recipient=${maskEmail(normalizedEmail)}, id=${result.id}`);
    console.log(`[Brevo Accepted] Delivered via ${primaryProvider} to ${maskEmail(normalizedEmail)} [ID: ${result.id}]`);
    return result;
  } catch (primaryErr) {
    console.warn(`[EmailService Diagnostic Error] Outbound email failed: provider=${primaryProvider}, recipient=${maskEmail(normalizedEmail)}, status=${primaryErr.status || 500}, code=${primaryErr.code || 'UNKNOWN'}, message=${primaryErr.message}`);
    // If fallback is disabled ('none') or identical to primary, throw immediately
    if (fallbackProvider === 'none' || fallbackProvider === primaryProvider) {
      throw primaryErr;
    }

    // Safeguard: Never fallback if the failure was an ambiguous timeout,
    // to strictly prevent sending duplicate emails to the customer!
    if (primaryErr.code === 'EMAIL_TIMEOUT') {
      console.warn(`[EmailService] Ambiguous timeout on primary provider ${primaryProvider}. Skipping fallback to prevent duplicate email.`);
      throw primaryErr;
    }

    // Do not fallback on client errors
    if (primaryErr.code === 'INVALID_RECIPIENT' || primaryErr.code === 'INVALID_SENDER_EMAIL') {
      throw primaryErr;
    }

    console.warn(`[EmailService] Primary provider ${primaryProvider} failed (${primaryErr.message}). Attempting fallback to ${fallbackProvider}...`);
    try {
      const fallbackResult = await sendWithProvider(fallbackProvider);
      console.log(`[Brevo Accepted Fallback] Delivered via ${fallbackProvider} to ${maskEmail(normalizedEmail)} [ID: ${fallbackResult.id}]`);
      return fallbackResult;
    } catch (fallbackErr) {
      console.error(`[EmailService] Fallback provider ${fallbackProvider} also failed:`, fallbackErr.message);
      throw primaryErr;
    }
  }
}

/**
 * Dispatch OTP verification email.
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.otp - 6-digit OTP code
 * @param {string} options.purpose - 'signup_verification' | 'login_2fa'
 */
async function sendOtpEmail({ to, otp, purpose }) {
  const purposeLabel = purpose === 'signup_verification' ? 'Email Verification' : 'Two-Factor Authentication';
  const subject = purpose === 'signup_verification'
    ? `${otp} is your HomeStepIn verification code`
    : `${otp} is your HomeStepIn sign-in security code`;

  const html = buildOtpEmailHtml({ otp, purposeLabel, expiresInMinutes: 5 });
  const text = `Your HomeStepIn ${purposeLabel} code is: ${otp}\n\nThis code expires in 5 minutes. Do not share this code with anyone.`;

  return dispatchEmail({ to, subject, html, text, otp, purpose });
}

/**
 * Dispatch password reset email.
 */
async function sendPasswordResetEmail({ to, otp, expiresInMinutes = 10 }) {
  const subject = `${otp} is your HomeStepIn password reset code`;
  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; background: #0b1513; color: #f0fdf4; padding: 24px;">
  <div style="max-width: 480px; margin: auto; background: #12231f; border-radius: 12px; padding: 32px; border: 1px solid #1e3a34;">
    <h2 style="color: #10b981; margin-top: 0;">Password Reset Request</h2>
    <p style="color: #cbd5e1;">Use the verification code below to reset your password:</p>
    <div style="background: #071712; border: 2px dashed #10b981; padding: 16px; text-align: center; border-radius: 8px; margin: 20px 0;">
      <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #34d399; font-family: monospace;">${otp}</span>
    </div>
    <p style="color: #94a3b8; font-size: 13px;">This code expires in ${expiresInMinutes} minutes.</p>
    <p style="color: #64748b; font-size: 12px; border-top: 1px solid #1e3a34; padding-top: 16px;">If you did not request a password reset, you can safely ignore this email.</p>
  </div>
</body>
</html>`.trim();
  const text = `Your HomeStepIn password reset code is: ${otp}. It expires in ${expiresInMinutes} minutes. If you did not request this, please ignore this email.`;

  return dispatchEmail({ to, subject, html, text, otp, purpose: 'password_reset' });
}

/**
 * Dispatch Admin invitation email.
 */
async function sendAdminInvitationEmail({ to, inviteUrl, role = 'BASIC_ADMIN', invitedBy = 'Super Admin', tempPassword = null }) {
  const subject = `You've been invited to join HomeStepIn Admin (${role})`;
  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; background: #0b1513; color: #f0fdf4; padding: 24px;">
  <div style="max-width: 500px; margin: auto; background: #12231f; border-radius: 12px; padding: 32px; border: 1px solid #1e3a34;">
    <h2 style="color: #10b981; margin-top: 0;">Admin Account Invitation</h2>
    <p style="color: #cbd5e1;">You have been invited by <strong>${invitedBy}</strong> to join the HomeStepIn team with the role of <strong>${role}</strong>.</p>
    ${tempPassword ? `<p style="color: #cbd5e1;">Your temporary password: <code style="background: #071712; padding: 4px 8px; border-radius: 4px; color: #34d399;">${tempPassword}</code></p>` : ''}
    <div style="text-align: center; margin: 24px 0;">
      <a href="${inviteUrl}" style="background: #10b981; color: #042f2e; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: inline-block;">Access Admin Dashboard</a>
    </div>
    <p style="color: #64748b; font-size: 12px; border-top: 1px solid #1e3a34; padding-top: 16px;">HomeStepIn Technologies</p>
  </div>
</body>
</html>`.trim();
  const text = `You've been invited by ${invitedBy} to join HomeStepIn Admin as ${role}.\n\nAccess dashboard: ${inviteUrl}${tempPassword ? `\nTemporary Password: ${tempPassword}` : ''}`;

  return dispatchEmail({ to, subject, html, text, purpose: 'admin_invitation' });
}

/**
 * Dispatch booking confirmation email.
 */
async function sendBookingConfirmationEmail({ to, booking }) {
  const bookingId = booking.customId || booking._id || 'BK-NEW';
  const serviceName = booking.service || booking.serviceName || 'Home Service';
  const scheduledDate = booking.date || 'Scheduled Date';
  const subject = `Booking Confirmed: ${serviceName} (#${bookingId})`;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; background: #0b1513; color: #f0fdf4; padding: 24px;">
  <div style="max-width: 500px; margin: auto; background: #12231f; border-radius: 12px; padding: 32px; border: 1px solid #1e3a34;">
    <h2 style="color: #10b981; margin-top: 0;">Booking Confirmed!</h2>
    <p style="color: #cbd5e1;">Thank you for booking with HomeStepIn. Your booking details:</p>
    <div style="background: #071712; padding: 16px; border-radius: 8px; margin: 16px 0; border: 1px solid #1e3a34;">
      <p style="margin: 4px 0; color: #cbd5e1;"><strong>Booking ID:</strong> ${bookingId}</p>
      <p style="margin: 4px 0; color: #cbd5e1;"><strong>Service:</strong> ${serviceName}</p>
      <p style="margin: 4px 0; color: #cbd5e1;"><strong>Scheduled:</strong> ${scheduledDate}</p>
      <p style="margin: 4px 0; color: #34d399;"><strong>Status:</strong> CONFIRMED</p>
    </div>
    <p style="color: #94a3b8; font-size: 13px;">Our verified professional will arrive at your address on time.</p>
  </div>
</body>
</html>`.trim();
  const text = `Your booking for ${serviceName} (#${bookingId}) is confirmed for ${scheduledDate}.`;

  return dispatchEmail({ to, subject, html, text, purpose: 'booking_confirmation' });
}

/**
 * Dispatch booking status update email.
 */
async function sendBookingStatusEmail({ to, booking, status }) {
  const bookingId = booking.customId || booking._id || 'BK';
  const serviceName = booking.service || booking.serviceName || 'Home Service';
  const subject = `Booking Update: ${serviceName} (#${bookingId}) is ${status}`;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; background: #0b1513; color: #f0fdf4; padding: 24px;">
  <div style="max-width: 500px; margin: auto; background: #12231f; border-radius: 12px; padding: 32px; border: 1px solid #1e3a34;">
    <h2 style="color: #10b981; margin-top: 0;">Booking Status Update</h2>
    <p style="color: #cbd5e1;">Your booking <strong>#${bookingId}</strong> (${serviceName}) status has been updated to: <strong style="color: #34d399;">${status}</strong>.</p>
  </div>
</body>
</html>`.trim();
  const text = `Booking #${bookingId} (${serviceName}) status update: ${status}.`;

  return dispatchEmail({ to, subject, html, text, purpose: 'booking_status_update' });
}

/**
 * Dispatch payment notification email.
 */
async function sendPaymentNotificationEmail({ to, payment, booking }) {
  const amount = payment.amount ? `₹${payment.amount}` : 'Paid';
  const paymentId = payment.paymentId || payment.orderId || 'PAY-REF';
  const subject = `Payment Received: ${amount} for HomeStepIn Service`;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; background: #0b1513; color: #f0fdf4; padding: 24px;">
  <div style="max-width: 500px; margin: auto; background: #12231f; border-radius: 12px; padding: 32px; border: 1px solid #1e3a34;">
    <h2 style="color: #10b981; margin-top: 0;">Payment Successful</h2>
    <p style="color: #cbd5e1;">We have received your payment of <strong style="color: #34d399;">${amount}</strong>.</p>
    <p style="color: #94a3b8; font-size: 13px;">Transaction Reference: ${paymentId}</p>
  </div>
</body>
</html>`.trim();
  const text = `Payment of ${amount} received successfully for HomeStepIn. Reference: ${paymentId}.`;

  return dispatchEmail({ to, subject, html, text, purpose: 'payment_notification' });
}

/**
 * Generic transactional email dispatcher.
 */
async function sendEmail({ to, subject, html, text }) {
  return dispatchEmail({ to, subject, html, text, purpose: 'transactional' });
}

module.exports = {
  sendOtpEmail,
  sendPasswordResetEmail,
  sendAdminInvitationEmail,
  sendBookingConfirmationEmail,
  sendBookingStatusEmail,
  sendPaymentNotificationEmail,
  sendEmail,
  getEmailDeliveryEligibility,
  sendViaBrevoApi,
  sendViaBrevoSmtp,
  resetSmtpTransporter,
  setTestEmailTransport,
  getLatestTestOtp,
  getTestInbox,
  clearTestInbox,
  assertProductionSafety,
  maskEmail,
  buildOtpEmailHtml,
};
