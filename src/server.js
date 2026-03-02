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

    // Regular-season stats columns (populated by updatePlayerCosts admin action)
    await pool.query(`
      ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_gp      INT;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_goals   INT;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_assists INT;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_points  INT;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_wins    INT;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_save_pct DECIMAL(5,3);
      ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_gaa      DECIMAL(4,2);
    `);

    // Utah Hockey Club — replaced Arizona Coyotes starting 2024-25 season
    await pool.query(`
      INSERT INTO teams (abbrev, name, conference, color)
      VALUES ('UTA', 'Utah Hockey Club', 'western', '#6CACE4')
      ON CONFLICT (abbrev) DO NOTHING
    `);

    console.log('✓ Schema up to date');
  } catch (err) {
    console.error('Schema migration warning:', err.message);
  }
}

/**
 * For every team in the teams table, ensure players exist and headshots are set.
 * - Teams with ZERO players: fetches roster from NHL API and inserts them
 * - Teams with players missing headshot_url: updates headshot_url only
 * Runs async in the background — doesn't block server startup.
 */
async function backfillHeadshotUrls() {
  try {
    // Find teams that either have no players at all, or have players missing headshots
    const teamsResult = await pool.query(`
      SELECT t.abbrev,
             COUNT(p.id) AS player_count,
             COUNT(p.id) FILTER (WHERE p.headshot_url IS NULL) AS missing_headshots
      FROM teams t
      LEFT JOIN players p ON p.team_abbrev = t.abbrev
      GROUP BY t.abbrev
      HAVING COUNT(p.id) = 0
          OR COUNT(p.id) FILTER (WHERE p.headshot_url IS NULL) > 0
    `);

    if (teamsResult.rows.length === 0) {
      console.log('✓ All players present and headshot URLs populated');
      return;
    }

    const emptyTeams   = teamsResult.rows.filter(r => parseInt(r.player_count) === 0).map(r => r.abbrev);
    const missingShots = teamsResult.rows.filter(r => parseInt(r.missing_headshots) > 0).map(r => r.abbrev);

    if (emptyTeams.length) console.log(`⏳ Inserting players for new teams: ${emptyTeams.join(', ')}`);
    if (missingShots.length) console.log(`⏳ Backfilling headshots for ${missingShots.length} teams...`);

    let inserted = 0, updated = 0;

    for (const { abbrev: team_abbrev, player_count } of teamsResult.rows) {
      const isNewTeam = parseInt(player_count) === 0;
      try {
        const url = `https://api-web.nhle.com/v1/roster/${team_abbrev}/current`;
        const { data } = await axios.get(url, { timeout: 8000 });
        const allPlayers = [
          ...(data.forwards   || []),
          ...(data.defensemen || []),
          ...(data.goalies    || [])
        ];

        for (const p of allPlayers) {
          if (!p.id) continue;

          if (isNewTeam) {
            // Full insert for teams that have no players yet
            const firstName = p.firstName?.default || p.firstName || '';
            const lastName  = p.lastName?.default  || p.lastName  || '';
            const fullName  = `${firstName} ${lastName}`.trim();
            if (!fullName) continue;

            let position = 'forward';
            if (p.positionCode === 'G') position = 'goalie';
            else if (p.positionCode === 'D') position = 'defense';

            const baseCost = { goalie: 3, defense: 2, forward: 2 };
            const cost = Math.min(Math.max((baseCost[position] || 2) + (p.headshot ? 1 : 0), 1), 5);

            const r = await pool.query(`
              INSERT INTO players (nhl_id, name, position, team_abbrev, cost, is_active, headshot_url)
              VALUES ($1, $2, $3, $4, $5, true, $6)
              ON CONFLICT (nhl_id) DO UPDATE
                SET name = $2, position = $3, team_abbrev = $4, cost = $5,
                    is_active = true, headshot_url = COALESCE($6, players.headshot_url)
              RETURNING (xmax = 0) AS was_inserted
            `, [p.id, fullName, position, team_abbrev, cost, p.headshot || null]);

            if (r.rows[0]?.was_inserted) inserted++;
          } else if (p.headshot) {
            // Headshot-only update for existing players
            const r = await pool.query(`
              UPDATE players SET headshot_url = $1
              WHERE nhl_id = $2 AND headshot_url IS NULL
              RETURNING id
            `, [p.headshot, p.id]);
            updated += r.rowCount;
          }
        }

        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        console.error(`  Roster fetch failed for ${team_abbrev}:`, err.message);
      }
    }

    if (inserted) console.log(`✅ Inserted ${inserted} new players`);
    if (updated)  console.log(`✅ Updated headshots for ${updated} players`);
  } catch (err) {
    console.error('Backfill error:', err.message);
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
