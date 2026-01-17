const express = require('express');
const pool = require('../../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * Generate random group code
 */
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * GET /api/groups
 * Get user's groups
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        g.id, g.name, g.description, g.code, g.is_private, 
        g.owner_id, g.blast_message, g.created_at,
        u.username as owner_username,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM groups g
      JOIN group_members gm ON g.id = gm.group_id
      JOIN users u ON g.owner_id = u.id
      WHERE gm.user_id = $1
      ORDER BY g.created_at DESC
    `, [req.user.id]);

    res.json({ groups: result.rows });

  } catch (error) {
    console.error('Get groups error:', error);
    res.status(500).json({ error: 'Failed to get groups' });
  }
});

/**
 * GET /api/groups/:id
 * Get group details with members and leaderboard
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Get group
    const groupResult = await pool.query(`
      SELECT g.*, u.username as owner_username
      FROM groups g
      JOIN users u ON g.owner_id = u.id
      WHERE g.id = $1
    `, [id]);

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const group = groupResult.rows[0];

    // Check if user is member
    const memberCheck = await pool.query(`
      SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [id, req.user.id]);

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Get members with their scores
    const membersResult = await pool.query(`
      SELECT 
        u.id, u.username,
        COALESCE(lb.total_points, 0) as total_points,
        COALESCE(lb.r1_points, 0) as r1_points,
        COALESCE(lb.r2_points, 0) as r2_points,
        COALESCE(lb.r3_points, 0) as r3_points
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      LEFT JOIN leaderboard lb ON u.id = lb.user_id
      WHERE gm.group_id = $1
      ORDER BY total_points DESC
    `, [id]);

    // Add ranks
    const members = membersResult.rows.map((m, i) => ({
      ...m,
      rank: i + 1
    }));

    // Get recent chat messages
    const chatResult = await pool.query(`
      SELECT cm.id, cm.message, cm.created_at, u.id as user_id, u.username
      FROM chat_messages cm
      JOIN users u ON cm.user_id = u.id
      WHERE cm.group_id = $1
      ORDER BY cm.created_at DESC
      LIMIT 50
    `, [id]);

    res.json({
      group,
      members,
      chat: chatResult.rows.reverse()
    });

  } catch (error) {
    console.error('Get group error:', error);
    res.status(500).json({ error: 'Failed to get group' });
  }
});

/**
 * POST /api/groups
 * Create new group
 */
router.post('/', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { name, description, isPrivate } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    await client.query('BEGIN');

    // Generate unique code
    let code;
    let codeExists = true;
    while (codeExists) {
      code = generateCode();
      const check = await client.query('SELECT 1 FROM groups WHERE code = $1', [code]);
      codeExists = check.rows.length > 0;
    }

    // Create group
    const result = await client.query(`
      INSERT INTO groups (name, description, code, is_private, owner_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name.trim(), description || null, code, isPrivate || false, req.user.id]);

    const group = result.rows[0];

    // Add owner as member
    await client.query(`
      INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)
    `, [group.id, req.user.id]);

    await client.query('COMMIT');

    res.status(201).json({ group });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create group error:', error);
    res.status(500).json({ error: 'Failed to create group' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/groups/join
 * Join group by code
 */
router.post('/join', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Group code is required' });
    }

    // Find group
    const groupResult = await pool.query(`
      SELECT id, name FROM groups WHERE UPPER(code) = UPPER($1)
    `, [code]);

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid group code' });
    }

    const group = groupResult.rows[0];

    // Check if already member
    const memberCheck = await pool.query(`
      SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [group.id, req.user.id]);

    if (memberCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Already a member of this group' });
    }

    // Add as member
    await pool.query(`
      INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)
    `, [group.id, req.user.id]);

    res.json({ message: `Joined ${group.name}!`, groupId: group.id });

  } catch (error) {
    console.error('Join group error:', error);
    res.status(500).json({ error: 'Failed to join group' });
  }
});

/**
 * POST /api/groups/:id/leave
 * Leave group
 */
router.post('/:id/leave', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if owner
    const groupResult = await pool.query(`
      SELECT owner_id FROM groups WHERE id = $1
    `, [id]);

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupResult.rows[0].owner_id === req.user.id) {
      return res.status(400).json({ error: 'Owner cannot leave. Delete the group instead.' });
    }

    await pool.query(`
      DELETE FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [id, req.user.id]);

    res.json({ message: 'Left group' });

  } catch (error) {
    console.error('Leave group error:', error);
    res.status(500).json({ error: 'Failed to leave group' });
  }
});

/**
 * PUT /api/groups/:id/blast
 * Update blast message (owner only)
 */
router.put('/:id/blast', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    const result = await pool.query(`
      UPDATE groups SET blast_message = $1
      WHERE id = $2 AND owner_id = $3
      RETURNING id
    `, [message || null, id, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    res.json({ message: 'Blast updated' });

  } catch (error) {
    console.error('Update blast error:', error);
    res.status(500).json({ error: 'Failed to update blast' });
  }
});

/**
 * DELETE /api/groups/:id
 * Delete group (owner only)
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      DELETE FROM groups WHERE id = $1 AND owner_id = $2 RETURNING id
    `, [id, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    res.json({ message: 'Group deleted' });

  } catch (error) {
    console.error('Delete group error:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

/**
 * POST /api/groups/:id/chat
 * Send chat message
 */
router.post('/:id/chat', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check membership
    const memberCheck = await pool.query(`
      SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [id, req.user.id]);

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const result = await pool.query(`
      INSERT INTO chat_messages (group_id, user_id, message)
      VALUES ($1, $2, $3)
      RETURNING id, created_at
    `, [id, req.user.id, message.trim()]);

    res.status(201).json({
      id: result.rows[0].id,
      userId: req.user.id,
      username: req.user.username,
      message: message.trim(),
      createdAt: result.rows[0].created_at
    });

  } catch (error) {
    console.error('Send chat error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
