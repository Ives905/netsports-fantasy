// routes/admin.js - Complete admin routes
const express = require(‘express’);
const pool = require(’../../config/database’);
const { authenticateToken } = require(’../middleware/auth’);

const router = express.Router();

// Middleware to verify admin
const verifyAdmin = async (req, res, next) => {
if (!req.user || !req.user.isAdmin) {
return res.status(403).json({ error: ‘Admin access required’ });
}
next();
};

// GET /api/admin/rounds - Get all rounds with deadlines
router.get(’/rounds’, authenticateToken, verifyAdmin, async (req, res) => {
try {
const roundsResult = await pool.query(`SELECT  id, round_number, name, pick_deadline,  start_date, end_date, is_active, created_at, updated_at FROM rounds ORDER BY round_number`);

```
const rounds = await Promise.all(roundsResult.rows.map(async (round) => {
  const teamsResult = await pool.query(`
    SELECT tq.team_abbrev, t.name as team_name, tq.qualified
    FROM team_qualifications tq
    JOIN teams t ON tq.team_abbrev = t.abbrev
    WHERE tq.round_number = $1
    ORDER BY t.name
  `, [round.round_number]);

  return {
    ...round,
    qualifiedTeams: teamsResult.rows
  };
}));

res.json({ rounds });
```

} catch (error) {
console.error(‘Error fetching rounds:’, error);
res.status(500).json({ error: ‘Failed to fetch rounds’ });
}
});

// PUT /api/admin/rounds/:roundNumber/deadline - Update pick deadline
router.put(’/rounds/:roundNumber/deadline’, authenticateToken, verifyAdmin, async (req, res) => {
try {
const roundNumber = parseInt(req.params.roundNumber);
const { pick_deadline } = req.body;

```
if (roundNumber < 0 || roundNumber > 3) {
  return res.status(400).json({ error: 'Invalid round number (must be 0-3)' });
}

if (!pick_deadline) {
  return res.status(400).json({ error: 'Pick deadline is required' });
}

const result = await pool.query(`
  UPDATE rounds
  SET pick_deadline = $1, updated_at = NOW()
  WHERE round_number = $2
  RETURNING id, round_number, name, pick_deadline
`, [pick_deadline, roundNumber]);

if (result.rows.length === 0) {
  return res.status(404).json({ error: 'Round not found' });
}

res.json({
  message: 'Pick deadline updated successfully',
  round: result.rows[0]
});
```

} catch (error) {
console.error(‘Error updating pick deadline:’, error);
res.status(500).json({ error: ‘Failed to update pick deadline’ });
}
});

// PUT /api/admin/rounds/:roundNumber/end-date - Update scoring end date
router.put(’/rounds/:roundNumber/end-date’, authenticateToken, verifyAdmin, async (req, res) => {
try {
const roundNumber = parseInt(req.params.roundNumber);
const { end_date } = req.body;

```
if (roundNumber < 0 || roundNumber > 3) {
  return res.status(400).json({ error: 'Invalid round number (must be 0-3)' });
}

if (!end_date) {
  return res.status(400).json({ error: 'End date is required' });
}

const result = await pool.query(`
  UPDATE rounds
  SET end_date = $1, updated_at = NOW()
  WHERE round_number = $2
  RETURNING id, round_number, name, end_date
`, [end_date, roundNumber]);

if (result.rows.length === 0) {
  return res.status(404).json({ error: 'Round not found' });
}

res.json({
  message: 'End date updated successfully',
  round: result.rows[0]
});
```

} catch (error) {
console.error(‘Error updating end date:’, error);
res.status(500).json({ error: ‘Failed to update end date’ });
}
});

// GET /api/admin/teams - Get all teams for qualification management
router.get(’/teams’, authenticateToken, verifyAdmin, async (req, res) => {
try {
const teamsResult = await pool.query(`SELECT abbrev, name, conference FROM teams ORDER BY name`);

```
res.json({ teams: teamsResult.rows });
```

} catch (error) {
console.error(‘Error fetching teams:’, error);
res.status(500).json({ error: ‘Failed to fetch teams’ });
}
});

// POST /api/admin/rounds/:roundNumber/qualified-teams - Set qualified teams for a round
router.post(’/rounds/:roundNumber/qualified-teams’, authenticateToken, verifyAdmin, async (req, res) => {
const client = await pool.connect();

try {
const roundNumber = parseInt(req.params.roundNumber);
const { teams } = req.body; // Array of team abbreviations

```
if (roundNumber < 0 || roundNumber > 3) {
  return res.status(400).json({ error: 'Invalid round number (must be 0-3)' });
}

if (!Array.isArray(teams)) {
  return res.status(400).json({ error: 'Teams must be an array' });
}

// Validate team count based on round
const maxTeams = roundNumber === 0 ? 32 : roundNumber === 1 ? 16 : roundNumber === 2 ? 8 : 4;
if (teams.length !== maxTeams) {
  return res.status(400).json({ 
    error: `Round ${roundNumber} requires exactly ${maxTeams} teams (you provided ${teams.length})` 
  });
}

await client.query('BEGIN');

// Clear existing qualifications for this round
await client.query(`
  DELETE FROM team_qualifications WHERE round_number = $1
`, [roundNumber]);

// Insert new qualifications
if (teams.length > 0) {
  const values = teams.map((team, idx) => 
    `($${idx * 2 + 1}, $${idx * 2 + 2}, true)`
  ).join(',');

  const params = teams.flatMap(team => [roundNumber, team]);

  await client.query(`
    INSERT INTO team_qualifications (round_number, team_abbrev, qualified)
    VALUES ${values}
  `, params);
}

await client.query('COMMIT');

res.json({
  message: `Successfully set ${teams.length} qualified teams for round ${roundNumber}`,
  roundNumber,
  count: teams.length
});
```

} catch (error) {
await client.query(‘ROLLBACK’);
console.error(‘Error updating qualified teams:’, error);
res.status(500).json({ error: ‘Failed to update qualified teams’ });
} finally {
client.release();
}
});

// GET /api/admin/settings - Get all admin settings
router.get(’/settings’, authenticateToken, verifyAdmin, async (req, res) => {
try {
// Get current round and other settings
const settingsResult = await pool.query(`SELECT key, value FROM settings`);

```
const settings = {};
settingsResult.rows.forEach(row => {
  settings[row.key] = row.value;
});

// Get rounds with deadlines
const roundsResult = await pool.query(`
  SELECT round_number, pick_deadline
  FROM rounds
  ORDER BY round_number
`);

const pickDeadlines = {};
roundsResult.rows.forEach(round => {
  pickDeadlines[round.round_number] = round.pick_deadline;
});

res.json({
  ...settings,
  pickDeadlines
});
```

} catch (error) {
console.error(‘Error fetching admin settings:’, error);
res.status(500).json({ error: ‘Failed to fetch settings’ });
}
});

module.exports = router;