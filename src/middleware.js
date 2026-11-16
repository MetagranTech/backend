const rateLimit = require('express-rate-limit');
const { verifyAccess } = require('./authTokens');
const User = require('./models/User');
const { HttpError } = require('./httpError');

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'UNAUTHORIZED', 'Session expired.'));
  let payload;
  try {
    payload = verifyAccess(token);
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      return next(new HttpError(401, 'TOKEN_EXPIRED', 'Session expired. Please log in again.'));
    }
    return next(new HttpError(401, 'INVALID_TOKEN', 'Session expired or invalid token.'));
  }

  const userId = payload.sub || payload.id;
  if (!userId) {
    return next(new HttpError(401, 'ACCOUNT_NOT_FOUND', 'Your account no longer exists. Please log in again.'));
  }

  try {
    const conditions = [];
    if (/^[0-9a-fA-F]{24}$/.test(userId)) {
      conditions.push({ _id: userId });
    }
    conditions.push({ customId: userId });
    const user = await User.findOne({ $or: conditions }).select('_id customId role status email isSystemSuperAdmin adminRole name');
    if (!user) {
      return next(new HttpError(401, 'ACCOUNT_NOT_FOUND', 'Your account no longer exists. Please log in again.'));
    }

    if (user.status === 'disabled' || user.status === 'suspended') {
      return next(new HttpError(401, 'ACCOUNT_BLOCKED', 'Account has been deactivated or suspended.'));
    }

    req.auth = { id: String(user._id), role: user.role, sub: String(user._id) };
    req.authUser = user;
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHORIZED', 'Session expired.'));
    if (!roles.includes(req.auth.role)) {
      return next(new HttpError(403, 'FORBIDDEN', 'You do not have access to this.'));
    }
    next();
  };
}

async function loadUser(req, res, next) {
  try {
    const user = await User.findById(req.auth.id);
    if (!user) return next(new HttpError(401, 'UNAUTHORIZED', 'Session expired.'));
    if (user.status === 'disabled' || user.status === 'suspended') {
      return next(new HttpError(403, 'ACCOUNT_DISABLED', 'Account disabled.'));
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.', code: 'RATE_LIMIT' },
});

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.', code: 'RATE_LIMIT' },
});

module.exports = { authRequired, requireRoles, loadUser, loginLimiter, sensitiveLimiter };
