const fs = require('fs');
require('dotenv').config({ path: 'backend/.env' });

console.log('=== EXTERNAL INTEGRATIONS CONFIGURATION AUDIT ===');

// 1. Razorpay
const rzpKey = process.env.RAZORPAY_KEY_ID || '';
console.log('Razorpay Key configured:', !!rzpKey);
console.log('Razorpay Mode:', rzpKey.startsWith('rzp_test_') ? 'TEST GATEWAY (SAFE)' : (rzpKey.startsWith('rzp_live_') ? 'LIVE PRODUCTION (MONEY AT RISK)' : 'UNKNOWN / MOCK'));
console.log('Razorpay Webhook Secret configured:', !!process.env.PAYMENT_WEBHOOK_SECRET);

// 2. Cloudinary
console.log('Cloudinary Cloud Name:', process.env.CLOUDINARY_CLOUD_NAME || 'NOT SET');
console.log('Cloudinary API Key configured:', !!process.env.CLOUDINARY_API_KEY);
console.log('Cloudinary Secret configured:', !!process.env.CLOUDINARY_API_SECRET);

// 3. Email Providers (Resend & Brevo)
console.log('Primary Email Provider:', process.env.EMAIL_PROVIDER || 'resend');
console.log('Fallback Email Provider:', process.env.EMAIL_FALLBACK_PROVIDER || 'brevo');
console.log('Resend API Key configured:', !!process.env.RESEND_API_KEY);
console.log('Resend From Email:', process.env.RESEND_FROM_EMAIL || 'NOT SET');
console.log('Brevo API Key configured:', !!process.env.BREVO_API_KEY);

// 4. Mappls (MapmyIndia)
console.log('Mappls Client ID configured:', !!process.env.MAPPLS_CLIENT_ID);
console.log('Mappls Client Secret configured:', !!process.env.MAPPLS_CLIENT_SECRET);
console.log('Mappls API Key configured:', !!process.env.MAPPLS_API_KEY);

// 5. Firebase
console.log('Firebase Project ID:', process.env.FIREBASE_PROJECT_ID || 'NOT SET');
console.log('Firebase Client Email configured:', !!process.env.FIREBASE_CLIENT_EMAIL);
console.log('Firebase Private Key configured:', !!process.env.FIREBASE_PRIVATE_KEY);

// 6. Database URI check
const uri = process.env.MONGODB_URI || '';
console.log('Configured MONGODB_URI type:', uri.includes('mongodb+srv') ? 'MongoDB Atlas Cluster (Remote Cloud)' : 'Local / Custom');
const isAtlas = uri.includes('mongodb.net');
console.log('Is MongoDB Atlas Cloud:', isAtlas);
