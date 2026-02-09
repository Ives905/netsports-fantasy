/**
 * Standalone script to populate ALL NHL players
 * Run this once to fill your database with all ~700 NHL players
 * 
 * Usage: node src/scripts/populatePlayers.js
 */

require('dotenv').config();
const axios = require('axios');
const pool = require('../config/database');

const NHL_API_BASE = 'https://api-web.nhle.com/v1';

async function populateAllPlayersVerbose() {
  console.log('Starting to fetch ALL NHL players...');
  let totalPlayers = 0;
  let newPlayers = 0;
  
  try {
    // Get all teams
    const standingsResponse = await axios.get(`${NHL_API_BASE}/standings/now`);
    const allTeams = standingsResponse.data.standings.flatMap(conf => conf.teams || []);
    
    console.log(`Found ${allTeams.length} teams\n`);

    for (const team of allTeams) {
      try {
        const teamAbbrev = team.teamAbbrev?.default || team.teamAbbrev;
        console.log(`Fetching roster for ${teamAbbrev}...`);
        
        // Fetch full team roster
        const rosterUrl = `${NHL_API_BASE}/roster/${teamAbbrev}/current`;
        const rosterResponse = await axios.get(rosterUrl);
        const roster = rosterResponse.data;

        // Get all position groups
        const forwards = roster.forwards || [];
        const defensemen = roster.defensemen || [];
        const goalies = roster.goalies || [];
        
        const allPlayers = [...forwards, ...defensemen, ...goalies];
        
        console.log(`  ${teamAbbrev}: ${allPlayers.length} players (${forwards.length}F, ${defensemen.length}D, ${goalies.length}G)`);

        // Insert each player
        for (const player of allPlayers) {
          try {
            const firstName = player.firstName?.default || player.firstName || '';
            const lastName = player.lastName?.default || player.lastName || '';
            const fullName = `${firstName} ${lastName}`.trim();
            
            // Determine position
            let position = 'forward';
            if (player.positionCode === 'G') position = 'goalie';
            else if (player.positionCode === 'D') position = 'defense';
            
            // Calculate cost (simple version)
            const baseCost = { 'goalie': 3, 'defense': 2, 'forward': 2 };
            let cost = baseCost[position] || 2;
            if (player.headshot) cost += 1;
            cost = Math.min(Math.max(cost, 0), 5);

            const result = await pool.query(`
              INSERT INTO players (nhl_id, name, position, team_abbrev, cost, is_active)
              VALUES ($1, $2, $3, $4, $5, true)
              ON CONFLICT (nhl_id) DO UPDATE
              SET name = $2, position = $3, team_abbrev = $4, cost = $5, is_active = true
              RETURNING (xmax = 0) AS inserted
            `, [player.id, fullName, position, teamAbbrev, cost]);
            
            totalPlayers++;
            if (result.rows[0].inserted) {
              newPlayers++;
            }
          } catch (playerError) {
            console.error(`    Error inserting player ${player.id}:`, playerError.message);
          }
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (teamError) {
        console.error(`Error fetching roster for team:`, teamError.message);
      }
    }

    console.log(`\n✅ Player population complete!`);
    console.log(`   Total players: ${totalPlayers}`);
    console.log(`   New players: ${newPlayers}`);
    console.log(`   Updated players: ${totalPlayers - newPlayers}`);
    return { success: true, totalPlayers, newPlayers };
    
  } catch (error) {
    console.error('Fatal error populating players:', error);
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('========================================');
  console.log('  NHL Player Population Script');
  console.log('========================================\n');
  
  console.log('This will fetch all rosters from all 32 NHL teams');
  console.log('and populate your database with ~700 players.\n');
  
  try {
    const result = await populateAllPlayersVerbose();
    
    if (result.success) {
      console.log('\n========================================');
      console.log('✅ SUCCESS!');
      console.log(`   ${result.totalPlayers} players processed`);
      if (result.newPlayers > 0) {
        console.log(`   ${result.newPlayers} new players added`);
      }
      console.log('========================================\n');
      console.log('You can now:');
      console.log('1. Refresh your app to see all players');
      console.log('2. Build rosters with the full NHL player pool');
      console.log('3. Run stats updates to get playoff stats\n');
      process.exit(0);
    } else {
      console.log('\n========================================');
      console.log('❌ FAILED');
      console.log(`   Error: ${result.error}`);
      console.log('========================================\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

main();
