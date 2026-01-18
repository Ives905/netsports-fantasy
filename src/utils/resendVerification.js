#!/usr/bin/env node

/**
 * Utility script to resend verification emails
 *
 * Usage:
 *   # Resend to specific email
 *   node src/utils/resendVerification.js user@example.com
 *
 *   # Resend to all unverified users
 *   node src/utils/resendVerification.js --all
 */

require('dotenv').config();
const pool = require('../../config/database');
const { sendVerificationEmail } = require('../services/email');

async function resendVerificationToEmail(email) {
  try {
    console.log(`\nSearching for user with email: ${email}...`);

    // Find user by email
    const userResult = await pool.query(`
      SELECT id, username, email, is_verified, verification_code
      FROM users
      WHERE LOWER(email) = LOWER($1)
    `, [email]);

    if (userResult.rows.length === 0) {
      console.error(`❌ Error: No user found with email ${email}`);
      return false;
    }

    const user = userResult.rows[0];

    // Check if already verified
    if (user.is_verified) {
      console.log(`ℹ️  User ${user.username} (${user.email}) is already verified.`);
      return false;
    }

    console.log(`✓ Found unverified user: ${user.username} (${user.email})`);

    // Generate new verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Update verification code in database
    await pool.query(`
      UPDATE users
      SET verification_code = $1
      WHERE id = $2
    `, [verificationCode, user.id]);

    console.log(`✓ Generated new verification code: ${verificationCode}`);

    // Send verification email
    console.log(`📧 Sending verification email...`);
    const emailSent = await sendVerificationEmail(user.email, verificationCode, user.username);

    if (emailSent) {
      console.log(`✅ Success! Verification email sent to ${user.email}`);
      if (process.env.NODE_ENV === 'development') {
        console.log(`\n🔑 Verification code (dev only): ${verificationCode}`);
      }
      return true;
    } else {
      console.error(`❌ Failed to send email. Check email configuration.`);
      console.log(`\n🔑 Manual verification code: ${verificationCode}`);
      console.log(`   You can use this code to verify manually.`);
      return false;
    }

  } catch (error) {
    console.error('❌ Error resending verification:', error.message);
    return false;
  }
}

async function resendToAllUnverified() {
  try {
    console.log('\nFinding all unverified users...');

    const result = await pool.query(`
      SELECT id, username, email, verification_code
      FROM users
      WHERE is_verified = false
      ORDER BY created_at DESC
    `);

    if (result.rows.length === 0) {
      console.log('✓ No unverified users found.');
      return;
    }

    console.log(`\nFound ${result.rows.length} unverified user(s):\n`);

    let successCount = 0;
    let failCount = 0;

    for (const user of result.rows) {
      console.log(`\n--- Processing ${user.username} (${user.email}) ---`);

      // Generate new verification code
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

      // Update verification code in database
      await pool.query(`
        UPDATE users
        SET verification_code = $1
        WHERE id = $2
      `, [verificationCode, user.id]);

      console.log(`✓ Generated new code: ${verificationCode}`);

      // Send verification email
      console.log(`📧 Sending email...`);
      const emailSent = await sendVerificationEmail(user.email, verificationCode, user.username);

      if (emailSent) {
        console.log(`✅ Email sent successfully`);
        successCount++;
      } else {
        console.error(`❌ Failed to send email`);
        console.log(`   Manual code for ${user.email}: ${verificationCode}`);
        failCount++;
      }

      // Small delay between emails to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`\n📊 Summary:`);
    console.log(`   Total users: ${result.rows.length}`);
    console.log(`   ✅ Successfully sent: ${successCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
    console.log(`\n${'='.repeat(60)}\n`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   📧 Resend Verification Email Utility                    ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

Usage:
  node src/utils/resendVerification.js <email>
  node src/utils/resendVerification.js --all

Examples:
  node src/utils/resendVerification.js admin@example.com
  node src/utils/resendVerification.js --all
    `);
    await pool.end();
    process.exit(0);
  }

  if (args[0] === '--all') {
    await resendToAllUnverified();
  } else {
    const email = args[0];
    await resendVerificationToEmail(email);
  }

  await pool.end();
  console.log('\n✓ Done.\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  pool.end();
  process.exit(1);
});
