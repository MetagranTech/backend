// Unit test for MongoDB URI sanitization and validation logic
const assert = require('assert');

function sanitizeMongoUri(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') return '';

  let uri = rawUri.trim();

  // Strip zero-width and invisible unicode characters
  uri = uri.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Strip leading variable assignment e.g. MONGODB_URI= or MONGO_URI=
  uri = uri.replace(/^(MONGODB_URI|MONGO_URI|DATABASE_URL)\s*=\s*/i, '').trim();

  // Strip wrapping quotes (single, double, smart quotes)
  while (
    (uri.startsWith('"') && uri.endsWith('"')) ||
    (uri.startsWith("'") && uri.endsWith("'")) ||
    (uri.startsWith('“') && uri.endsWith('”')) ||
    (uri.startsWith('‘') && uri.endsWith('’'))
  ) {
    uri = uri.slice(1, -1).trim();
  }

  // Also remove stray leading/trailing quotes if only on one side
  uri = uri.replace(/^['"]+|['"]+$/g, '').trim();

  return uri;
}

function isValidMongoScheme(uri) {
  if (!uri || typeof uri !== 'string') return false;
  return /^mongodb(\+srv)?:\/\//i.test(uri);
}

function getSafeUriDiagnostics(rawUri, sanitizedUri) {
  const rawPrefix = (rawUri || '').substring(0, 15);
  const rawLength = (rawUri || '').length;
  const sanitizedLength = (sanitizedUri || '').length;
  const validScheme = isValidMongoScheme(sanitizedUri);

  // Extract scheme
  const schemeMatch = sanitizedUri.match(/^mongodb(\+srv)?:\/\//i);
  const scheme = schemeMatch ? schemeMatch[0] : 'none';

  // Mask credentials safely
  let masked = 'none';
  let host = 'unknown';
  let dbName = 'unknown';

  if (validScheme) {
    try {
      // Use regex to mask user/pass without relying on URL parser which might fail on complex query params
      masked = sanitizedUri.replace(/^(mongodb(?:\+srv)?:\/\/)([^:@]+):([^@]+)@/i, '$1***:***@');

      // Extract host and db
      const withoutScheme = sanitizedUri.replace(/^mongodb(?:\+srv)?:\/\//i, '');
      const hostPart = withoutScheme.split('/')[0].split('@').pop() || '';
      host = hostPart.split('?')[0];

      const afterSlash = withoutScheme.split('/')[1];
      if (afterSlash) {
        dbName = afterSlash.split('?')[0] || '';
      }
    } catch {
      masked = '[masking error]';
    }
  }

  return {
    rawLength,
    sanitizedLength,
    validScheme,
    scheme,
    host,
    dbName,
    maskedUri: masked,
    rawPrefixFirst12: rawPrefix.substring(0, 12),
  };
}

// ── Test Cases ──
const testCases = [
  {
    name: 'Normal SRV URI',
    input: 'mongodb+srv://dummyUser:dummyPassword@dummy-cluster.abcde.mongodb.net/homestepin?retryWrites=true&w=majority',
    expectedScheme: true,
  },
  {
    name: 'Double-quoted SRV URI',
    input: '"mongodb+srv://dummyUser:dummyPassword@dummy-cluster.abcde.mongodb.net/homestepin?retryWrites=true&w=majority"',
    expectedScheme: true,
  },
  {
    name: 'Single-quoted SRV URI with leading space',
    input: "  'mongodb+srv://dummyUser:dummyPassword@dummy-cluster.abcde.mongodb.net/homestepin?retryWrites=true&w=majority'  ",
    expectedScheme: true,
  },
  {
    name: 'Pasted with MONGODB_URI= prefix',
    input: 'MONGODB_URI="mongodb+srv://dummyUser:dummyPassword@dummy-cluster.abcde.mongodb.net/homestepin?retryWrites=true&w=majority"',
    expectedScheme: true,
  },
  {
    name: 'Pasted with MONGO_URI= prefix and spaces',
    input: '  MONGO_URI = mongodb+srv://dummyUser:dummyPassword@dummy-cluster.abcde.mongodb.net/homestepin  ',
    expectedScheme: true,
  },
  {
    name: 'Standard local URI with quotes and newline',
    input: '"mongodb://127.0.0.1:27017/homestepin"\r\n',
    expectedScheme: true,
  },
  {
    name: 'Invalid scheme (missing mongodb://)',
    input: 'dummy-cluster.abcde.mongodb.net/homestepin',
    expectedScheme: false,
  },
  {
    name: 'Invalid scheme (http://)',
    input: 'http://localhost:27017/homestepin',
    expectedScheme: false,
  },
];

console.log('Running URI sanitization and diagnostic tests:');
let passed = 0;
for (const tc of testCases) {
  const cleaned = sanitizeMongoUri(tc.input);
  const isValid = isValidMongoScheme(cleaned);
  const diag = getSafeUriDiagnostics(tc.input, cleaned);

  assert.strictEqual(isValid, tc.expectedScheme, `Failed for case: ${tc.name}`);
  if (tc.expectedScheme) {
    assert(cleaned.startsWith('mongodb://') || cleaned.startsWith('mongodb+srv://'), `Cleaned must start with valid scheme: ${cleaned}`);
    assert(!cleaned.includes('"') && !cleaned.includes("'"), `Quotes must be removed: ${cleaned}`);
    assert(!diag.maskedUri.includes('dummyPassword'), `Password must NEVER be logged: ${diag.maskedUri}`);
  }
  console.log(`  [PASS] ${tc.name} -> scheme: ${diag.scheme}, host: ${diag.host}, masked: ${diag.maskedUri}`);
  passed++;
}

console.log(`\nAll ${passed}/${testCases.length} tests passed successfully!`);
