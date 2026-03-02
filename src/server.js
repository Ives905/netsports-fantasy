require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const pool = require('../config/database');

// Safe schema updates — idempotent, run on every startup
async function runSchemaMigrations() {
  try {
    await pool.query(`
      ALTER TABLE players ADD COLUMN IF NOT EXISTS headshot_url VARCHAR(500)
    `);
    console.log('✓ Schema up to date');
  } catch (err) {
    console.error('Schema migration warning:', err.message);
  }
}

/**
 * Backfill headshot_url for any players that are missing it.
 * Groups by team so we only fetch each team's roster once.
 * Runs async in the background — doesn't block server startup.
 */
async function backfillHeadshotUrls() {
  try {
    const missing = await pool.query(`
      SELECT DISTINCT team_abbrev FROM players
      WHERE headshot_url IS NULL AND team_abbrev IS NOT NULL
    `);
    if (missing.rows.length === 0) {
      console.log('✓ All headshot URLs already populated');
      return;
    }

    console.log(`⏳ Backfilling headshots for ${missing.rows.length} teams...`);
    let updated = 0;

    for (const { team_abbrev } of missing.rows) {
      try {
        const url = `https://api-web.nhle.com/v1/roster/${team_abbrev}/current`;
        const { data } = await axios.get(url, { timeout: 8000 });
        const players = [
          ...(data.forwards || []),
          ...(data.defensemen || []),
          ...(data.goalies || [])
        ];

        for (const p of players) {
          if (!p.headshot || !p.id) continue;
          const result = await pool.query(`
            UPDATE players SET headshot_url = $1
            WHERE nhl_id = $2 AND headshot_url IS NULL
            RETURNING id
          `, [p.headshot, p.id]);
          updated += result.rowCount;
        }
        // Small delay to avoid hammering NHL API
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        console.error(`  Headshot backfill failed for ${team_abbrev}:`, err.message);
      }
    }

    console.log(`✅ Headshot backfill complete — updated ${updated} players`);
  } catch (err) {
    console.error('Headshot backfill error:', err.message);
  }
}

// Expose backfill so admin route can call it too
module.exports.backfillHeadshotUrls = backfillHeadshotUrls;

const authRoutes = require('./routes/auth');
const playersRoutes = require('./routes/players');
const rostersRoutes = require('./routes/rosters');
const groupsRoutes = require('./routes/groups');
const standingsRoutes = require('./routes/standings');
const adminRoutes = require('./routes/admin');
const { setupScheduledJobs } = require('./jobs/fetchStats');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy - Railway uses a reverse proxy
app.set('trust proxy', 1);

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
app.use('/api/admin', adminRoutes);
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

// Start server — run schema migrations first, then start listening
runSchemaMigrations().then(() => {
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

    // Async background backfill — fill in any missing headshot URLs
    // after server is already up and serving requests
    setImmediate(() => backfillHeadshotUrls());
  });
});

module.exports = { app, backfillHeadshotUrls };
