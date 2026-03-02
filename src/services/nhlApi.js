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
   * Automatically detects new players (call-ups, roster changes)
   */
  async populateAllPlayers() {
    let totalPlayers = 0;
    let newPlayers = 0;
    
    // Hardcoded list of all 32 NHL teams (more reliable than API)
    // Note: ARI (Arizona Coyotes) relocated and became UTA (Utah Hockey Club) in 2024-25
    const allTeams = [
      'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ',
      'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH',
      'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SEA', 'SJS',
      'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG'
    ];
    
    try {
      console.log(`Fetching rosters for ${allTeams.length} NHL teams...`);

      for (const teamAbbrev of allTeams) {
        try {
          console.log(`Fetching roster for ${teamAbbrev}...`);
          
          // Fetch full team roster
          const rosterUrl = `${NHL_API_BASE}/roster/${teamAbbrev}/current`;
          const rosterResponse = await axios.get(rosterUrl);
          
          if (!rosterResponse.data) {
            console.error(`No roster data for ${teamAbbrev}`);
            continue;
          }
          
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
              if (!player.id) {
                console.error('Player has no ID:', player);
                continue;
              }
              
              const firstName = player.firstName?.default || player.firstName || '';
              const lastName = player.lastName?.default || player.lastName || '';
              const fullName = `${firstName} ${lastName}`.trim();
              
              if (!fullName) {
                console.error('Player has no name:', player);
                continue;
              }
              
              // Determine position
              let position = 'forward';
              if (player.positionCode === 'G') position = 'goalie';
              else if (player.positionCode === 'D') position = 'defense';
              
              // Calculate cost based on position and player type
              const cost = this.calculatePlayerCost(player, position);

              // player.headshot from NHL API is the exact verified headshot URL
              const headshotUrl = player.headshot || null;

              const result = await pool.query(`
                INSERT INTO players (nhl_id, name, position, team_abbrev, cost, is_active, headshot_url)
                VALUES ($1, $2, $3, $4, $5, true, $6)
                ON CONFLICT (nhl_id) DO UPDATE
                SET name = $2, position = $3, team_abbrev = $4, is_active = true,
                    headshot_url = COALESCE($6, players.headshot_url)
                RETURNING (xmax = 0) AS inserted
              `, [player.id, fullName, position, teamAbbrev, cost, headshotUrl]);
              
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
          console.error(`Error fetching roster for ${teamAbbrev}:`, teamError.message);
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
      console.error('Error stack:', error.stack);
      return { success: false, error: error.message };
    }
  }

  /**
   * Default cost for new players being inserted (before stats are available).
   * Run updatePlayerCosts() to set real values based on NHL stats.
   */
  calculatePlayerCost(player, position) {
    const baseCost = { goalie: 3, defense: 2, forward: 2 };
    return baseCost[position] || 2;
  }

  /**
   * Fetch regular-season stats from the NHL Stats API and update every
   * active player's cost in the database based on their actual performance.
   *
   * Skaters  → cost driven by points-per-game (position-specific thresholds)
   * Goalies  → cost driven by save percentage + games played
   *
   * Call this from the admin panel after rosters are populated.
   */
  async updatePlayerCosts() {
    try {
      console.log(`Fetching ${this.season} regular-season stats to calculate player values...`);

      // Pull bulk skater + goalie stats in parallel (gameTypeId=2 = regular season)
      const [skaterRes, goalieRes] = await Promise.all([
        axios.get(`${NHL_STATS_BASE}/skater/summary`, {
          params: { limit: -1, cayenneExp: `seasonId=${this.season} and gameTypeId=2` },
          timeout: 15000
        }),
        axios.get(`${NHL_STATS_BASE}/goalie/summary`, {
          params: { limit: -1, cayenneExp: `seasonId=${this.season} and gameTypeId=2` },
          timeout: 15000
        })
      ]);

      // Build playerId → stats lookup maps
      const skaterStats = {};
      for (const s of (skaterRes.data?.data || [])) {
        skaterStats[s.playerId] = s;
      }
      const goalieStats = {};
      for (const g of (goalieRes.data?.data || [])) {
        goalieStats[g.playerId] = g;
      }

      const leagueTotal = Object.keys(skaterStats).length + Object.keys(goalieStats).length;
      console.log(`Loaded stats for ${leagueTotal} players from NHL Stats API`);

      // Get all active players from DB
      const playersResult = await pool.query(`
        SELECT id, nhl_id, position, name FROM players WHERE is_active = true
      `);

      let updated = 0;
      let noStats = 0;
      const costDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

      for (const player of playersResult.rows) {
        let newCost;
        const nhlId = parseInt(player.nhl_id);

        if (player.position === 'goalie') {
          const stats = goalieStats[nhlId];
          newCost = this.calculateGoalieCost(stats);
          if (!stats) noStats++;
        } else {
          const stats = skaterStats[nhlId];
          newCost = this.calculateSkaterCost(stats, player.position);
          if (!stats) noStats++;
        }

        await pool.query(
          'UPDATE players SET cost = $1, updated_at = NOW() WHERE id = $2',
          [newCost, player.id]
        );
        updated++;
        costDistribution[newCost] = (costDistribution[newCost] || 0) + 1;
      }

      console.log(`✅ Player costs updated for ${updated} players`);
      console.log(`   Cost breakdown: $1×${costDistribution[1]}  $2×${costDistribution[2]}  $3×${costDistribution[3]}  $4×${costDistribution[4]}  $5×${costDistribution[5]}`);
      if (noStats > 0) console.log(`   ${noStats} players had no current-season stats (set to default cost)`);

      return { success: true, updated, noStats, costDistribution };
    } catch (error) {
      console.error('Error updating player costs:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calculate skater cost from regular-season stats.
   * Uses points-per-game with position-specific thresholds
   * (defensemen score fewer points than forwards at the same talent level).
   */
  calculateSkaterCost(stats, position) {
    if (!stats || !stats.gamesPlayed || stats.gamesPlayed < 5) {
      return 2; // Not enough data — default mid-range
    }

    const ppg = stats.points / stats.gamesPlayed;

    if (position === 'defense') {
      // Defensive scoring is compressed — separate thresholds
      // Elite: Makar/Fox tier (~0.80+ PPG)
      if (ppg >= 0.75) return 5;
      // Top pairing offensive D (~0.55+)
      if (ppg >= 0.55) return 4;
      // Solid two-way D (~0.35+)
      if (ppg >= 0.35) return 3;
      // Bottom pairing
      if (ppg >= 0.15) return 2;
      return 1;
    } else {
      // Forwards
      // Elite: McDavid/Draisaitl/MacKinnon tier (~0.95+ PPG)
      if (ppg >= 0.95) return 5;
      // Star top-6: Matthews/Barkov/Pastrnak tier (~0.70+)
      if (ppg >= 0.70) return 4;
      // Solid mid-tier forward (~0.45+)
      if (ppg >= 0.45) return 3;
      // Bottom-6 / fringe
      if (ppg >= 0.20) return 2;
      return 1;
    }
  }

  /**
   * Calculate goalie cost from regular-season stats.
   * Save percentage is the most reliable measure of goalie quality.
   * Games played threshold ensures we're evaluating real starters.
   */
  calculateGoalieCost(stats) {
    if (!stats || !stats.gamesPlayed || stats.gamesPlayed < 5) {
      return 2; // Unknown / rarely-used backup
    }

    // savePct field name varies slightly across NHL API versions
    const savePct = stats.savePct || stats.savePctg || 0;
    const gp = stats.gamesPlayed;

    // Elite starter: .920+ SV%, full workload
    if (savePct >= 0.920 && gp >= 20) return 5;
    // Strong starter: .910+ SV%
    if (savePct >= 0.910 && gp >= 15) return 4;
    // Solid starter: .900+ SV%
    if (savePct >= 0.900 && gp >= 10) return 3;
    // Backup / below average but has NHL experience
    if (gp >= 10) return 2;
    return 1;
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
