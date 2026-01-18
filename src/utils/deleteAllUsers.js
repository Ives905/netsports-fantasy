#!/usr/bin/env node

/**
 * Utility to delete all users from the database
 * USE WITH CAUTION - This will permanently delete all user accounts
 *
 * Usage:
 *   node src/utils/deleteAllUsers.js --confirm
 */

require('dotenv').config();
const pool = require('../../config/database');

async function deleteAllUsers() {
  try {
    // Check for confirmation flag
    const args = process.argv.slice(2);
    const confirmed = args.includes('--confirm');

    if (!confirmed) {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ⚠️  DELETE ALL USERS UTILITY                            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

This will PERMANENTLY delete all user accounts from the database.

This action:
  ❌ Deletes all users
  ❌ Deletes all rosters
  ❌ Deletes all group memberships
  ❌ Cannot be undone

To proceed, run:
  node src/utils/deleteAllUsers.js --confirm

Or on Railway:
  railway run node src/utils/deleteAllUsers.js --confirm
      `);
      process.exit(0);
    }

    console.log('\n🔍 Checking current users...\n');

    // Count users
    const countResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(countResult.rows[0].count);

    if (userCount === 0) {
      console.log('✓ No users found in database. Nothing to delete.\n');
      await pool.end();
      process.exit(0);
    }

    // Show users that will be deleted
    const usersResult = await pool.query(`
      SELECT username, email, is_admin, is_verified, created_at
      FROM users
      ORDER BY created_at DESC
    `);

    console.log(`Found ${userCount} user(s):\n`);
    usersResult.rows.forEach((user, idx) => {
      const admin = user.is_admin ? '👑 ADMIN' : '';
      const verified = user.is_verified ? '✓' : '✗';
      console.log(`  ${idx + 1}. ${user.username} (${user.email}) ${admin} [Verified: ${verified}]`);
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log('\n⚠️  DELETING ALL USERS IN 3 SECONDS...');
    console.log('   Press Ctrl+C to cancel!\n');
    console.log(`${'='.repeat(60)}\n`);

    // Wait 3 seconds
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Delete in order due to foreign key constraints
    console.log('🗑️  Deleting user data...\n');

    // Delete group memberships
    const groupMembersResult = await pool.query('DELETE FROM group_members RETURNING *');
    console.log(`  ✓ Deleted ${groupMembersResult.rowCount} group memberships`);

    // Delete group messages
    const messagesResult = await pool.query('DELETE FROM group_messages RETURNING *');
    console.log(`  ✓ Deleted ${messagesResult.rowCount} group messages`);

    // Delete groups
    const groupsResult = await pool.query('DELETE FROM groups RETURNING *');
    console.log(`  ✓ Deleted ${groupsResult.rowCount} groups`);

    // Delete rosters
    const rostersResult = await pool.query('DELETE FROM rosters RETURNING *');
    console.log(`  ✓ Deleted ${rostersResult.rowCount} rosters`);

    // Delete users
    const usersDeleteResult = await pool.query('DELETE FROM users RETURNING *');
    console.log(`  ✓ Deleted ${usersDeleteResult.rowCount} users`);

    console.log(`\n${'='.repeat(60)}`);
    console.log('\n✅ SUCCESS! All users have been deleted.');
    console.log('\nThe database is now clean. You can:');
    console.log('  1. Register a new admin account');
    console.log('  2. Test the email verification feature');
    console.log('  3. Start fresh with your app\n');
    console.log(`${'='.repeat(60)}\n`);

    await pool.end();
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error deleting users:', error.message);
    await pool.end();
    process.exit(1);
  }
}

deleteAllUsers();
