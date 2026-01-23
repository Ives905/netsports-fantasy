// routes/rosters.js - Updated to use rounds table for lock dates
const express = require(‘express’);
const pool = require(’../../config/database’);
const { authenticateToken } = require(’../middleware/auth’);

const router = express.Router();
const SALARY_CAP = 30;

/**

- GET /api/rosters
- Get current user’s rosters for all rounds
  */
  router.get(’/’, authenticateToken, async (req, res) => {
  try {
  const rosters = {};
  
  for (const round of [1, 2, 3]) {
  const rosterResult = await pool.query(`SELECT r.id, r.round, r.is_submitted, r.submitted_at FROM rosters r WHERE r.user_id = $1 AND r.round = $2`, [req.user.id, round]);
  
  if (rosterResult.rows.length > 0) {
  const roster = rosterResult.rows[0];
  
  ```
   // Get players in roster
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
  
   // Organize by conference and position
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
     id: roster.id,
     isSubmitted: roster.is_submitted,
     submittedAt: roster.submitted_at,
     selections: organized,
     stars
   };
  ```
  
  } else {
  rosters[round] = {
  id: null,
  isSubmitted: false,
  selections: {
  western: { forwards: [], defense: [], goalies: [] },
  eastern: { forwards: [], defense: [], goalies: [] }
  },
  stars: { forward: null, defense: null, goalie: null }
  };
  }
  }
  
  // Get tiebreakers
  const tiebreakersResult = await pool.query(`SELECT round, question1_answer, question2_answer FROM tiebreakers WHERE user_id = $1`, [req.user.id]);
  
  const tiebreakers = {};
  tiebreakersResult.rows.forEach(t => {
  tiebreakers[t.round] = {
  q1: t.question1_answer,
  q2: t.question2_answer
  };
  });
  
  res.json({ rosters, tiebreakers });

} catch (error) {
console.error(‘Get rosters error:’, error);
res.status(500).json({ error: ‘Failed to get rosters’ });
}
});

/**

- PUT /api/rosters/:round
- Save roster for a specific round
  */
  router.put(’/:round’, authenticateToken, async (req, res) => {
  const client = await pool.connect();

try {
const round = parseInt(req.params.round);
const { selections, stars, tiebreakers } = req.body;

```
if (round < 1 || round > 3) {
  return res.status(400).json({ error: 'Invalid round' });
}

// Check if round is locked using rounds table
const lockResult = await pool.query(`
  SELECT pick_deadline FROM rounds WHERE round_number = $1
`, [round]);

if (lockResult.rows.length === 0 || !lockResult.rows[0].pick_deadline) {
  return res.status(400).json({ error: 'Pick deadline not set for this round' });
}

const lockDate = new Date(lockResult.rows[0].pick_deadline);

if (new Date() > lockDate) {
  return res.status(403).json({ error: 'This round is locked' });
}

await client.query('BEGIN');

// Get or create roster
let rosterResult = await client.query(`
  SELECT id FROM rosters WHERE user_id = $1 AND round = $2
`, [req.user.id, round]);

let rosterId;
if (rosterResult.rows.length === 0) {
  const insertResult = await client.query(`
    INSERT INTO rosters (user_id, round) VALUES ($1, $2) RETURNING id
  `, [req.user.id, round]);
  rosterId = insertResult.rows[0].id;
} else {
  rosterId = rosterResult.rows[0].id;
}

// Clear existing roster players
await client.query('DELETE FROM roster_players WHERE roster_id = $1', [rosterId]);

// Collect all player IDs
const playerIds = [];
for (const conf of ['western', 'eastern']) {
  for (const pos of ['forwards', 'defense', 'goalies']) {
    if (selections[conf]?.[pos]) {
      playerIds.push(...selections[conf][pos]);
    }
  }
}

// Validate salary cap
if (playerIds.length > 0) {
  const salaryResult = await client.query(`
    SELECT COALESCE(SUM(cost), 0) as total FROM players WHERE id = ANY($1)
  `, [playerIds]);
  
  if (salaryResult.rows[0].total > SALARY_CAP) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: 'Roster exceeds salary cap' });
  }

  // Validate players are from qualified teams for this round
  const qualifiedResult = await client.query(`
    SELECT COUNT(*) as invalid_count
    FROM players p
    WHERE p.id = ANY($1)
    AND p.team_abbrev NOT IN (
      SELECT team_abbrev 
      FROM team_qualifications 
      WHERE round_number = $2 AND qualified = true
    )
  `, [playerIds, round]);

  if (qualifiedResult.rows[0].invalid_count > 0) {
    await client.query('ROLLBACK');
    return res.status(400).json({ 
      error: 'Roster contains players from teams not qualified for this round' 
    });
  }
}

// Insert roster players
for (const playerId of playerIds) {
  const isStar = Object.values(stars || {}).includes(playerId);
  await client.query(`
    INSERT INTO roster_players (roster_id, player_id, is_star)
    VALUES ($1, $2, $3)
  `, [rosterId, playerId, isStar]);
}

// Save tiebreakers
if (tiebreakers) {
  await client.query(`
    INSERT INTO tiebreakers (user_id, round, question1_answer, question2_answer)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, round) DO UPDATE SET
      question1_answer = $3,
      question2_answer = $4
  `, [req.user.id, round, tiebreakers.q1 || null, tiebreakers.q2 || null]);
}

await client.query('COMMIT');

res.json({ message: 'Roster saved', rosterId });
```

} catch (error) {
await client.query(‘ROLLBACK’);
console.error(‘Save roster error:’, error);
res.status(500).json({ error: ‘Failed to save roster’ });
} finally {
client.release();
}
});

