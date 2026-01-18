#!/usr/bin/env node

/**
 * Quick utility to generate and display verification code
 * Usage: node src/utils/getVerificationCode.js <email>
 */

require('dotenv').config();
const pool = require('../../config/database');

async function getVerificationCode(email) {
  try {
    console.log(`\n🔍 Looking up user: ${email}...`);

    // Find user by email
    const userResult = await pool.query(`
      SELECT id, username, email, is_verified, verification_code
      FROM users
      WHERE LOWER(email) = LOWER($1)
    `, [email]);

    if (userResult.rows.length === 0) {
      console.error(`\n❌ No user found with email: ${email}`);
      await pool.end();
      process.exit(1);
    }

    const user = userResult.rows[0];

    if (user.is_verified) {
      console.log(`\n✅ This account is already verified!`);
      console.log(`   Username: ${user.username}`);
      console.log(`   Email: ${user.email}`);
      console.log(`\n   You can log in directly at your app.`);
      await pool.end();
      process.exit(0);
    }

    console.log(`\n✓ Found user: ${user.username}`);

    // Generate new verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Update verification code in database
    await pool.query(`
      UPDATE users
      SET verification_code = $1
      WHERE id = $2
    `, [verificationCode, user.id]);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`\n✅ SUCCESS! Your verification code is:\n`);
    console.log(`   ╔═══════════╗`);
    console.log(`   ║  ${verificationCode}  ║`);
    console.log(`   ╚═══════════╝\n`);
    console.log(`📧 Account: ${user.email}`);
    console.log(`👤 Username: ${user.username}`);
    console.log(`\nNext steps:`);
    console.log(`1. Go to: https://netsports-fantasy-production.up.railway.app/`);
    console.log(`2. Enter this code to verify your account`);
    console.log(`3. You'll then have full admin access!`);
    console.log(`\n${'='.repeat(60)}\n`);

    await pool.end();
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
Usage:
  node src/utils/getVerificationCode.js <email>

Example:
  node src/utils/getVerificationCode.js christopher.ive1@gmail.com
  `);
  process.exit(0);
}

const email = args[0];
getVerificationCode(email);
