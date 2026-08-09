// routes/pickem.js - Saturday Night Pickem pool
const express = require('express');
const pool = require('../../config/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const nhlScheduleApi = require('../services/nhlScheduleApi');

const router = express.Router();

// Middleware to verify admin (matches convention in routes/admin.js)
const verifyAdmin = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ─────────────────────────────────────────────────────────────
// Weeks & games
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/pickem/weeks
 * List all weeks (for a history/week-picker dropdown)
 */
router.get('/weeks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, week_date, season, is_finalized, tiebreaker_game_id
      FROM pickem_weeks
      ORDER BY week_date DESC
    `);
    res.json({ weeks: result.rows });
  } catch (error) {
    console.error('Get pickem weeks error:', error);
    res.status(500).json({ error: 'Failed to get weeks' });
  }
});

/**
 * GET /api/pickem/weeks/current
 * The most relevant week: the nearest upcoming Saturday if one exists,
 * otherwise the most recently played one.
 */
router.get('/weeks/current', optionalAuth, async (req, res) => {
  try {
    let weekResult = await pool.query(`
      SELECT id, week_date, season, is_finalized, tiebreaker_game_id
      FROM pickem_weeks
      WHERE week_date >= CURRENT_DATE
      ORDER BY week_date ASC LIMIT 1
    `);
    if (weekResult.rows.length === 0) {
      weekResult = await pool.query(`
        SELECT id, week_date, season, is_finalized, tiebreaker_game_id
        FROM pickem_weeks
        ORDER BY week_date DESC LIMIT 1
      `);
    }
    if (weekResult.rows.length === 0) {
      return res.json({ week: null, games: [], tiebreaker: null });
    }

    req.params.weekId = weekResult.rows[0].id;
    return getWeekDetail(req, res, weekResult.rows[0]);
  } catch (error) {
    console.error('Get current pickem week error:', error);
    res.status(500).json({ error: 'Failed to get current week' });
  }
});

/**
 * GET /api/pickem/weeks/:weekId
 * Games for a specific week, plus (if logged in) the caller's own picks
 * and tiebreaker guess. Other users' picks are never included here —
 * that only happens in the group-scoped endpoint, and only once a game locks.
 */
router.get('/weeks/:weekId', optionalAuth, async (req, res) => {
  try {
    const weekResult = await pool.query(`
      SELECT id, week_date, season, is_finalized, tiebreaker_game_id
      FROM pickem_weeks WHERE id = $1
    `, [req.params.weekId]);
    if (weekResult.rows.length === 0) {
      return res.status(404).json({ error: 'Week not found' });
    }
    return getWeekDetail(req, res, weekResult.rows[0]);
  } catch (error) {
    console.error('Get pickem week error:', error);
    res.status(500).json({ error: 'Failed to get week' });
  }
});

async function getWeekDetail(req, res, week) {
  const gamesResult = await pool.query(`
    SELECT id, nhl_game_id, home_team, away_team, start_time, status,
           home_score, away_score, winner, is_tiebreaker_game
    FROM pickem_games
    WHERE week_id = $1
    ORDER BY start_time ASC
  `, [week.id]);

  let myPicks = {};
  let myTiebreaker = null;
  if (req.user) {
    const picksResult = await pool.query(`
      SELECT game_id, picked_team, is_correct FROM pickem_picks
      WHERE user_id = $1 AND game_id = ANY($2::int[])
    `, [req.user.id, gamesResult.rows.map(g => g.id)]);
    picksResult.rows.forEach(p => { myPicks[p.game_id] = p; });

    const tbResult = await pool.query(`
      SELECT guessed_total_goals, actual_total_goals FROM pickem_tiebreakers
      WHERE user_id = $1 AND week_id = $2
    `, [req.user.id, week.id]);
    myTiebreaker = tbResult.rows[0] || null;
  }

  const now = new Date();
  const games = gamesResult.rows.map(g => ({
    ...g,
    locked: now >= new Date(g.start_time),
    myPick: myPicks[g.id]?.picked_team || null,
    myPickCorrect: myPicks[g.id]?.is_correct ?? null
  }));

  res.json({ week, games, myTiebreaker });
}

/**
 * POST /api/pickem/games/:gameId/pick
 * Body: { pickedTeam }
 */
router.post('/games/:gameId/pick', authenticateToken, async (req, res) => {
  try {
    const { pickedTeam } = req.body;
    if (!pickedTeam) {
      return res.status(400).json({ error: 'pickedTeam is required' });
    }

    const gameResult = await pool.query(
      `SELECT id, home_team, away_team, start_time FROM pickem_games WHERE id = $1`,
      [req.params.gameId]
    );
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }
    const game = gameResult.rows[0];

    if (pickedTeam !== game.home_team && pickedTeam !== game.away_team) {
      return res.status(400).json({ error: 'pickedTeam must be one of the two teams playing' });
    }

    if (new Date() >= new Date(game.start_time)) {
      return res.status(403).json({ error: 'Picks are locked for this game — it has already started' });
    }

    await pool.query(`
      INSERT INTO pickem_picks (user_id, game_id, picked_team)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, game_id) DO UPDATE SET picked_team = $3, updated_at = NOW()
    `, [req.user.id, req.params.gameId, pickedTeam]);

    res.json({ message: 'Pick saved' });
  } catch (error) {
    console.error('Save pick error:', error);
    res.status(500).json({ error: 'Failed to save pick' });
  }
});

/**
 * POST /api/pickem/weeks/:weekId/tiebreaker
 * Body: { guessedTotalGoals }
 */
router.post('/weeks/:weekId/tiebreaker', authenticateToken, async (req, res) => {
  try {
    const guessed = parseInt(req.body.guessedTotalGoals, 10);
    if (Number.isNaN(guessed) || guessed < 0) {
      return res.status(400).json({ error: 'guessedTotalGoals must be a non-negative number' });
    }

    const weekResult = await pool.query(
      `SELECT tiebreaker_game_id FROM pickem_weeks WHERE id = $1`,
      [req.params.weekId]
    );
    if (weekResult.rows.length === 0) {
      return res.status(404).json({ error: 'Week not found' });
    }
    const tbGameId = weekResult.rows[0].tiebreaker_game_id;
    if (!tbGameId) {
      return res.status(400).json({ error: 'This week has no games loaded yet' });
    }

    const gameResult = await pool.query(
      `SELECT start_time FROM pickem_games WHERE id = $1`, [tbGameId]
    );
    if (new Date() >= new Date(gameResult.rows[0].start_time)) {
      return res.status(403).json({ error: 'The tiebreaker has locked — the last game of the night has started' });
    }

    await pool.query(`
      INSERT INTO pickem_tiebreakers (user_id, week_id, guessed_total_goals)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, week_id) DO UPDATE SET guessed_total_goals = $3
    `, [req.user.id, req.params.weekId, guessed]);

    res.json({ message: 'Tiebreaker saved' });
  } catch (error) {
    console.error('Save tiebreaker error:', error);
    res.status(500).json({ error: 'Failed to save tiebreaker' });
  }
});

// ─────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/pickem/groups
 * Groups the current user belongs to
 */
router.get('/groups', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.id, g.name, g.description, g.code, g.is_private, g.owner_id, g.created_at,
             u.username as owner_username,
             (SELECT COUNT(*) FROM pickem_group_members WHERE group_id = g.id) as member_count
      FROM pickem_groups g
      JOIN pickem_group_members gm ON g.id = gm.group_id
      JOIN users u ON g.owner_id = u.id
      WHERE gm.user_id = $1
      ORDER BY g.created_at DESC
    `, [req.user.id]);
    res.json({ groups: result.rows });
  } catch (error) {
    console.error('Get pickem groups error:', error);
    res.status(500).json({ error: 'Failed to get groups' });
  }
});

