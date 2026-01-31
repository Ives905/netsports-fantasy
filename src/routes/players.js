const express = require('express');
const pool = require('../../config/database');

const router = express.Router();

/**
 * GET /api/players
 * Fetch all NHL players for roster building
 * Now includes ALL players (no filtering) for bigger player pool
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id,
        p.nhl_id,
        p.name,
        p.position,
        p.team_abbrev,
        p.cost,
        t.conference,
        t.full_name as team_name
      FROM players p
      JOIN teams t ON p.team_abbrev = t.abbrev
      ORDER BY p.cost DESC, p.name ASC
    `);

    res.json({ 
      players: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Get players error:', error);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

module.exports = router;
