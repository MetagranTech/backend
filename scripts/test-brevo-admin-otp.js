/**
 * Verification Script: Test Brevo Live Delivery for Admin OTP
 *
 * Runs an actual live test against Brevo API with the configured credentials.
 */

require('dotenv').config();
const { sendOtpEmail } = require('../src/services/emailService');

async function testAdminOtp() {
  const targetEmail = process.env.INITIAL_SUPERADMIN_1_EMAIL || 'fazil@homestepin.com';
  console.log('======================================================');
  console.log('  HOMESTEPIN — LIVE BREVO ADMIN OTP VERIFICATION');
  console.log('======================================================\n');
  console.log(`Target Admin Recipient : ${targetEmail}`);
  console.log(`Configured Provider    : ${process.env.EMAIL_PROVIDER || 'api'}`);
  console.log(`Sender Address         : ${process.env.EMAIL_FROM || 'support@homestepin.com'}`);
  console.log(`Brevo API Key Present  : ${Boolean(process.env.BREVO_API_KEY && !process.env.BREVO_API_KEY.startsWith('your_'))}`);
  console.log('\nDispatching live 2FA OTP verification email via Brevo API...');

  try {
    const testCode = String(Math.floor(100000 + Math.random() * 900000));
    const result = await sendOtpEmail({
      to: targetEmail,
      otp: testCode,
      purpose: 'login_2fa',
    });

    console.log('\n[SUCCESS] Live Brevo email dispatched successfully!');
    console.log(`Provider   : ${result.provider}`);
    console.log(`Message ID : ${result.id}`);
    console.log(`Recipient  : ${result.recipient}`);
    console.log(`Timestamp  : ${result.timestamp}`);
    console.log(`\nPlease check the inbox of ${targetEmail} for verification code: ${testCode}\n`);
    process.exit(0);
  } catch (err) {
    console.error('\n[DELIVERY BLOCKED / FAILED]');
    console.error(`Status : ${err.status || 500}`);
    console.error(`Code   : ${err.code || 'EMAIL_DELIVERY_FAILED'}`);
    console.error(`Error  : ${err.message}`);
    if (err.unauthorisedIp) {
      console.log(`\nUnauthorised IP detected: ${err.unauthorisedIp}`);
      console.log(`Whitelist link: ${err.whitelistUrl || 'https://app.brevo.com/security/authorised_ips'}`);
    }
    process.exit(1);
  }
}

testAdminOtp();