/**
 * GET /api/pickem/groups/public
 * Browse public groups anyone can join
 */
router.get('/groups/public', optionalAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.id, g.name, g.description, g.created_at,
             u.username as owner_username,
             (SELECT COUNT(*) FROM pickem_group_members WHERE group_id = g.id) as member_count
      FROM pickem_groups g
      JOIN users u ON g.owner_id = u.id
      WHERE g.is_private = false
      ORDER BY member_count DESC, g.created_at DESC
    `);
    res.json({ groups: result.rows });
  } catch (error) {
    console.error('Get public pickem groups error:', error);
    res.status(500).json({ error: 'Failed to get public groups' });
  }
});

/**
 * POST /api/pickem/groups
 * Body: { name, description, isPrivate }
 */
router.post('/groups', authenticateToken, async (req, res) => {
  try {
    const { name, description, isPrivate } = req.body;
    if (!name || name.trim().length < 3) {
      return res.status(400).json({ error: 'Group name must be at least 3 characters' });
    }

    let code;
    for (let attempt = 0; attempt < 5; attempt++) {
      code = generateCode();
      const existing = await pool.query('SELECT 1 FROM pickem_groups WHERE code = $1', [code]);
      if (existing.rows.length === 0) break;
    }

    const groupResult = await pool.query(`
      INSERT INTO pickem_groups (name, description, code, is_private, owner_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, description, code, is_private, owner_id, created_at
    `, [name.trim(), description || null, code, isPrivate !== false, req.user.id]);

    const group = groupResult.rows[0];
    await pool.query(`
      INSERT INTO pickem_group_members (group_id, user_id) VALUES ($1, $2)
    `, [group.id, req.user.id]);

    res.status(201).json({ group });
  } catch (error) {
    console.error('Create pickem group error:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

/**
 * POST /api/pickem/groups/join
 * Body: { code }
 */
router.post('/groups/join', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Group code is required' });
    }

    const groupResult = await pool.query(
      'SELECT id, name FROM pickem_groups WHERE UPPER(code) = UPPER($1)', [code]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'No group found with that code' });
    }
    const group = groupResult.rows[0];

    await pool.query(`
      INSERT INTO pickem_group_members (group_id, user_id) VALUES ($1, $2)
      ON CONFLICT (group_id, user_id) DO NOTHING
    `, [group.id, req.user.id]);

    res.json({ message: `Joined ${group.name}`, group });
  } catch (error) {
    console.error('Join pickem group error:', error);
    res.status(500).json({ error: 'Failed to join group' });
  }
});

/**
 * POST /api/pickem/groups/:id/join
 * Join a public group directly (browse-and-join flow)
 */
router.post('/groups/:id/join', authenticateToken, async (req, res) => {
  try {
    const groupResult = await pool.query(
      'SELECT id, name, is_private FROM pickem_groups WHERE id = $1', [req.params.id]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].is_private) {
      return res.status(403).json({ error: 'This group is private — join with its invite code instead' });
    }

    await pool.query(`
      INSERT INTO pickem_group_members (group_id, user_id) VALUES ($1, $2)
      ON CONFLICT (group_id, user_id) DO NOTHING
    `, [req.params.id, req.user.id]);

    res.json({ message: `Joined ${groupResult.rows[0].name}` });
  } catch (error) {
    console.error('Join public pickem group error:', error);
    res.status(500).json({ error: 'Failed to join group' });
  }
});

/**
 * POST /api/pickem/groups/:id/leave
 */
router.post('/groups/:id/leave', authenticateToken, async (req, res) => {
  try {
    const groupResult = await pool.query('SELECT owner_id FROM pickem_groups WHERE id = $1', [req.params.id]);
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].owner_id === req.user.id) {
      return res.status(400).json({ error: 'The group owner can\'t leave — delete the group instead' });
    }
    await pool.query('DELETE FROM pickem_group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Left group' });
  } catch (error) {
    console.error('Leave pickem group error:', error);
    res.status(500).json({ error: 'Failed to leave group' });
  }
});

/**
 * DELETE /api/pickem/groups/:id
 * Owner or admin only
 */
router.delete('/groups/:id', authenticateToken, async (req, res) => {
  try {
    const groupResult = await pool.query('SELECT owner_id FROM pickem_groups WHERE id = $1', [req.params.id]);
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].owner_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Only the group owner can delete this group' });
    }
    await pool.query('DELETE FROM pickem_groups WHERE id = $1', [req.params.id]);
    res.json({ message: 'Group deleted' });
  } catch (error) {
    console.error('Delete pickem group error:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

/**
 * GET /api/pickem/groups/:id
 * Group info + member list
 */
router.get('/groups/:id', authenticateToken, async (req, res) => {
  try {
    const groupResult = await pool.query(`
      SELECT g.*, u.username as owner_username
      FROM pickem_groups g JOIN users u ON g.owner_id = u.id
      WHERE g.id = $1
    `, [req.params.id]);
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const memberCheck = await pool.query(
      'SELECT 1 FROM pickem_group_members WHERE group_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const membersResult = await pool.query(`
      SELECT u.id, u.username, gm.joined_at
      FROM pickem_group_members gm JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = $1
      ORDER BY gm.joined_at ASC
    `, [req.params.id]);

    res.json({ group: groupResult.rows[0], members: membersResult.rows });
  } catch (error) {
    console.error('Get pickem group error:', error);
    res.status(500).json({ error: 'Failed to get group' });
  }
});

/**
 * GET /api/pickem/groups/:id/weeks/:weekId
 * Group-scoped view of a week: every member's pick per game (revealed only
 * for games that have locked) plus that week's standings for the group.
 */
router.get('/groups/:id/weeks/:weekId', authenticateToken, async (req, res) => {
  try {
    const memberCheck = await pool.query(
      'SELECT 1 FROM pickem_group_members WHERE group_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const gamesResult = await pool.query(`
      SELECT id, home_team, away_team, start_time, status, home_score, away_score, winner, is_tiebreaker_game
      FROM pickem_games WHERE week_id = $1 ORDER BY start_time ASC
    `, [req.params.weekId]);

    const now = new Date();
    const games = [];
    for (const g of gamesResult.rows) {
      const locked = now >= new Date(g.start_time);
      let picks = [];
      if (locked) {
        const picksResult = await pool.query(`
          SELECT u.username, pp.picked_team, pp.is_correct
          FROM pickem_picks pp
          JOIN pickem_group_members gm ON gm.user_id = pp.user_id AND gm.group_id = $1
          JOIN users u ON u.id = pp.user_id
          WHERE pp.game_id = $2
          ORDER BY u.username ASC
        `, [req.params.id, g.id]);
        picks = picksResult.rows;
      }
      games.push({ ...g, locked, picks });
    }

    // Weekly standings: correct-pick count per member, tiebreaker guess as the tiebreak.
    const standingsResult = await pool.query(`
      SELECT
        u.id as user_id, u.username,
        COALESCE(COUNT(pp.id) FILTER (WHERE pp.is_correct = true), 0) as correct_picks,
        tb.guessed_total_goals,
        tb.actual_total_goals,
        CASE WHEN tb.actual_total_goals IS NOT NULL
             THEN ABS(tb.guessed_total_goals - tb.actual_total_goals) END as tiebreaker_diff
      FROM pickem_group_members gm
      JOIN users u ON u.id = gm.user_id
      LEFT JOIN pickem_picks pp ON pp.user_id = u.id
        AND pp.game_id IN (SELECT id FROM pickem_games WHERE week_id = $2)
      LEFT JOIN pickem_tiebreakers tb ON tb.user_id = u.id AND tb.week_id = $2
      WHERE gm.group_id = $1
      GROUP BY u.id, u.username, tb.guessed_total_goals, tb.actual_total_goals
      ORDER BY correct_picks DESC, tiebreaker_diff ASC NULLS LAST
    `, [req.params.id, req.params.weekId]);

    res.json({ games, standings: standingsResult.rows });
  } catch (error) {
    console.error('Get group week error:', error);
    res.status(500).json({ error: 'Failed to get group week' });
  }
});

/**
 * GET /api/pickem/groups/:id/standings/season
 * Season-long cumulative standings for the group (sum of correct picks across all weeks).
 */
router.get('/groups/:id/standings/season', authenticateToken, async (req, res) => {
  try {
    const memberCheck = await pool.query(
      'SELECT 1 FROM pickem_group_members WHERE group_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const result = await pool.query(`
      SELECT
        u.id as user_id, u.username,
        COALESCE(COUNT(pp.id) FILTER (WHERE pp.is_correct = true), 0) as total_correct,
        COALESCE(COUNT(pp.id) FILTER (WHERE pp.is_correct IS NOT NULL), 0) as total_graded,
        COUNT(DISTINCT pg.week_id) as weeks_played
      FROM pickem_group_members gm
      JOIN users u ON u.id = gm.user_id
      LEFT JOIN pickem_picks pp ON pp.user_id = u.id
      LEFT JOIN pickem_games pg ON pg.id = pp.game_id
      WHERE gm.group_id = $1
      GROUP BY u.id, u.username
      ORDER BY total_correct DESC
    `, [req.params.id]);

    res.json({ standings: result.rows });
  } catch (error) {
    console.error('Get group season standings error:', error);
    res.status(500).json({ error: 'Failed to get season standings' });
  }
});

// ─────────────────────────────────────────────────────────────
// Global standings (site-wide, mirrors /api/standings for the draft pool)
// ─────────────────────────────────────────────────────────────

router.get('/standings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pickem_leaderboard');
    res.json({ standings: result.rows });
  } catch (error) {
    console.error('Get pickem standings error:', error);
    res.status(500).json({ error: 'Failed to get standings' });
  }
});

// ─────────────────────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/pickem/admin/sync
 * Body: { date } (optional YYYY-MM-DD, defaults to the next Saturday)
 */
router.post('/admin/sync', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    const dateStr = req.body.date || nhlScheduleApi.getNextSaturday();
    const season = process.env.NHL_SEASON || '20252026';
    const result = await nhlScheduleApi.syncWeek(dateStr, season);
    res.json({ message: `Synced ${dateStr}`, ...result });
  } catch (error) {
    console.error('Admin pickem sync error:', error);
    res.status(500).json({ error: 'Sync failed: ' + error.message });
  }
});

/**
 * PATCH /api/pickem/admin/games/:gameId
 * Manual override for a game — status, scores. If status is set to 'final',
 * picks and the tiebreaker (if this is the tiebreaker game) get graded immediately.
 * Body: { status, homeScore, awayScore }
 */
router.patch('/admin/games/:gameId', authenticateToken, verifyAdmin, async (req, res) => {
  try {
    const { status, homeScore, awayScore } = req.body;
    const validStatuses = ['scheduled', 'live', 'final', 'postponed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const gameResult = await pool.query('SELECT * FROM pickem_games WHERE id = $1', [req.params.gameId]);
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }
    const game = gameResult.rows[0];

    const newStatus = status || game.status;
    const newHome = homeScore !== undefined ? homeScore : game.home_score;
    const newAway = awayScore !== undefined ? awayScore : game.away_score;
    let winner = game.winner;
    if (newStatus === 'final' && newHome != null && newAway != null) {
      winner = newHome > newAway ? game.home_team : game.away_team;
    }

    await pool.query(`
      UPDATE pickem_games
      SET status = $1, home_score = $2, away_score = $3, winner = $4,
          graded_at = CASE WHEN $1 = 'final' AND graded_at IS NULL THEN NOW() ELSE graded_at END,
          updated_at = NOW()
      WHERE id = $5
    `, [newStatus, newHome, newAway, winner, req.params.gameId]);

    await nhlScheduleApi.gradePicks(game.week_id);

    res.json({ message: 'Game updated' });
  } catch (error) {
    console.error('Admin game override error:', error);
    res.status(500).json({ error: 'Failed to update game' });
  }
});

module.exports = router;
