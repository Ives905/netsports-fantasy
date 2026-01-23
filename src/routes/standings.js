// routes/standings.js - Updated to use rounds table for deadlines
const express = require('express');
const pool = require('../../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Middleware to verify admin
const verifyAdmin = async (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// GET /api/standings - Get global leaderboard
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM leaderboard
    `);

    res.json({ standings: result.rows });
  } catch (error) {
    console.error('Error fetching standings:', error);
    res.status(500).json({ error: 'Failed to fetch standings' });
  }
});

// GET /api/standings/settings - Get current round, lock dates, and stats info
router.get('/settings', async (req, res) => {
  try {
    // Get current round from settings
    const settingsResult = await pool.query(`
      SELECT value FROM settings WHERE key = 'current_round'
    `);
    const currentRound = settingsResult.rows[0]?.value || 0;

    // Get pick deadlines from rounds table
    const roundsResult = await pool.query(`
      SELECT round_number, pick_deadline
      FROM rounds
      ORDER BY round_number
    `);

    const lockDates = {};
    roundsResult.rows.forEach(round => {
      if (round.pick_deadline) {
        lockDates[round.round_number] = round.pick_deadline;
      }
    });

    // Get stats update info
    const statsResult = await pool.query(`
      SELECT value FROM settings WHERE key IN ('stats_last_updated', 'stats_verified')
    `);
    
    const lastUpdate = statsResult.rows.find(r => r.key === 'stats_last_updated')?.value || null;
    const isVerified = statsResult.rows.find(r => r.key === 'stats_verified')?.value === 'true';

    res.json({
      currentRound: parseInt(currentRound),
      lockDates,
      lastUpdate,
      isVerified
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/standings/settings - Update current round (admin only)
router.put('/settings', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    const { currentRound } = req.body;

    if (currentRound < 0 || currentRound > 3) {
      return res.status(400).json({ error: 'Invalid round number (must be 0-3)' });
    }

    await pool.query(`
      UPDATE settings
      SET value = $1, updated_at = NOW()
      WHERE key = 'current_round'
    `, [currentRound]);

    res.json({ message: 'Settings updated successfully', currentRound });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// POST /api/standings/refresh - Trigger stats refresh (admin only)
router.post('/refresh', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    // In production, this would trigger a background job
    // For now, we'll just log and return success
    console.log('Stats refresh triggered by admin:', req.user.id);
    
    // Update the last update timestamp
    await pool.query(`
      UPDATE settings
      SET value = $1, updated_at = NOW()
      WHERE key = 'stats_last_updated'
    `, [new Date().toISOString()]);

    res.json({ message: 'Stats refresh initiated' });
  } catch (error) {
    console.error('Error refreshing stats:', error);
    res.status(500).json({ error: 'Failed to refresh stats' });
  }
});

module.exports = router;
