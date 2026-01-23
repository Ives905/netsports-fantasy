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
        round_number INT UNIQUE NOT NULL CHECK (round_number >= 1 AND round_number <= 3),
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

    // Insert default rounds
    await pool.query(`
      INSERT INTO rounds (round_number, name, pick_deadline) VALUES
        (1, 'First Round', '2026-04-19T19:00:00-04:00'),
        (2, 'Second Round', '2026-05-03T19:00:00-04:00'),
        (3, 'Conference Finals & Cup Final', '2026-05-17T19:00:00-04:00')
      ON CONFLICT (round_number) DO NOTHING
    `);
    console.log('✓ Default rounds inserted');

    // Create team_qualifications table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_qualifications (
        id SERIAL PRIMARY KEY,
        round_number INT NOT NULL CHECK (round_number >= 1 AND round_number <= 3),
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

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/rosters', rostersRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/admin', adminRoutes); // NEW: Admin routes
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
