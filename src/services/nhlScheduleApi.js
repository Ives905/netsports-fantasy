const axios = require('axios');
const pool = require('../../config/database');

const NHL_API_BASE = 'https://api-web.nhle.com/v1';

const FINAL_STATES = ['FINAL', 'OFF'];
const POSTPONED_STATES = ['PPD', 'CNCL', 'SUSP'];
const LIVE_STATES = ['LIVE', 'CRIT'];

/**
 * Talks to the NHL's free public API to keep the Saturday Night Pickem pool's
 * games, scores, and pick grading up to date. Uses the same api-web.nhle.com
 * host the draft pool already relies on for player data.
 */
class NHLScheduleService {
  /**
   * Fetch every NHL game scheduled for a given date (YYYY-MM-DD, Eastern calendar date).
   * The /score/{date} endpoint conveniently returns start times AND live/final
   * scores together, so one call covers both "what's on" and "what happened".
   */
  async fetchGamesForDate(dateStr) {
    const url = `${NHL_API_BASE}/score/${dateStr}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return (data.games || []).map(g => ({
      nhlGameId: g.id,
      startTimeUTC: g.startTimeUTC,
      homeTeam: g.homeTeam?.abbrev,
      awayTeam: g.awayTeam?.abbrev,
      homeScore: g.homeTeam?.score ?? null,
      awayScore: g.awayTeam?.score ?? null,
      gameState: g.gameState || 'FUT'
    }));
  }

  mapStatus(gameState) {
    if (FINAL_STATES.includes(gameState)) return 'final';
    if (POSTPONED_STATES.includes(gameState)) return 'postponed';
    if (LIVE_STATES.includes(gameState)) return 'live';
    return 'scheduled';
  }

  /**
   * Find the next Saturday (or today, if today IS Saturday) in Eastern time,
   * as a YYYY-MM-DD string. Used by the weekly sync job to know what to fetch.
   */
  getNextSaturday(referenceDate = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
    }).formatToParts(referenceDate);
    const get = type => parts.find(p => p.type === type)?.value;
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const todayDow = weekdayMap[get('weekday')];
    const daysUntilSaturday = (6 - todayDow + 7) % 7;

    const eastern = new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00`);
    eastern.setDate(eastern.getDate() + daysUntilSaturday);

    const y = eastern.getFullYear();
    const m = String(eastern.getMonth() + 1).padStart(2, '0');
    const d = String(eastern.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Sync pickem_weeks + pickem_games for a given Saturday.
   * Safe to call repeatedly (e.g. once ahead of time to create the week,
   * then every few minutes during game night to refresh scores/status) —
   * every write is an idempotent upsert.
   */
  async syncWeek(dateStr, season) {
    const games = await this.fetchGamesForDate(dateStr);

    // Don't create a week row for a date with no NHL games at all (e.g. off-season).
    if (games.length === 0) {
      return { weekId: null, gameCount: 0 };
    }

    const weekResult = await pool.query(`
      INSERT INTO pickem_weeks (week_date, season)
      VALUES ($1, $2)
      ON CONFLICT (week_date) DO UPDATE SET week_date = EXCLUDED.week_date
      RETURNING id
    `, [dateStr, season]);
    const weekId = weekResult.rows[0].id;

    for (const g of games) {
      if (!g.homeTeam || !g.awayTeam || !g.startTimeUTC) continue; // skip malformed entries

      const status = this.mapStatus(g.gameState);
      let winner = null;
      if (status === 'final' && g.homeScore != null && g.awayScore != null) {
        winner = g.homeScore > g.awayScore ? g.homeTeam : g.awayTeam;
      }

      await pool.query(`
        INSERT INTO pickem_games
          (week_id, nhl_game_id, home_team, away_team, start_time, status, home_score, away_score, winner, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (nhl_game_id) DO UPDATE SET
          start_time  = EXCLUDED.start_time,
          status      = EXCLUDED.status,
          home_score  = EXCLUDED.home_score,
          away_score  = EXCLUDED.away_score,
          winner      = EXCLUDED.winner,
          graded_at   = CASE WHEN EXCLUDED.status = 'final' AND pickem_games.graded_at IS NULL
                             THEN NOW() ELSE pickem_games.graded_at END,
          updated_at  = NOW()
      `, [weekId, g.nhlGameId, g.homeTeam, g.awayTeam, g.startTimeUTC, status, g.homeScore, g.awayScore, winner]);
    }

    // The tiebreaker is always the game with the latest scheduled start time that week.
    const tbResult = await pool.query(`
      SELECT id FROM pickem_games WHERE week_id = $1 ORDER BY start_time DESC LIMIT 1
    `, [weekId]);
    if (tbResult.rows.length > 0) {
      const tbGameId = tbResult.rows[0].id;
      await pool.query(`UPDATE pickem_games SET is_tiebreaker_game = (id = $2) WHERE week_id = $1`, [weekId, tbGameId]);
      await pool.query(`UPDATE pickem_weeks SET tiebreaker_game_id = $2 WHERE id = $1`, [weekId, tbGameId]);
    }

    await this.gradePicks(weekId);

    return { weekId, gameCount: games.length };
  }

  /**
   * Grade any picks/tiebreakers for games that have gone final since the last sync.
   * Idempotent — only touches rows that haven't been graded yet.
   */
  async gradePicks(weekId) {
    // Score each pick once its game is final. Postponed games are left ungraded
    // (is_correct stays NULL) so they're excluded from standings entirely.
    await pool.query(`
      UPDATE pickem_picks pp
      SET is_correct = (pp.picked_team = pg.winner), updated_at = NOW()
      FROM pickem_games pg
      WHERE pp.game_id = pg.id
        AND pg.week_id = $1
        AND pg.status = 'final'
        AND pp.is_correct IS NULL
    `, [weekId]);

    // Once the designated tiebreaker game is final, lock in the actual goal total.
    const weekRes = await pool.query(`SELECT tiebreaker_game_id FROM pickem_weeks WHERE id = $1`, [weekId]);
    const tbGameId = weekRes.rows[0]?.tiebreaker_game_id;
    if (tbGameId) {
      const gameRes = await pool.query(
        `SELECT status, home_score, away_score FROM pickem_games WHERE id = $1`,
        [tbGameId]
      );
      const g = gameRes.rows[0];
      if (g && g.status === 'final' && g.home_score != null && g.away_score != null) {
        await pool.query(`
          UPDATE pickem_tiebreakers
          SET actual_total_goals = $2
          WHERE week_id = $1 AND actual_total_goals IS NULL
        `, [weekId, g.home_score + g.away_score]);
      }
    }

    // A week is "finalized" once every game in it is either final or postponed.
    const remaining = await pool.query(`
      SELECT COUNT(*)::int AS count FROM pickem_games
      WHERE week_id = $1 AND status NOT IN ('final', 'postponed')
    `, [weekId]);
    if (remaining.rows[0].count === 0) {
      await pool.query(`UPDATE pickem_weeks SET is_finalized = true WHERE id = $1`, [weekId]);
    }
  }
}

module.exports = new NHLScheduleService();
