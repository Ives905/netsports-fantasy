const express = require('express');
const pool = require('../../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
const SALARY_CAP = 30;

router.get('/', authenticateToken, async (req, res) => {
  try {
    const rosters = {};
    for (const round of [1, 2, 3]) {
      const rosterResult = await pool.query(`
        SELECT r.id, r.round, r.is_submitted, r.submitted_at
        FROM rosters r
        WHERE r.user_id = $1 AND r.round = $2
      `, [req.user.id, round]);
      if (rosterResult.rows.length > 0) {
        const roster = rosterResult.rows[0];
        const playersResult = await pool.query(`
          SELECT 
            p.id, p.name, p.team_abbrev as team, p.position, p.cost,
            t.conference,
            rp.is_star
          FROM roster_players rp
          JOIN players p ON rp.player_id = p.id
          JOIN teams t ON p.team_abbrev = t.abbrev
          WHERE rp.roster_id = $1
        `, [roster.id]);
        const organized = {
          western: { forwards: [], defense: [], goalies: [] },
          eastern: { forwards: [], defense: [], goalies: [] }
        };
        const stars = { forward: null, defense: null, goalie: null };
        playersResult.rows.forEach(player => {
          const posKey = player.position === 'forward' ? 'forwards' : 
                         player.position === 'defense' ? 'defense' : 'goalies';
          organized[player.conference][posKey].push(player.id);
          if (player.is_star) {
            stars[player.position] = player.id;
          }
        });
        rosters[round] = {
          ...roster,
          selections: organized,
          stars
        };
      } else {
        rosters[round] = null;
      }
    }
    res.json({ rosters });
  } catch (error) {
    console.error('Get rosters error:', error);
    res.status(500).json({ error: 'Failed to get rosters' });
  }
});

router.put('/:round', authenticateToken, async (req, res) => {
  try {
    const round = parseInt(req.params.round);
    const { selections, stars, tiebreakers } = req.body;
    if (round < 1 || round > 3) {
      return res.status(400).json({ error: 'Invalid round' });
    }
    const roundResult = await pool.query('SELECT pick_deadline FROM rounds WHERE round_number = $1', [round]);
    if (roundResult.rows.length === 0 || !roundResult.rows[0].pick_deadline) {
      return res.status(400).json({ error: 'Round deadline not set' });
    }
    if (new Date() > new Date(roundResult.rows[0].pick_deadline)) {
      return res.status(400).json({ error: 'Round is locked' });
    }
    let rosterId;
    const existingRoster = await pool.query('SELECT id, is_submitted FROM rosters WHERE user_id = $1 AND round = $2', [req.user.id, round]);
    if (existingRoster.rows.length > 0) {
      if (existingRoster.rows[0].is_submitted) {
        return res.status(400).json({ error: 'Roster already submitted' });
      }
      rosterId = existingRoster.rows[0].id;
      await pool.query('DELETE FROM roster_players WHERE roster_id = $1', [rosterId]);
    } else {
      const newRoster = await pool.query('INSERT INTO rosters (user_id, round) VALUES ($1, $2) RETURNING id', [req.user.id, round]);
      rosterId = newRoster.rows[0].id;
    }
    const allPlayers = [];
    ['western', 'eastern'].forEach(conf => {
      if (selections[conf]) {
        ['forwards', 'defense', 'goalies'].forEach(pos => {
          if (selections[conf][pos]) {
            allPlayers.push(...selections[conf][pos]);
          }
        });
      }
    });
    if (allPlayers.length === 0) {
      return res.json({ message: 'Roster saved (empty)' });
    }
    const playerData = await pool.query(`
      SELECT p.id, p.cost, p.position, t.conference
      FROM players p
      JOIN teams t ON p.team_abbrev = t.abbrev
      WHERE p.id = ANY($1::int[])
    `, [allPlayers]);
    const totalCost = playerData.rows.reduce((sum, p) => sum + parseFloat(p.cost), 0);
    if (totalCost > SALARY_CAP) {
      return res.status(400).json({ error: 'Over salary cap' });
    }
    for (const player of playerData.rows) {
      const isStar = stars.forward === player.id || stars.defense === player.id || stars.goalie === player.id;
      await pool.query('INSERT INTO roster_players (roster_id, player_id, is_star) VALUES ($1, $2, $3)', [rosterId, player.id, isStar]);
    }
    if (tiebreakers) {
      await pool.query(`
        INSERT INTO tiebreakers (user_id, round, question_1, question_2)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, round) DO UPDATE
        SET question_1 = $3, question_2 = $4
      `, [req.user.id, round, tiebreakers.q1, tiebreakers.q2]);
    }
    res.json({ message: 'Roster saved successfully' });
  } catch (error) {
    console.error('Save roster error:', error);
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Invalid player selection - one or more players not found' });
    }
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Duplicate player detected' });
    }
    res.status(500).json({ error: error.message || 'Failed to save roster. Please try again.' });
  }
});

