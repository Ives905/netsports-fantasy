const express = require('express');
const pool = require('../../config/database');
const { optionalAuth, authenticateToken, requireAdmin } = require('../middleware/auth');
const nhlApi = require('../services/nhlApi');

const router = express.Router();

/**
 * GET /api/standings
 * Get global leaderboard
 */
router.get('/standings', optionalAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        user_id as id,
        username,
        total_points as points,
        r1_points,
        r2_points,
        r3_points
      FROM leaderboard
      ORDER BY total_points DESC
      LIMIT 100
    `);

    // Add ranks
    const standings = result.rows.map((row, i) => ({
      ...row,
      rank: i + 1,
      rounds: {
        r1: row.r1_points,
        r2: row.r2_points,
        r3: row.r3_points
      }
    }));

    res.json({ standings });

  } catch (error) {
    console.error('Get standings error:', error);
    res.status(500).json({ error: 'Failed to get standings' });
  }
});

/**
 * GET /api/standings/settings
 * Get current round, lock dates, and last update info
 */
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT key, value FROM settings
      WHERE key IN ('current_round', 'lock_dates', 'stats_last_updated', 'stats_verified')
    `);

    const settings = {};
    result.rows.forEach(row => {
      settings[row.key] = JSON.parse(row.value);
    });

    res.json({
      currentRound: settings.current_round || 1,
      lockDates: settings.lock_dates || {},
      lastUpdate: settings.stats_last_updated,
      isVerified: settings.stats_verified === true
    });

  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

/**
 * POST /api/standings/refresh
 * Manually trigger stats refresh (admin only)
 */
router.post('/refresh', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Start async update
    res.json({ message: 'Stats refresh started' });
    
    // Run update in background
    nhlApi.updateAllPlayerStats().then(result => {
      console.log('Manual stats refresh completed:', result);
    }).catch(error => {
      console.error('Manual stats refresh failed:', error);
    });

  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Failed to start refresh' });
  }
});

/**
 * PUT /api/standings/settings
 * Update settings (admin only)
 */
router.put('/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { currentRound, lockDates, isVerified } = req.body;

    if (currentRound !== undefined) {
      await pool.query(`
        UPDATE settings SET value = $1, updated_at = NOW() WHERE key = 'current_round'
      `, [JSON.stringify(currentRound)]);
    }

    if (lockDates !== undefined) {
      await pool.query(`
        UPDATE settings SET value = $1, updated_at = NOW() WHERE key = 'lock_dates'
      `, [JSON.stringify(lockDates)]);
    }

    if (isVerified !== undefined) {
      await pool.query(`
        UPDATE settings SET value = $1, updated_at = NOW() WHERE key = 'stats_verified'
      `, [JSON.stringify(isVerified)]);
    }

    res.json({ message: 'Settings updated' });

  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * GET /api/standings/user/:id
 * Get user's roster and points
 */
router.get('/user/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get user info
    const userResult = await pool.query(`
      SELECT id, username FROM users WHERE id = $1 AND is_verified = true
    `, [id]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Check if rosters are viewable (after lock)
    const lockResult = await pool.query(`
      SELECT value FROM settings WHERE key = 'lock_dates'
    `);
    const lockDates = JSON.parse(lockResult.rows[0].value);

    const rosters = {};
    for (const round of [1, 2, 3]) {
      const isLocked = new Date() > new Date(lockDates[round]);
      
      if (isLocked) {
        // Get roster with player details
        const rosterResult = await pool.query(`
          SELECT 
            p.id, p.name, p.team_abbrev as team, p.position, p.cost,
            t.conference,
            rp.is_star,
            ps.goals, ps.assists, ps.wins, ps.shutouts
          FROM rosters r
          JOIN roster_players rp ON r.id = rp.roster_id
          JOIN players p ON rp.player_id = p.id
          JOIN teams t ON p.team_abbrev = t.abbrev
          LEFT JOIN player_stats ps ON p.id = ps.player_id AND ps.round = $3
          WHERE r.user_id = $1 AND r.round = $2 AND r.is_submitted = true
        `, [id, round, round]);

        rosters[round] = rosterResult.rows;
      }
    }

    // Get points from leaderboard
    const pointsResult = await pool.query(`
      SELECT total_points, r1_points, r2_points, r3_points
      FROM leaderboard WHERE user_id = $1
    `, [id]);

    const points = pointsResult.rows[0] || { total_points: 0, r1_points: 0, r2_points: 0, r3_points: 0 };

    res.json({
      user,
      rosters,
      points: {
        total: points.total_points,
        r1: points.r1_points,
        r2: points.r2_points,
        r3: points.r3_points
      }
    });

  } catch (error) {
    console.error('Get user standings error:', error);
    res.status(500).json({ error: 'Failed to get user standings' });
  }
});

/**
 * GET /api/standings/teams
 * Get teams with elimination status
 */
router.get('/teams', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT abbrev, name, conference, is_eliminated, eliminated_round, color
      FROM teams ORDER BY conference, name
    `);

    res.json({ teams: result.rows });

  } catch (error) {
    console.error('Get teams error:', error);
    res.status(500).json({ error: 'Failed to get teams' });
  }
});

module.exports = router;
