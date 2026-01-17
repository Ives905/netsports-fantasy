/**
 * Scheduled job to fetch NHL stats
 * Can be run standalone or as part of the server
 */

require('dotenv').config();
const cron = require('node-cron');
const nhlApi = require('../services/nhlApi');

// Run stats update
async function runStatsUpdate() {
  console.log(`[${new Date().toISOString()}] Starting scheduled stats update...`);
  
  try {
    // Update player stats
    const result = await nhlApi.updateAllPlayerStats();
    
    // Update eliminated teams
    await nhlApi.updateEliminatedTeams();
    
    console.log(`[${new Date().toISOString()}] Stats update completed:`, result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Stats update failed:`, error);
  }
}

// Schedule options:
// During playoffs, run every 15 minutes during game hours (6 PM - 1 AM ET)
// Run at 2 AM ET for final overnight update
// Run at 12 PM ET for verified daytime update

function setupScheduledJobs() {
  // Every 15 minutes during game hours (10 PM - 5 AM UTC = 6 PM - 1 AM ET)
  cron.schedule('*/15 22-23,0-5 * 4-6 *', () => {
    console.log('Running game-time stats update...');
    runStatsUpdate();
  }, {
    timezone: 'UTC'
  });

  // 2 AM ET (6 AM UTC) - overnight final update
  cron.schedule('0 6 * 4-6 *', () => {
    console.log('Running overnight stats update...');
    runStatsUpdate();
  }, {
    timezone: 'UTC'
  });

  // 12 PM ET (4 PM UTC) - verified daytime update
  cron.schedule('0 16 * 4-6 *', () => {
    console.log('Running verified daytime stats update...');
    runStatsUpdate();
  }, {
    timezone: 'UTC'
  });

  console.log('✓ Scheduled jobs configured');
}

// If run directly, execute update immediately
if (require.main === module) {
  runStatsUpdate().then(() => {
    console.log('Manual stats update completed');
    process.exit(0);
  }).catch(error => {
    console.error('Manual stats update failed:', error);
    process.exit(1);
  });
}

module.exports = { setupScheduledJobs, runStatsUpdate };
