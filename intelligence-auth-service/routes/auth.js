const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const router = express.Router();

// Util: extract Bearer token if present
function getTokenFromHeader(req) {
  const hdr = req.headers['authorization'] || '';
  if (hdr.startsWith('Bearer ')) return hdr.slice('Bearer '.length);
  return hdr || null; // support raw token too
}

// Health check for DB connectivity
router.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(503).json({ status: 'db_unavailable', message: e.message });
  }
});

// Register
router.post('/register', async (req, res) => {
  const { username, password, email, full_name, job_position } = req.body || {};

  if (!username || !password || !email) {
    return res.status(400).json({ error: 'username, password, and email are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const insertSql = `
      INSERT INTO users (username, password, email, full_name, job_position)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, username, email, full_name, job_position, created_at
    `;
    const params = [username, hashedPassword, email, full_name || null, job_position || null];
    const result = await pool.query(insertSql, params);

    res.status(201).json({
      message: 'User registered successfully',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Registration error:', { message: error.message, code: error.code });

    // ECONNREFUSED or other connection issues
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'Database connection failed',
        details: 'Unable to connect to the database. Please try again later.',
      });
    }

    // Unique violation (username/email)
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Registration failed',
        details: 'Username or email already exists',
      });
    }

    res.status(500).json({ error: 'Error registering user', details: error.message });
  }
});

// Login (reads from DB, not an in-memory array)
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  console.log(email, password);
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const { rows } = await pool.query('SELECT id, email, password FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { sub: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ token });
  } catch (error) {
    console.error('Login error:', { message: error.message, code: error.code });
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Database connection failed' });
    }
    res.status(500).json({ error: 'Error logging in', details: error.message });
  }
});

// Validate token
router.get('/validate', async (req, res) => {
  // Prefer query ?token=..., then Authorization: Bearer ..., then body.token
  const token =
    (req.query?.token && String(req.query.token)) ||
    getTokenFromHeader(req) ||
    (req.body && req.body.token);

  if (!token) return res.status(401).json({ error: 'Token required' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await pool.query(
      'SELECT id, username, email, full_name, job_position FROM users WHERE id = $1',
      [decoded.sub]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    return res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      full_name: user.full_name,
      role: user.job_position,
    });
  } catch (err) {
    console.error('Token validation error:', err.message);
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    return res.status(500).json({ error: 'Server error' });
  }
});


module.exports = router;
