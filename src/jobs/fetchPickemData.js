/**
 * Scheduled jobs for the Saturday Night Pickem pool.
 * Can be run standalone (`npm run fetch-pickem`) or as part of the server.
 */

require('dotenv').config();
const cron = require('node-cron');
const nhlScheduleApi = require('../services/nhlScheduleApi');

function currentSeason() {
  return process.env.NHL_SEASON || '20252026';
}

/**
 * Pulls the upcoming Saturday's game schedule into pickem_games so it's
 * visible (and pickable, once each game's own lock time arrives) well
 * before puck drop. Safe to run daily — it's an idempotent upsert.
 */
async function syncUpcomingWeek() {
  const dateStr = nhlScheduleApi.getNextSaturday();
  console.log(`[${new Date().toISOString()}] Syncing pickem schedule for ${dateStr}...`);
  try {
    const result = await nhlScheduleApi.syncWeek(dateStr, currentSeason());
    console.log(`[${new Date().toISOString()}] Pickem schedule sync complete:`, result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Pickem schedule sync failed:`, error.message);
  }
}

/**
 * Refreshes scores/status for the current (or most recently synced) Saturday
 * and grades picks + the tiebreaker as games go final. Meant to run frequently
 * during Saturday night game windows.
 */
async function syncGameNight() {
  const dateStr = nhlScheduleApi.getNextSaturday(); // on Saturday itself, this returns today
  try {
    const result = await nhlScheduleApi.syncWeek(dateStr, currentSeason());
    console.log(`[${new Date().toISOString()}] Pickem game-night sync (${dateStr}):`, result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Pickem game-night sync failed:`, error.message);
  }
}

function setupPickemJobs() {
  // Once a day, make sure the upcoming Saturday's games are loaded.
  cron.schedule('0 13 * * *', () => {
    console.log('Running daily pickem schedule sync...');
    syncUpcomingWeek();
  }, { timezone: 'UTC' });

  // Every 10 minutes through Saturday evening (16:00-23:59 UTC ≈ 11am-7pm ET
  // through late evening, covering matinee starts through prime time).
  cron.schedule('*/10 16-23 * * 6', () => {
    syncGameNight();
  }, { timezone: 'UTC' });

  // Continue into early Sunday UTC to catch West Coast games finishing late.
  cron.schedule('*/10 0-7 * * 0', () => {
    syncGameNight();
  }, { timezone: 'UTC' });

  console.log('✓ Pickem scheduled jobs registered');
}

// Allow running directly: `node src/jobs/fetchPickemData.js` or `npm run fetch-pickem`
if (require.main === module) {
  syncUpcomingWeek().then(() => process.exit(0));
}

module.exports = { setupPickemJobs, syncUpcomingWeek, syncGameNight };
