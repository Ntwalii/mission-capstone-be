const express = require('express');
const passport = require('passport');
const dotenv = require('dotenv');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { OIDCStrategy } = require('passport-azure-ad');
const jwt = require('jsonwebtoken');

const pool = require('../config/database');

dotenv.config();
const router = express.Router();

// IMPORTANT: In your main server file, add:
//   const cookieParser = require('cookie-parser');
//   app.use(cookieParser());

const FE_ORIGIN = process.env.FE_ORIGIN || 'http://localhost:5173';
const AUTH_BASE = process.env.AUTH_BASE || 'http://localhost:3000';

// ---- helpers ----
function makeJwt(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function upsertUserFromOAuth({ email, fullName, provider, role, usernameFallback }) {
  let { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  if (rows.length === 0) {
    const username = usernameFallback || (fullName ? fullName.replace(/\s+/g, '') : email.split('@')[0]);
    const insert = `
      INSERT INTO users (email, full_name, username, provider, password, job_position)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`;
    ({ rows } = await pool.query(insert, [email, fullName || '', username, provider, 'password', role || null]));
    return rows[0];
  } else {
    const u = rows[0];
    // backfill job_position if missing
    if (!u.job_position && role) {
      const upd = `UPDATE users SET job_position = $1 WHERE id = $2 RETURNING *`;
      const r2 = await pool.query(upd, [role, u.id]);
      return r2.rows[0];
    }
    return u;
  }
}

// ---- Google strategy ----
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${AUTH_BASE}/auth/oauth/google/callback`
}, async (_accessToken, _refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value;
    const fullName = profile.displayName || '';
    if (!email) return done(null, false, { message: 'No email from Google' });
    // We do the DB upsert in the callback route (to also read the role cookie there)
    done(null, { email, fullName, provider: 'google' });
  } catch (err) { done(err); }
}));

// ---- Microsoft (Azure AD) ----
const tenant = process.env.MICROSOFT_TENANT_ID || 'common';

passport.use('azuread-openidconnect', new OIDCStrategy({
  identityMetadata: `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
  clientID: process.env.MICROSOFT_CLIENT_ID,
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  redirectUrl: `${AUTH_BASE}/auth/oauth/microsoft/callback`,
  responseType: 'code',
  responseMode: 'form_post',
  scope: ['openid', 'profile', 'email', 'offline_access'],
  allowHttpForRedirectUrl: true,
  passReqToCallback: false,
}, async (iss, sub, profile, accessToken, refreshToken, params, done) => {
  try {
    const email =
      profile._json?.email ||
      profile._json?.preferred_username ||
      (Array.isArray(profile.emails) ? profile.emails[0] : null);
    const fullName = profile.displayName || '';
    if (!email) return done(null, false, { message: 'No email from Microsoft' });
    done(null, { email, fullName, provider: 'microsoft' });
  } catch (e) { done(e); }
}));

// ---- Start: sets role cookie then redirects to provider ----
router.get('/start', (req, res) => {
  const provider = (req.query.provider || '').toString();
  const role = (req.query.role || '').toString().trim();   // empty for login
  const name = (req.query.name || '').toString().trim();

  if (!['google', 'microsoft'].includes(provider)) {
    return res.status(400).send('Invalid provider');
  }

  // short-lived cookie with role + name
  res.cookie('pending_role', JSON.stringify({ role, name }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // true if https
    maxAge: 5 * 60 * 1000
  });

  if (provider === 'google') {
    return res.redirect(`${AUTH_BASE}/auth/oauth/google`);
  } else {
    return res.redirect(`${AUTH_BASE}/auth/oauth/microsoft`);
  }
});

// ---- Google routes ----
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/login', session: false }),
  async (req, res) => {
    try {
      let role = null, name = null;
      try {
        const parsed = req.cookies?.pending_role ? JSON.parse(req.cookies.pending_role) : {};
        role = parsed?.role || null;
        name = parsed?.name || null;
      } catch {}

      const { email, fullName, provider } = req.user;
      const user = await upsertUserFromOAuth({
        email,
        fullName: fullName || name || '',
        provider,
        role,
        usernameFallback: email.split('@')[0],
      });

      res.clearCookie('pending_role');

      const token = makeJwt(user);
      const redirect = new URL(`${FE_ORIGIN}/auth/callback`);
      redirect.searchParams.set('token', token);
      return res.redirect(redirect.toString());
    } catch (e) {
      console.error(e);
      return res.redirect(`${FE_ORIGIN}/auth?error=oauth_failed`);
    }
  }
);

// ---- Microsoft routes ----
router.get('/microsoft',
  passport.authenticate('azuread-openidconnect', { prompt: 'select_account', session: false })
);

router.post('/microsoft/callback',
  passport.authenticate('azuread-openidconnect', { failureRedirect: '/login', session: false }),
  async (req, res) => {
    try {
      let role = null, name = null;
      try {
        const parsed = req.cookies?.pending_role ? JSON.parse(req.cookies.pending_role) : {};
        role = parsed?.role || null;
        name = parsed?.name || null;
      } catch {}

      const { email, fullName, provider } = req.user;
      const user = await upsertUserFromOAuth({
        email,
        fullName: fullName || name || '',
        provider,
        role,
        usernameFallback: email.split('@')[0],
      });

      res.clearCookie('pending_role');

      const token = makeJwt(user);
      const redirect = new URL(`${FE_ORIGIN}/auth/callback`);
      redirect.searchParams.set('token', token);
      return res.redirect(redirect.toString());
    } catch (e) {
      console.error(e);
      return res.redirect(`${FE_ORIGIN}/auth?error=oauth_failed`);
    }
  }
);

module.exports = router;