/**

- POST /api/rosters/:round/submit
- Submit roster for a round (locks it in)
  */
  router.post(’/:round/submit’, authenticateToken, async (req, res) => {
  try {
  const round = parseInt(req.params.round);
  
  // Check if locked using rounds table
  const lockResult = await pool.query(`SELECT pick_deadline FROM rounds WHERE round_number = $1`, [round]);
  
  if (lockResult.rows.length === 0 || !lockResult.rows[0].pick_deadline) {
  return res.status(400).json({ error: ‘Pick deadline not set for this round’ });
  }
  
  const lockDate = new Date(lockResult.rows[0].pick_deadline);
  
  if (new Date() > lockDate) {
  return res.status(403).json({ error: ‘This round is locked’ });
  }
  
  // Get roster
  const rosterResult = await pool.query(`SELECT id FROM rosters WHERE user_id = $1 AND round = $2`, [req.user.id, round]);
  
  if (rosterResult.rows.length === 0) {
  return res.status(400).json({ error: ‘No roster found for this round’ });
  }
  
  const rosterId = rosterResult.rows[0].id;
  
  // Validate roster completeness
  const playersResult = await pool.query(`SELECT p.position, t.conference, rp.is_star FROM roster_players rp JOIN players p ON rp.player_id = p.id JOIN teams t ON p.team_abbrev = t.abbrev WHERE rp.roster_id = $1`, [rosterId]);
  
  const counts = {
  western: { forward: 0, defense: 0, goalie: 0 },
  eastern: { forward: 0, defense: 0, goalie: 0 }
  };
  let starCount = 0;
  
  playersResult.rows.forEach(p => {
  counts[p.conference][p.position]++;
  if (p.is_star) starCount++;
  });
  
  // Check requirements: 3F, 2D, 1G per conference, 3 stars
  const isComplete =
  counts.western.forward === 3 && counts.western.defense === 2 && counts.western.goalie === 1 &&
  counts.eastern.forward === 3 && counts.eastern.defense === 2 && counts.eastern.goalie === 1 &&
  starCount === 3;
  
  if (!isComplete) {
  return res.status(400).json({
  error: ‘Roster incomplete. Need 3F/2D/1G per conference and 3 star players.’,
  counts,
  starCount
  });
  }
  
  // Submit roster
  await pool.query(`UPDATE rosters SET is_submitted = true, submitted_at = NOW() WHERE id = $1`, [rosterId]);
  
  res.json({ message: ‘Roster submitted successfully’ });

} catch (error) {
console.error(‘Submit roster error:’, error);
res.status(500).json({ error: ‘Failed to submit roster’ });
}
});

/**

- GET /api/rosters/user/:userId/round/:round
- Get a specific user’s roster for a specific round (read-only)
- Anyone can view submitted rosters
  */
  router.get(’/user/:userId/round/:round’, authenticateToken, async (req, res) => {
  try {
  const userId = parseInt(req.params.userId);
  const round = parseInt(req.params.round);
  
  if (!userId || !round || round < 0 || round > 3) {
  return res.status(400).json({ error: ‘Invalid user ID or round’ });
  }
  
  // Get user info
  const userResult = await pool.query(
  ‘SELECT id, username FROM users WHERE id = $1’,
  [userId]
  );
  
  if (userResult.rows.length === 0) {
  return res.status(404).json({ error: ‘User not found’ });
  }
  
  const user = userResult.rows[0];
  
  // Get roster
  const rosterResult = await pool.query(`SELECT r.id, r.round, r.is_submitted, r.submitted_at FROM rosters r WHERE r.user_id = $1 AND r.round = $2`, [userId, round]);
  
  if (rosterResult.rows.length === 0) {
  return res.json({
  user,
  round,
  roster: null,
  message: ‘No roster found for this round’
  });
  }
  
  const roster = rosterResult.rows[0];
  
  // Get players with full details
  const playersResult = await pool.query(`SELECT  p.id, p.name, p.team_abbrev as team, p.position, p.cost, p.nhl_id, t.conference, rp.is_star, p.goals_reg, p.assists_reg, p.wins_reg, p.shutouts_reg, p.goals_playoff, p.assists_playoff, p.wins_playoff, p.shutouts_playoff FROM roster_players rp JOIN players p ON rp.player_id = p.id JOIN teams t ON p.team_abbrev = t.abbrev WHERE rp.roster_id = $1 ORDER BY t.conference, p.position, p.name`, [roster.id]);
  
  // Organize by conference and position
  const organized = {
  western: { forwards: [], defense: [], goalies: [] },
  eastern: { forwards: [], defense: [], goalies: [] }
  };
  const stars = { forward: null, defense: null, goalie: null };
  
  playersResult.rows.forEach(player => {
  const posKey = player.position === ‘forward’ ? ‘forwards’ :
  player.position === ‘defense’ ? ‘defense’ : ‘goalies’;
  organized[player.conference][posKey].push(player);
  
  if (player.is_star) {
  stars[player.position] = player.id;
  }
  });
  
  // Get tiebreaker answers
  const tiebreakerResult = await pool.query(`SELECT question_1, question_2 FROM tiebreakers WHERE user_id = $1 AND round = $2`, [userId, round]);
  
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
console.error(‘Get user roster error:’, error);
res.status(500).json({ error: ‘Failed to get user roster’ });
}
});

module.exports = router;