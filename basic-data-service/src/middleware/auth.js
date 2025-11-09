const axios = require('axios');
const env = require('../env');

async function requireAuth(req, res, next) {
  const hdr = req.header('authorization') || req.header('Authorization');
  if (!hdr || !hdr.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing Bearer token' });
  }
  const token = hdr.slice('Bearer '.length);

  try {
    // your /auth/validate supports raw token or Bearer — if needed, change header to `Bearer ${token}`
    const { data } = await axios.get(env.authValidateUrl, { headers: { Authorization: token }, timeout: 3000 });
    req.user = data; // expecting { sub, username/email, ... }
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
  }
}

module.exports = { requireAuth };
