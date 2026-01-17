require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const playersRoutes = require('./routes/players');
const rostersRoutes = require('./routes/rosters');
const groupsRoutes = require('./routes/groups');
const standingsRoutes = require('./routes/standings');
const { setupScheduledJobs } = require('./jobs/fetchStats');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
// CORS - allow requests from frontend (needed for local development)
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json());

// Serve static files from 'public' folder
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 attempts per hour
  message: { error: 'Too many authentication attempts' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/rosters', rostersRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api', standingsRoutes);

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Serve frontend for all non-API routes (SPA catch-all)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🏒 NetSports Fantasy API Server                         ║
║                                                           ║
║   Running on port ${PORT}                                    ║
║   Environment: ${process.env.NODE_ENV || 'development'}                            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Setup scheduled jobs for stats fetching
  if (process.env.NODE_ENV === 'production') {
    setupScheduledJobs();
  } else {
    console.log('ℹ Scheduled jobs disabled in development mode');
    console.log('  Run "npm run fetch-stats" manually to update stats');
  }
});

module.exports = app;
