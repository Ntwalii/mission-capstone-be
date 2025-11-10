const express = require('express');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const passport = require('passport');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json');
const authRoutes = require('./routes/auth');
const oauthRoutes = require('./routes/oauth');
const pool = require('./config/database');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// CORS: allow everything
app.use(cors({
  origin: (origin, cb) => cb(null, true),   // reflect all origins
  credentials: true,                        // allow cookies / sessions
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));
app.options('*', cors()); // handle preflight for all routes
// -----------------------------------------------------------------------------

// Trust proxy for secure cookies behind reverse proxies
app.set('trust proxy', 1);

// Middleware
app.use(cookieParser());
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'devsecret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',   // true if HTTPS
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  },
}));

// Passport setup
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.email || user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email=$1 OR id::text=$1 LIMIT 1',
      [id]
    );
    done(null, rows[0] || null);
  } catch (e) {
    done(e);
  }
});

// Routes
app.use('/auth', authRoutes);
app.use('/auth/oauth', oauthRoutes);

// Swagger docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Authentication service running on http://localhost:${PORT}`);
  console.log('CORS: Allowing requests from ANY origin 🚀');
});
