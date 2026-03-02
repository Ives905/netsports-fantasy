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
    console.log('Fetching players...');
    
    // Get players — includes headshot_url (exact URL from NHL API roster response)
    const result = await pool.query(`
      SELECT
        p.id,
        p.nhl_id,
        p.name,
        p.position,
        p.team_abbrev,
        p.cost,
        p.headshot_url,
        t.conference
      FROM players p
      LEFT JOIN teams t ON p.team_abbrev = t.abbrev
      ORDER BY p.cost DESC, p.name ASC
    `);

    console.log(`Found ${result.rows.length} players`);
    
    res.json({ 
      players: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Get players error:', error);
    console.error('Error details:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch players',
      message: error.message,
      detail: error.detail || 'No additional details'
    });
  }
});

module.exports = router;
