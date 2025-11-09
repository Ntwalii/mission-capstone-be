const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config();

const isLocal = !process.env.DATABASE_URI || /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URI);

const pool = new Pool({
  connectionString: process.env.DATABASE_URI,        // e.g. postgres://user:pass@host:5432/db
  // Many managed Postgres providers require SSL; local usually doesn't.
  ssl: isLocal ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  max: 20,
  idleTimeoutMillis: 30000,
});

// Optional: quick self-test on boot (logs only)
(async () => {
  try {
    const client = await pool.connect();
    console.log('✅ Connected to PostgreSQL');
    client.release();
  } catch (err) {
    console.error('❌ PostgreSQL connection error:', {
      message: err.message,
      code: err.code,
    });
  }
})();

module.exports = pool;