router.post('/:round/submit', authenticateToken, async (req, res) => {
  try {
    const round = parseInt(req.params.round);
    if (round < 1 || round > 3) {
      return res.status(400).json({ error: 'Invalid round' });
    }
    const roundResult = await pool.query('SELECT pick_deadline FROM rounds WHERE round_number = $1', [round]);
    if (roundResult.rows.length === 0 || !roundResult.rows[0].pick_deadline) {
      return res.status(400).json({ error: 'Round deadline not set' });
    }
    if (new Date() > new Date(roundResult.rows[0].pick_deadline)) {
      return res.status(400).json({ error: 'Round is locked' });
    }
    const rosterResult = await pool.query('SELECT id, is_submitted FROM rosters WHERE user_id = $1 AND round = $2', [req.user.id, round]);
    if (rosterResult.rows.length === 0) {
      return res.status(400).json({ error: 'No roster found' });
    }
    if (rosterResult.rows[0].is_submitted) {
      return res.status(400).json({ error: 'Already submitted' });
    }
    const rosterId = rosterResult.rows[0].id;
    const playersResult = await pool.query(`
      SELECT p.position, t.conference, rp.is_star
      FROM roster_players rp
      JOIN players p ON rp.player_id = p.id
      JOIN teams t ON p.team_abbrev = t.abbrev
      WHERE rp.roster_id = $1
    `, [rosterId]);
    const counts = {
      western: { forward: 0, defense: 0, goalie: 0 },
      eastern: { forward: 0, defense: 0, goalie: 0 }
    };
    let starCount = 0;
    playersResult.rows.forEach(p => {
      counts[p.conference][p.position]++;
      if (p.is_star) starCount++;
    });
    const isComplete =
      counts.western.forward === 3 && counts.western.defense === 2 && counts.western.goalie === 1 &&
      counts.eastern.forward === 3 && counts.eastern.defense === 2 && counts.eastern.goalie === 1 &&
      starCount === 3;
    if (!isComplete) {
      return res.status(400).json({ 
        error: 'Roster incomplete. Need 3F/2D/1G per conference and 3 star players.',
        counts,
        starCount
      });
    }
    await pool.query('UPDATE rosters SET is_submitted = true, submitted_at = NOW() WHERE id = $1', [rosterId]);
    res.json({ message: 'Roster submitted successfully' });
  } catch (error) {
    console.error('Submit roster error:', error);
    res.status(500).json({ error: 'Failed to submit roster' });
  }
});

router.get('/user/:userId/round/:round', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const round = parseInt(req.params.round);
    if (!userId || !round || round < 0 || round > 3) {
      return res.status(400).json({ error: 'Invalid user ID or round' });
    }
    const userResult = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];
    const rosterResult = await pool.query(`
      SELECT r.id, r.round, r.is_submitted, r.submitted_at
      FROM rosters r
      WHERE r.user_id = $1 AND r.round = $2
    `, [userId, round]);
    if (rosterResult.rows.length === 0) {
      return res.json({ user, round, roster: null, message: 'No roster found for this round' });
    }
    const roster = rosterResult.rows[0];
    const playersResult = await pool.query(`
      SELECT 
        p.id, p.name, p.team_abbrev as team, p.position, p.cost, p.nhl_id,
        t.conference,
        rp.is_star,
        p.goals_reg, p.assists_reg, p.wins_reg, p.shutouts_reg,
        p.goals_playoff, p.assists_playoff, p.wins_playoff, p.shutouts_playoff
      FROM roster_players rp
      JOIN players p ON rp.player_id = p.id
      JOIN teams t ON p.team_abbrev = t.abbrev
      WHERE rp.roster_id = $1
      ORDER BY t.conference, p.position, p.name
    `, [roster.id]);
    const organized = {
      western: { forwards: [], defense: [], goalies: [] },
      eastern: { forwards: [], defense: [], goalies: [] }
    };
    const stars = { forward: null, defense: null, goalie: null };
    playersResult.rows.forEach(player => {
      const posKey = player.position === 'forward' ? 'forwards' : 
                     player.position === 'defense' ? 'defense' : 'goalies';
      organized[player.conference][posKey].push(player);
      if (player.is_star) {
        stars[player.position] = player.id;
      }
    });
    const tiebreakerResult = await pool.query(`
      SELECT question_1, question_2
      FROM tiebreakers
      WHERE user_id = $1 AND round = $2
    `, [userId, round]);
    const tiebreakers = tiebreakerResult.rows[0] || { question_1: null, question_2: null };
    res.json({
      user,
      round,
      roster: {
        id: roster.id,
        isSubmitted: roster.is_submitted,
        submittedAt: roster.submitted_at,
        selections: organized,
        stars,
        players: playersResult.rows
      },
      tiebreakers
    });
  } catch (error) {
    console.error('Get user roster error:', error);
    res.status(500).json({ error: 'Failed to get user roster' });
  }
});

module.exports = router;
