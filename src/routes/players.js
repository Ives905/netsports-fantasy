const express = require('express');
const pool = require('../../config/database');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/players
 * Get all players with their stats
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { round, conference, position } = req.query;

    let query = `
      SELECT 
        p.id,
        p.nhl_id,
        p.name,
        p.team_abbrev as team,
        p.position,
        p.cost,
        t.conference,
        t.is_eliminated,
        t.eliminated_round,
        t.color as team_color,
        COALESCE(
          json_agg(
            json_build_object(
              'round', ps.round,
              'goals', ps.goals,
              'assists', ps.assists,
              'wins', ps.wins,
              'shutouts', ps.shutouts,
              'gamesPlayed', ps.games_played
            )
          ) FILTER (WHERE ps.round IS NOT NULL),
          '[]'
        ) as stats
      FROM players p
      JOIN teams t ON p.team_abbrev = t.abbrev
      LEFT JOIN player_stats ps ON p.id = ps.player_id
      WHERE p.is_active = true
    `;

    const params = [];
    let paramIndex = 1;

    if (conference) {
      query += ` AND t.conference = $${paramIndex}`;
      params.push(conference);
      paramIndex++;
    }

    if (position) {
      query += ` AND p.position = $${paramIndex}`;
      params.push(position);
      paramIndex++;
    }

    query += ` GROUP BY p.id, t.conference, t.is_eliminated, t.eliminated_round, t.color`;
    query += ` ORDER BY p.cost DESC, p.name ASC`;

    const result = await pool.query(query, params);

    // Transform stats array into object keyed by round
    const players = result.rows.map(player => {
      const statsObj = { r1: {}, r2: {}, r3: {} };
      
      if (Array.isArray(player.stats)) {
        player.stats.forEach(s => {
          if (s.round) {
            const key = `r${s.round}`;
            if (player.position === 'goalie') {
              statsObj[key] = { w: s.wins || 0, so: s.shutouts || 0 };
            } else {
              statsObj[key] = { g: s.goals || 0, a: s.assists || 0 };
            }
          }
        });
      }

      return {
        id: player.id,
        nhlId: player.nhl_id,
        name: player.name,
        team: player.team,
        position: player.position,
        cost: player.cost,
        conference: player.conference,
        isEliminated: player.is_eliminated,
        eliminatedRound: player.eliminated_round,
        teamColor: player.team_color,
        stats: statsObj
      };
    });

    res.json({ players });

  } catch (error) {
    console.error('Get players error:', error);
    res.status(500).json({ error: 'Failed to get players' });
  }
});

/**
 * GET /api/players/:id
 * Get single player with detailed stats
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        p.*,
        t.conference,
        t.name as team_name,
        t.color as team_color,
        t.is_eliminated
      FROM players p
      JOIN teams t ON p.team_abbrev = t.abbrev
      WHERE p.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const player = result.rows[0];

    // Get stats
    const statsResult = await pool.query(`
      SELECT round, goals, assists, wins, shutouts, games_played
      FROM player_stats WHERE player_id = $1
    `, [id]);

    const stats = {};
    statsResult.rows.forEach(s => {
      stats[`r${s.round}`] = {
        goals: s.goals,
        assists: s.assists,
        wins: s.wins,
        shutouts: s.shutouts,
        gamesPlayed: s.games_played
      };
    });

    res.json({
      player: {
        ...player,
        stats
      }
    });

  } catch (error) {
    console.error('Get player error:', error);
    res.status(500).json({ error: 'Failed to get player' });
  }
});

/**
 * GET /api/players/team/:abbrev
 * Get all players for a team
 */
router.get('/team/:abbrev', async (req, res) => {
  try {
    const { abbrev } = req.params;

    const result = await pool.query(`
      SELECT p.*, t.conference, t.is_eliminated
      FROM players p
      JOIN teams t ON p.team_abbrev = t.abbrev
      WHERE p.team_abbrev = $1 AND p.is_active = true
      ORDER BY p.position, p.cost DESC
    `, [abbrev.toUpperCase()]);

    res.json({ players: result.rows });

  } catch (error) {
    console.error('Get team players error:', error);
    res.status(500).json({ error: 'Failed to get team players' });
  }
});

module.exports = router;
