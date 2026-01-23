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
const adminRoutes = require('./routes/admin'); // NEW: Admin routes
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

// ONE-TIME MIGRATION ENDPOINT
// Visit this URL once after deploying to run the database migration
// Example: https://your-app.railway.app/api/migrate
app.get('/api/migrate', async (req, res) => {
  const pool = require('../config/database');
  
  try {
    console.log('🔄 Running database migration...');
    
    // Create rounds table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        id SERIAL PRIMARY KEY,
        round_number INT UNIQUE NOT NULL CHECK (round_number >= 0 AND round_number <= 3),
        name VARCHAR(100) NOT NULL,
        pick_deadline TIMESTAMP WITH TIME ZONE,
        start_date TIMESTAMP WITH TIME ZONE,
        end_date TIMESTAMP WITH TIME ZONE,
        is_active BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
    console.log('✓ Rounds table created');

    // Insert default rounds (including testing round)
    await pool.query(`
      INSERT INTO rounds (round_number, name, pick_deadline) VALUES
        (0, 'Testing Round', '2026-01-25T12:00:00-05:00'),
        (1, 'First Round', '2026-04-19T19:00:00-04:00'),
        (2, 'Second Round', '2026-05-03T19:00:00-04:00'),
        (3, 'Conference Finals & Cup Final', '2026-05-17T19:00:00-04:00')
      ON CONFLICT (round_number) DO NOTHING
    `);
    console.log('✓ Default rounds inserted (including testing round)');

    // Create team_qualifications table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_qualifications (
        id SERIAL PRIMARY KEY,
        round_number INT NOT NULL CHECK (round_number >= 0 AND round_number <= 3),
        team_abbrev VARCHAR(3) NOT NULL REFERENCES teams(abbrev),
        qualified BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(round_number, team_abbrev)
      )
    `);
    console.log('✓ Team qualifications table created');

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_qualifications_round ON team_qualifications(round_number)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_qualifications_team ON team_qualifications(team_abbrev)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_rounds_number ON rounds(round_number)
    `);
    console.log('✓ Indexes created');

    // Create triggers
    await pool.query(`
      CREATE TRIGGER update_rounds_updated_at BEFORE UPDATE ON rounds
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `).catch(err => {
      // Trigger might already exist, that's okay
      if (!err.message.includes('already exists')) throw err;
    });
    
    await pool.query(`
      CREATE TRIGGER update_team_qualifications_updated_at BEFORE UPDATE ON team_qualifications
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `).catch(err => {
      if (!err.message.includes('already exists')) throw err;
    });
    console.log('✓ Triggers created');

    res.json({ 
      success: true, 
      message: 'Migration completed successfully! You can now use the admin panel to set pick deadlines and qualified teams.',
      tables_created: ['rounds', 'team_qualifications']
    });
    
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      hint: 'Check server logs for details'
    });
  }
});

// FIX EXISTING ROUNDS TABLE - Run this if you get constraint errors
// Visit: https://your-app.railway.app/api/fix-rounds
app.get('/api/fix-rounds', async (req, res) => {
  const pool = require('../config/database');
  
  try {
    console.log('🔧 Fixing rounds table and settings...');
    
    // Drop the old constraint on rounds
    await pool.query(`
      ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_round_number_check
    `);
    console.log('✓ Dropped old rounds constraint');
    
    // Add new constraint allowing 0-3
    await pool.query(`
      ALTER TABLE rounds ADD CONSTRAINT rounds_round_number_check 
      CHECK (round_number >= 0 AND round_number <= 3)
    `);
    console.log('✓ Added new rounds constraint (0-3)');
    
    // Insert testing round
    await pool.query(`
      INSERT INTO rounds (round_number, name, pick_deadline) 
      VALUES (0, 'Testing Round', '2026-01-25T12:00:00-05:00')
      ON CONFLICT (round_number) DO NOTHING
    `);
    console.log('✓ Testing round inserted');
    
    // Update team_qualifications constraint
    await pool.query(`
      ALTER TABLE team_qualifications DROP CONSTRAINT IF EXISTS team_qualifications_round_number_check
    `);
    await pool.query(`
      ALTER TABLE team_qualifications ADD CONSTRAINT team_qualifications_round_number_check 
      CHECK (round_number >= 0 AND round_number <= 3)
    `);
    console.log('✓ Team qualifications constraint updated');
    
    // Check if settings table has a constraint and remove it if needed
    const constraintCheck = await pool.query(`
      SELECT constraint_name 
      FROM information_schema.table_constraints 
      WHERE table_name = 'settings' 
      AND constraint_type = 'CHECK'
    `);
    
    for (const row of constraintCheck.rows) {
      // Properly quote the constraint name to handle special characters
      const quotedName = `"${row.constraint_name}"`;
      await pool.query(`ALTER TABLE settings DROP CONSTRAINT IF EXISTS ${quotedName}`);
      console.log(`✓ Dropped settings constraint: ${row.constraint_name}`);
    }
    
    res.json({ 
      success: true, 
      message: 'All constraints fixed! Testing round (Round 0) is now fully available.',
      changes: [
        'Updated rounds constraint to allow 0-3',
        'Updated team_qualifications constraint to allow 0-3',
        'Inserted Testing Round (Round 0)',
        'Removed any conflicting settings constraints'
      ]
    });
    
  } catch (error) {
    console.error('Fix rounds error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      hint: 'Check server logs for details'
    });
  }
});

