require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const pool = require('../config/database');

// Run a single migration step — failures are logged but never abort subsequent steps
async function runMigration(label, sql) {
  try {
    await pool.query(sql);
  } catch (err) {
    console.warn(`Migration warning [${label}]:`, err.message);
  }
}

// Safe schema updates — idempotent, run on every startup.
// Each step is isolated so one failure never silently blocks the rest.
async function runSchemaMigrations() {
  await runMigration('headshot_url',   `ALTER TABLE players ADD COLUMN IF NOT EXISTS headshot_url  VARCHAR(500)`);

  // Regular-season stats columns (populated by "Recalculate Player Values" admin action)
  await runMigration('reg_gp',         `ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_gp        INT`);
  await runMigration('reg_goals',      `ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_goals      INT`);
  await runMigration('reg_assists',    `ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_assists    INT`);
  await runMigration('reg_points',     `ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_points     INT`);
  await runMigration('reg_wins',       `ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_wins       INT`);
  await runMigration('reg_save_pct',   `ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_save_pct   DECIMAL(5,3)`);
  await runMigration('reg_gaa',        `ALTER TABLE players ADD COLUMN IF NOT EXISTS reg_gaa        DECIMAL(4,2)`);

  // Utah Hockey Club — replaced Arizona Coyotes starting 2024-25 season
  await runMigration('insert_UTA', `
    INSERT INTO teams (abbrev, name, conference, color)
    VALUES ('UTA', 'Utah Hockey Club', 'western', '#6CACE4')
    ON CONFLICT (abbrev) DO NOTHING
  `);

  // Remove Arizona Coyotes — franchise relocated, no longer exists.
  // Clear ALL FK dependents first (team_qualifications, then players) before deleting the team row.
  await runMigration('delete_ARI_qualifications', `DELETE FROM team_qualifications WHERE team_abbrev = 'ARI'`);
  await runMigration('migrate_ARI_players',       `UPDATE players SET team_abbrev = 'UTA' WHERE team_abbrev = 'ARI'`);
  await runMigration('delete_ARI',                `DELETE FROM teams WHERE abbrev = 'ARI'`);

  // Allow round 0 (Testing Round) in rosters and tiebreakers tables.
  // Original CHECK was (round >= 1 AND round <= 3) which blocked the testing round.
  await runMigration('rosters_round_check_drop',        `ALTER TABLE rosters DROP CONSTRAINT IF EXISTS rosters_round_check`);
  await runMigration('rosters_round_check_add',         `ALTER TABLE rosters ADD CONSTRAINT rosters_round_check CHECK (round >= 0 AND round <= 3)`);
  await runMigration('tiebreakers_round_check_drop',    `ALTER TABLE tiebreakers DROP CONSTRAINT IF EXISTS tiebreakers_round_check`);
  await runMigration('tiebreakers_round_check_add',     `ALTER TABLE tiebreakers ADD CONSTRAINT tiebreakers_round_check CHECK (round >= 0 AND round <= 3)`);


  // ===== Saturday Night Pickem pool (new, additive only) =====
  await runMigration('pickem_weeks_table', `
    CREATE TABLE IF NOT EXISTS pickem_weeks (
      id SERIAL PRIMARY KEY,
      week_date DATE UNIQUE NOT NULL,
      season VARCHAR(9) NOT NULL,
      tiebreaker_game_id INT,
      is_finalized BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await runMigration('pickem_games_table', `
    CREATE TABLE IF NOT EXISTS pickem_games (
      id SERIAL PRIMARY KEY,
      week_id INT REFERENCES pickem_weeks(id) ON DELETE CASCADE,
      nhl_game_id BIGINT UNIQUE NOT NULL,
      home_team VARCHAR(3) NOT NULL,
      away_team VARCHAR(3) NOT NULL,
      start_time TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) DEFAULT 'scheduled',
      home_score INT,
      away_score INT,
      winner VARCHAR(3),
      is_tiebreaker_game BOOLEAN DEFAULT FALSE,
      graded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await runMigration('pickem_games_week_idx',  `CREATE INDEX IF NOT EXISTS idx_pickem_games_week ON pickem_games(week_id)`);
  await runMigration('pickem_games_start_idx', `CREATE INDEX IF NOT EXISTS idx_pickem_games_start ON pickem_games(start_time)`);

  await runMigration('pickem_weeks_tiebreaker_fk_drop', `ALTER TABLE pickem_weeks DROP CONSTRAINT IF EXISTS fk_pickem_weeks_tiebreaker_game`);
  await runMigration('pickem_weeks_tiebreaker_fk_add',  `ALTER TABLE pickem_weeks ADD CONSTRAINT fk_pickem_weeks_tiebreaker_game FOREIGN KEY (tiebreaker_game_id) REFERENCES pickem_games(id)`);

  await runMigration('pickem_picks_table', `
    CREATE TABLE IF NOT EXISTS pickem_picks (
      id SERIAL PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      game_id INT REFERENCES pickem_games(id) ON DELETE CASCADE,
      picked_team VARCHAR(3) NOT NULL,
      is_correct BOOLEAN,
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, game_id)
    )
  `);
  await runMigration('pickem_picks_user_idx', `CREATE INDEX IF NOT EXISTS idx_pickem_picks_user ON pickem_picks(user_id)`);
  await runMigration('pickem_picks_game_idx', `CREATE INDEX IF NOT EXISTS idx_pickem_picks_game ON pickem_picks(game_id)`);

  await runMigration('pickem_tiebreakers_table', `
    CREATE TABLE IF NOT EXISTS pickem_tiebreakers (
      id SERIAL PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      week_id INT REFERENCES pickem_weeks(id) ON DELETE CASCADE,
      guessed_total_goals INT NOT NULL CHECK (guessed_total_goals >= 0),
      actual_total_goals INT,
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, week_id)
    )
  `);

  await runMigration('pickem_groups_table', `
    CREATE TABLE IF NOT EXISTS pickem_groups (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(100) NOT NULL,
      description TEXT,
      code VARCHAR(8) UNIQUE NOT NULL,
      is_private BOOLEAN DEFAULT TRUE,
      owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await runMigration('pickem_groups_code_idx', `CREATE INDEX IF NOT EXISTS idx_pickem_groups_code ON pickem_groups(UPPER(code))`);
  await runMigration('pickem_groups_updated_at_trigger_drop', `DROP TRIGGER IF EXISTS update_pickem_groups_updated_at ON pickem_groups`);
  await runMigration('pickem_groups_updated_at_trigger_add',  `CREATE TRIGGER update_pickem_groups_updated_at BEFORE UPDATE ON pickem_groups FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`);

  await runMigration('pickem_group_members_table', `
    CREATE TABLE IF NOT EXISTS pickem_group_members (
      id SERIAL PRIMARY KEY,
      group_id UUID REFERENCES pickem_groups(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, user_id)
    )
  `);

  await runMigration('pickem_leaderboard_view', `
    CREATE OR REPLACE VIEW pickem_leaderboard AS
    SELECT
      u.id AS user_id,
      u.username,
      COUNT(*) FILTER (WHERE pp.is_correct = true) AS total_correct,
      COUNT(*) FILTER (WHERE pp.is_correct IS NOT NULL) AS total_graded
    FROM users u
    JOIN pickem_picks pp ON pp.user_id = u.id
    GROUP BY u.id, u.username
    ORDER BY total_correct DESC
  `);

  console.log('✓ Pickem schema migrations complete');

  console.log('✓ Schema migrations complete');
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
const pickemRoutes = require('./routes/pickem');
const { setupScheduledJobs } = require('./jobs/fetchStats');
const { setupPickemJobs } = require('./jobs/fetchPickemData');

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
app.use('/api/standings', standingsRoutes);
app.use('/api/pickem', pickemRoutes);

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
      setupPickemJobs();
    } else {
      console.log('ℹ Scheduled jobs disabled in development mode');
      console.log('  Run "npm run fetch-stats" manually to update stats');
      console.log('  Run "npm run fetch-pickem" manually to sync Saturday pickem data');
    }

    // Async background backfill — fill in any missing headshot URLs
    // after server is already up and serving requests
    setImmediate(() => backfillHeadshotUrls());
  });
});

module.exports = { app, backfillHeadshotUrls };
