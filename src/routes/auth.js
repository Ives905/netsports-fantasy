const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../../config/database');
const { generateToken, authenticateToken } = require('../middleware/auth');
const { sendVerificationEmail } = require('../services/email');

const router = express.Router();
const SALT_ROUNDS = 10;

/**
 * POST /api/auth/register
 * Create new user account
 */
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }

    // Check if username exists
    const usernameCheck = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (usernameCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    // Check if email exists
    const emailCheck = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Generate verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Create user
    const result = await pool.query(`
      INSERT INTO users (username, email, password_hash, verification_code, is_admin)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, username, email, is_verified, is_admin, created_at
    `, [username, email.toLowerCase(), passwordHash, verificationCode, email.toLowerCase() === process.env.ADMIN_EMAIL?.toLowerCase()]);

    const user = result.rows[0];

    // Send verification email
    const emailSent = await sendVerificationEmail(user.email, verificationCode, user.username);

    res.status(201).json({
      message: 'Account created. Please check your email for the verification code.',
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      },
      // In development, return the code for easier testing
      verificationCode: process.env.NODE_ENV === 'development' ? verificationCode : undefined,
      // Indicate if email was sent successfully (for debugging)
      emailSent: emailSent
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

/**
 * POST /api/auth/verify
 * Verify email with code
 */
router.post('/verify', async (req, res) => {
  try {
    const { email, code } = req.body;

    const result = await pool.query(`
      UPDATE users 
      SET is_verified = true, verification_code = null
      WHERE LOWER(email) = LOWER($1) AND verification_code = $2
      RETURNING id, username, email, is_verified, is_admin
    `, [email, code]);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    const user = result.rows[0];
    const token = generateToken(user);

    res.json({
      message: 'Email verified successfully',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.is_admin
      }
    });

  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

/**
 * POST /api/auth/login
 * Login with username/email and password
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username/email and password required' });
    }

    // Find user by username or email
    const result = await pool.query(`
      SELECT id, username, email, password_hash, is_verified, is_admin
      FROM users 
      WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
    `, [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if verified
    if (!user.is_verified) {
      return res.status(403).json({ error: 'Please verify your email first' });
    }

    // Generate token
    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.is_admin
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, email, is_verified, is_admin, created_at
      FROM users WHERE id = $1
    `, [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

/**
 * PUT /api/auth/password
 * Change password
 */
router.put('/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    // Get current password hash
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    // Verify current password
    const validPassword = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Update password
    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ message: 'Password updated successfully' });

  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