// ONE-TIME TEAMS MIGRATION ENDPOINT
// Visit this URL once to add all 32 NHL teams to the database
// Example: https://your-app.railway.app/api/migrate-teams
app.get('/api/migrate-teams', async (req, res) => {
  const pool = require('../config/database');
  
  try {
    console.log('🔄 Adding all 32 NHL teams...');
    
    const teams = [
      // Eastern - Atlantic
      { abbrev: 'BOS', name: 'Boston Bruins', conference: 'eastern', color: '#FFB81C' },
      { abbrev: 'BUF', name: 'Buffalo Sabres', conference: 'eastern', color: '#002654' },
      { abbrev: 'DET', name: 'Detroit Red Wings', conference: 'eastern', color: '#CE1126' },
      { abbrev: 'FLA', name: 'Florida Panthers', conference: 'eastern', color: '#041E42' },
      { abbrev: 'MTL', name: 'Montreal Canadiens', conference: 'eastern', color: '#AF1E2D' },
      { abbrev: 'OTT', name: 'Ottawa Senators', conference: 'eastern', color: '#C52032' },
      { abbrev: 'TBL', name: 'Tampa Bay Lightning', conference: 'eastern', color: '#002868' },
      { abbrev: 'TOR', name: 'Toronto Maple Leafs', conference: 'eastern', color: '#00205B' },
      // Eastern - Metropolitan
      { abbrev: 'CAR', name: 'Carolina Hurricanes', conference: 'eastern', color: '#CE1126' },
      { abbrev: 'CBJ', name: 'Columbus Blue Jackets', conference: 'eastern', color: '#002654' },
      { abbrev: 'NJD', name: 'New Jersey Devils', conference: 'eastern', color: '#CE1126' },
      { abbrev: 'NYI', name: 'New York Islanders', conference: 'eastern', color: '#00539B' },
      { abbrev: 'NYR', name: 'New York Rangers', conference: 'eastern', color: '#0038A8' },
      { abbrev: 'PHI', name: 'Philadelphia Flyers', conference: 'eastern', color: '#F74902' },
      { abbrev: 'PIT', name: 'Pittsburgh Penguins', conference: 'eastern', color: '#000000' },
      { abbrev: 'WSH', name: 'Washington Capitals', conference: 'eastern', color: '#041E42' },
      // Western - Central
      { abbrev: 'ARI', name: 'Arizona Coyotes', conference: 'western', color: '#8C2633' },
      { abbrev: 'CHI', name: 'Chicago Blackhawks', conference: 'western', color: '#CF0A2C' },
      { abbrev: 'COL', name: 'Colorado Avalanche', conference: 'western', color: '#6F263D' },
      { abbrev: 'DAL', name: 'Dallas Stars', conference: 'western', color: '#006847' },
      { abbrev: 'MIN', name: 'Minnesota Wild', conference: 'western', color: '#154734' },
      { abbrev: 'NSH', name: 'Nashville Predators', conference: 'western', color: '#FFB81C' },
      { abbrev: 'STL', name: 'St. Louis Blues', conference: 'western', color: '#002F87' },
      { abbrev: 'WPG', name: 'Winnipeg Jets', conference: 'western', color: '#041E42' },
      // Western - Pacific
      { abbrev: 'ANA', name: 'Anaheim Ducks', conference: 'western', color: '#F47A38' },
      { abbrev: 'CGY', name: 'Calgary Flames', conference: 'western', color: '#C8102E' },
      { abbrev: 'EDM', name: 'Edmonton Oilers', conference: 'western', color: '#041E42' },
      { abbrev: 'LAK', name: 'Los Angeles Kings', conference: 'western', color: '#111111' },
      { abbrev: 'SJS', name: 'San Jose Sharks', conference: 'western', color: '#006D75' },
      { abbrev: 'SEA', name: 'Seattle Kraken', conference: 'western', color: '#001628' },
      { abbrev: 'VAN', name: 'Vancouver Canucks', conference: 'western', color: '#00205B' },
      { abbrev: 'VGK', name: 'Vegas Golden Knights', conference: 'western', color: '#B4975A' }
    ];

    let added = 0;
    let existing = 0;

    for (const team of teams) {
      try {
        await pool.query(`
          INSERT INTO teams (abbrev, name, conference, color)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (abbrev) DO UPDATE SET
            color = EXCLUDED.color
        `, [team.abbrev, team.name, team.conference, team.color]);
        added++;
      } catch (err) {
        existing++;
      }
    }

    console.log(`✓ Teams migration complete: ${added} added/updated, ${existing} already existed`);

    res.json({ 
      success: true, 
      message: `All 32 NHL teams are now in the database! ${added} teams added/updated.`,
      teams_processed: teams.length
    });
    
  } catch (error) {
    console.error('Teams migration error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      hint: 'Check server logs for details'
    });
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/rosters', rostersRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/admin', adminRoutes); // Admin routes
app.use('/api/standings', standingsRoutes); // Standings routes

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
