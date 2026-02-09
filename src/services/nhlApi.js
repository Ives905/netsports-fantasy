const axios = require('axios');
const pool = require('../../config/database');

const NHL_API_BASE = 'https://api-web.nhle.com/v1';
const NHL_STATS_BASE = 'https://api.nhle.com/stats/rest/en';

class NHLApiService {
  constructor() {
    this.season = process.env.NHL_SEASON || '20252026';
    this.gameType = process.env.NHL_PLAYOFF_GAME_TYPE || '3'; // 3 = playoffs
  }

  /**
   * Fetch and populate ALL NHL players from all 32 teams
   * This should be run once to initially populate the database
   */
  async populateAllPlayers() {
    let totalPlayers = 0;
    let newPlayers = 0;
    
    try {
      // Get all teams
      const standingsResponse = await axios.get(`${NHL_API_BASE}/standings/now`);
      const allTeams = standingsResponse.data.standings.flatMap(conf => conf.teams || []);

      for (const team of allTeams) {
        try {
          const teamAbbrev = team.teamAbbrev?.default || team.teamAbbrev;
          
          // Fetch full team roster
          const rosterUrl = `${NHL_API_BASE}/roster/${teamAbbrev}/current`;
          const rosterResponse = await axios.get(rosterUrl);
          const roster = rosterResponse.data;

          // Get all position groups
          const forwards = roster.forwards || [];
          const defensemen = roster.defensemen || [];
          const goalies = roster.goalies || [];
          
          const allPlayers = [...forwards, ...defensemen, ...goalies];

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
              
              // Calculate cost based on position and player type
              const cost = this.calculatePlayerCost(player, position);

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
                console.log(`  ✨ New player added: ${fullName} (${teamAbbrev}, ${position})`);
              }
            } catch (playerError) {
              console.error(`    Error inserting player ${player.id}:`, playerError.message);
            }
          }

          // Small delay to avoid rate limiting
          await this.sleep(200);
          
        } catch (teamError) {
          console.error(`Error fetching roster for team:`, teamError.message);
        }
      }

      if (newPlayers > 0) {
        console.log(`✅ Player check complete: ${newPlayers} new players added (${totalPlayers} total processed)`);
      } else {
        console.log(`✓ Player check complete: No new players (${totalPlayers} verified)`);
      }
      return { success: true, totalPlayers, newPlayers };
      
    } catch (error) {
      console.error('Error checking for new players:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calculate player cost based on various factors
   * You can customize this logic
   */
  calculatePlayerCost(player, position) {
    // Default costs by position
    const baseCost = {
      'goalie': 3,
      'defense': 2,
      'forward': 2
    };
    
    let cost = baseCost[position] || 2;
    
    // Add cost for higher draft picks or skilled players
    // You can enhance this with actual stats if needed
    if (player.headshot) cost += 1; // Has headshot = likely regular player
    
    // Cap between 0 and 5
    return Math.min(Math.max(cost, 0), 5);
  }
  }

  /**
   * Fetch current playoff schedule to determine round
   */
  async getPlayoffSchedule() {
    try {
      const response = await axios.get(`${NHL_API_BASE}/schedule/now`);
      return response.data;
    } catch (error) {
      console.error('Error fetching playoff schedule:', error.message);
      return null;
    }
  }

  /**
   * Fetch player game log for playoffs
   */
  async getPlayerGameLog(nhlPlayerId) {
    try {
      const url = `${NHL_API_BASE}/player/${nhlPlayerId}/game-log/${this.season}/${this.gameType}`;
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        // Player has no playoff games yet
        return { gameLog: [] };
      }
      console.error(`Error fetching game log for player ${nhlPlayerId}:`, error.message);
      return null;
    }
  }

  /**
   * Fetch player landing page (has career stats, current season, etc.)
   */
  async getPlayerInfo(nhlPlayerId) {
    try {
      const url = `${NHL_API_BASE}/player/${nhlPlayerId}/landing`;
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error(`Error fetching player info for ${nhlPlayerId}:`, error.message);
      return null;
    }
  }

  /**
   * Determine playoff round from game data
   * NHL game IDs follow pattern: YYYYPPGGGN where PP is playoff round
   * Round 1: 0411-0417, Round 2: 0421-0427, Conf Finals: 0431-0437, Cup Final: 0441-0447
   */
  determineRound(gameId) {
    const gameIdStr = String(gameId);
    if (gameIdStr.length < 4) return 1;
    
    const roundCode = parseInt(gameIdStr.slice(-4, -2));
    
    if (roundCode >= 11 && roundCode <= 17) return 1;
    if (roundCode >= 21 && roundCode <= 27) return 2;
    if (roundCode >= 31 && roundCode <= 47) return 3; // Conf Finals + Cup Final = Round 3
    
    return 1; // Default to round 1
  }

  /**
   * Parse game log into per-round stats
   */
  parseGameLogStats(gameLog, isGoalie = false) {
    const stats = {
      1: { goals: 0, assists: 0, wins: 0, shutouts: 0, gamesPlayed: 0 },
      2: { goals: 0, assists: 0, wins: 0, shutouts: 0, gamesPlayed: 0 },
      3: { goals: 0, assists: 0, wins: 0, shutouts: 0, gamesPlayed: 0 }
    };

    if (!gameLog?.gameLog || !Array.isArray(gameLog.gameLog)) {
      return stats;
    }

    for (const game of gameLog.gameLog) {
      const round = this.determineRound(game.gameId);
      
      if (isGoalie) {
        // Goalie stats
        if (game.decision === 'W') {
          stats[round].wins += 1;
        }
        if (game.shutouts) {
          stats[round].shutouts += game.shutouts;
        }
        // Check for shutout by goals against
        if (game.goalsAgainst === 0 && game.decision === 'W') {
          stats[round].shutouts = Math.max(stats[round].shutouts, 1);
        }
      } else {
        // Skater stats
        stats[round].goals += game.goals || 0;
        stats[round].assists += game.assists || 0;
      }
      
      stats[round].gamesPlayed += 1;
    }

    return stats;
  }

  /**
   * Fetch and update stats for all players in database
   */
  async updateAllPlayerStats() {
    const logId = await this.startUpdateLog();
    let playersUpdated = 0;
    const errors = [];

    try {
      // Get all active players from database
      const playersResult = await pool.query(`
        SELECT id, nhl_id, position FROM players WHERE is_active = true
      `);

      console.log(`Fetching stats for ${playersResult.rows.length} players...`);

      for (const player of playersResult.rows) {
        try {
          const isGoalie = player.position === 'goalie';
          const gameLog = await this.getPlayerGameLog(player.nhl_id);
          
          if (gameLog) {
            const stats = this.parseGameLogStats(gameLog, isGoalie);
            
            // Update stats for each round
            for (const round of [1, 2, 3]) {
              await pool.query(`
                INSERT INTO player_stats (player_id, round, goals, assists, wins, shutouts, games_played, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                ON CONFLICT (player_id, round) 
                DO UPDATE SET 
                  goals = $3,
                  assists = $4,
                  wins = $5,
                  shutouts = $6,
                  games_played = $7,
                  updated_at = NOW()
              `, [
                player.id,
                round,
                stats[round].goals,
                stats[round].assists,
                stats[round].wins,
                stats[round].shutouts,
                stats[round].gamesPlayed
              ]);
            }
            
            playersUpdated++;
          }

          // Small delay to avoid rate limiting
          await this.sleep(100);
          
        } catch (playerError) {
          errors.push(`Player ${player.nhl_id}: ${playerError.message}`);
          console.error(`Error updating player ${player.nhl_id}:`, playerError.message);
        }
      }

      // Update settings
      await pool.query(`
        UPDATE settings SET value = $1, updated_at = NOW() WHERE key = 'stats_last_updated'
      `, [JSON.stringify(new Date().toISOString())]);

      await pool.query(`
        UPDATE settings SET value = 'true', updated_at = NOW() WHERE key = 'stats_verified'
      `);

      await this.completeUpdateLog(logId, playersUpdated, errors);
      
      console.log(`✓ Stats update complete: ${playersUpdated} players updated`);
      return { success: true, playersUpdated, errors };

    } catch (error) {
      errors.push(`Fatal error: ${error.message}`);
      await this.completeUpdateLog(logId, playersUpdated, errors, 'failed');
      console.error('Stats update failed:', error);
      return { success: false, playersUpdated, errors };
    }
  }

  /**
   * Update eliminated teams based on playoff results
   */
  async updateEliminatedTeams() {
    try {
      // Fetch current playoff bracket/standings
      const response = await axios.get(`${NHL_API_BASE}/playoff-bracket/${this.season}`);
      const bracket = response.data;

      if (!bracket?.series) return;

      for (const series of bracket.series) {
        if (series.winningTeamId && series.losingTeamId) {
          // Mark losing team as eliminated
          const losingTeam = series.bottomSeed?.abbrev || series.topSeed?.abbrev;
          const round = series.round;
          
          if (losingTeam) {
            await pool.query(`
              UPDATE teams 
              SET is_eliminated = true, eliminated_round = $1 
              WHERE abbrev = $2
            `, [round, losingTeam]);
          }
        }
      }

      console.log('✓ Eliminated teams updated');
    } catch (error) {
      console.error('Error updating eliminated teams:', error.message);
    }
  }

  async startUpdateLog() {
    const result = await pool.query(`
      INSERT INTO stat_update_log (status) VALUES ('running') RETURNING id
    `);
    return result.rows[0].id;
  }

  async completeUpdateLog(logId, playersUpdated, errors, status = 'completed') {
    await pool.query(`
      UPDATE stat_update_log 
      SET completed_at = NOW(), players_updated = $1, errors = $2, status = $3
      WHERE id = $4
    `, [playersUpdated, errors, status, logId]);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new NHLApiService();
