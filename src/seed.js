/**
 * Seed script to populate database with initial teams and players
 * Run with: npm run seed
 */

require('dotenv').config();
const pool = require('../config/database');

// NHL Playoff Teams (update each season)
const TEAMS = [
  // Western Conference
  { abbrev: 'EDM', name: 'Edmonton Oilers', conference: 'western', color: '#FF4C00' },
  { abbrev: 'COL', name: 'Colorado Avalanche', conference: 'western', color: '#6F263D' },
  { abbrev: 'DAL', name: 'Dallas Stars', conference: 'western', color: '#006847' },
  { abbrev: 'WPG', name: 'Winnipeg Jets', conference: 'western', color: '#041E42' },
  { abbrev: 'VGK', name: 'Vegas Golden Knights', conference: 'western', color: '#B4975A' },
  { abbrev: 'MIN', name: 'Minnesota Wild', conference: 'western', color: '#154734' },
  { abbrev: 'LAK', name: 'Los Angeles Kings', conference: 'western', color: '#111111' },
  { abbrev: 'VAN', name: 'Vancouver Canucks', conference: 'western', color: '#00205B' },
  
  // Eastern Conference
  { abbrev: 'FLA', name: 'Florida Panthers', conference: 'eastern', color: '#C8102E' },
  { abbrev: 'TOR', name: 'Toronto Maple Leafs', conference: 'eastern', color: '#00205B' },
  { abbrev: 'BOS', name: 'Boston Bruins', conference: 'eastern', color: '#FFB81C' },
  { abbrev: 'TBL', name: 'Tampa Bay Lightning', conference: 'eastern', color: '#002868' },
  { abbrev: 'CAR', name: 'Carolina Hurricanes', conference: 'eastern', color: '#CC0000' },
  { abbrev: 'NYR', name: 'New York Rangers', conference: 'eastern', color: '#0038A8' },
  { abbrev: 'NJD', name: 'New Jersey Devils', conference: 'eastern', color: '#CE1126' },
  { abbrev: 'WSH', name: 'Washington Capitals', conference: 'eastern', color: '#C8102E' }
];

// Players with NHL IDs (update each season with actual playoff rosters)
const PLAYERS = [
  // Western Forwards
  { nhl_id: 8478402, name: 'Connor McDavid', team: 'EDM', position: 'forward', cost: 4 },
  { nhl_id: 8477934, name: 'Leon Draisaitl', team: 'EDM', position: 'forward', cost: 4 },
  { nhl_id: 8477492, name: 'Nathan MacKinnon', team: 'COL', position: 'forward', cost: 4 },
  { nhl_id: 8478420, name: 'Mikko Rantanen', team: 'COL', position: 'forward', cost: 3 },
  { nhl_id: 8478449, name: 'Roope Hintz', team: 'DAL', position: 'forward', cost: 3 },
  { nhl_id: 8479318, name: 'Jason Robertson', team: 'DAL', position: 'forward', cost: 3 },
  { nhl_id: 8478864, name: 'Kirill Kaprizov', team: 'MIN', position: 'forward', cost: 3 },
  { nhl_id: 8476460, name: 'Mark Scheifele', team: 'WPG', position: 'forward', cost: 3 },
  { nhl_id: 8477498, name: 'Zach Hyman', team: 'EDM', position: 'forward', cost: 2 },
  { nhl_id: 8482712, name: 'Wyatt Johnston', team: 'DAL', position: 'forward', cost: 2 },
  { nhl_id: 8478398, name: 'Kyle Connor', team: 'WPG', position: 'forward', cost: 3 },
  { nhl_id: 8480069, name: 'Cale Makar', team: 'COL', position: 'defense', cost: 4 },
  
  // Western Defense
  { nhl_id: 8477903, name: 'Miro Heiskanen', team: 'DAL', position: 'defense', cost: 3 },
  { nhl_id: 8479325, name: 'Evan Bouchard', team: 'EDM', position: 'defense', cost: 3 },
  { nhl_id: 8476879, name: 'Josh Morrissey', team: 'WPG', position: 'defense', cost: 3 },
  { nhl_id: 8476891, name: 'Darnell Nurse', team: 'EDM', position: 'defense', cost: 2 },
  { nhl_id: 8479394, name: 'Thomas Harley', team: 'DAL', position: 'defense', cost: 2 },
  
  // Western Goalies
  { nhl_id: 8477424, name: 'Stuart Skinner', team: 'EDM', position: 'goalie', cost: 2 },
  { nhl_id: 8476883, name: 'Jake Oettinger', team: 'DAL', position: 'goalie', cost: 3 },
  { nhl_id: 8480382, name: 'Connor Hellebuyck', team: 'WPG', position: 'goalie', cost: 3 },
  
  // Eastern Forwards
  { nhl_id: 8478427, name: 'Auston Matthews', team: 'TOR', position: 'forward', cost: 4 },
  { nhl_id: 8477493, name: 'Mitch Marner', team: 'TOR', position: 'forward', cost: 3 },
  { nhl_id: 8476456, name: 'Nikita Kucherov', team: 'TBL', position: 'forward', cost: 4 },
  { nhl_id: 8478010, name: 'Brayden Point', team: 'TBL', position: 'forward', cost: 3 },
  { nhl_id: 8480012, name: 'Aleksander Barkov', team: 'FLA', position: 'forward', cost: 3 },
  { nhl_id: 8479542, name: 'Matthew Tkachuk', team: 'FLA', position: 'forward', cost: 3 },
  { nhl_id: 8477932, name: 'Sebastian Aho', team: 'CAR', position: 'forward', cost: 3 },
  { nhl_id: 8478366, name: 'David Pastrnak', team: 'BOS', position: 'forward', cost: 4 },
  { nhl_id: 8480039, name: 'Artemi Panarin', team: 'NYR', position: 'forward', cost: 3 },
  { nhl_id: 8481559, name: 'Jack Hughes', team: 'NJD', position: 'forward', cost: 3 },
  { nhl_id: 8481477, name: 'Sam Reinhart', team: 'FLA', position: 'forward', cost: 3 },
  { nhl_id: 8478550, name: 'Andrei Svechnikov', team: 'CAR', position: 'forward', cost: 3 },
  
  // Eastern Defense
  { nhl_id: 8480801, name: 'Adam Fox', team: 'NYR', position: 'defense', cost: 4 },
  { nhl_id: 8476853, name: 'Victor Hedman', team: 'TBL', position: 'defense', cost: 3 },
  { nhl_id: 8476457, name: 'Charlie McAvoy', team: 'BOS', position: 'defense', cost: 3 },
  { nhl_id: 8479410, name: 'Aaron Ekblad', team: 'FLA', position: 'defense', cost: 2 },
  { nhl_id: 8476792, name: 'Jaccob Slavin', team: 'CAR', position: 'defense', cost: 3 },
  { nhl_id: 8479323, name: 'Dougie Hamilton', team: 'NJD', position: 'defense', cost: 3 },
  
  // Eastern Goalies
  { nhl_id: 8477180, name: 'Sergei Bobrovsky', team: 'FLA', position: 'goalie', cost: 3 },
  { nhl_id: 8476945, name: 'Andrei Vasilevskiy', team: 'TBL', position: 'goalie', cost: 3 },
  { nhl_id: 8479496, name: 'Igor Shesterkin', team: 'NYR', position: 'goalie', cost: 4 }
];

async function seed() {
  console.log('🌱 Starting database seed...\n');

  try {
    // Insert teams
    console.log('Inserting teams...');
    for (const team of TEAMS) {
      await pool.query(`
        INSERT INTO teams (abbrev, name, conference, color)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (abbrev) DO UPDATE SET
          name = $2, conference = $3, color = $4
      `, [team.abbrev, team.name, team.conference, team.color]);
    }
    console.log(`✓ Inserted ${TEAMS.length} teams\n`);

    // Insert players
    console.log('Inserting players...');
    for (const player of PLAYERS) {
      await pool.query(`
        INSERT INTO players (nhl_id, name, team_abbrev, position, cost)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (nhl_id) DO UPDATE SET
          name = $2, team_abbrev = $3, position = $4, cost = $5
      `, [player.nhl_id, player.name, player.team, player.position, player.cost]);
    }
    console.log(`✓ Inserted ${PLAYERS.length} players\n`);

    // Initialize player stats (all zeros)
    console.log('Initializing player stats...');
    const playersResult = await pool.query('SELECT id FROM players');
    for (const player of playersResult.rows) {
      for (const round of [1, 2, 3]) {
        await pool.query(`
          INSERT INTO player_stats (player_id, round, goals, assists, wins, shutouts, games_played)
          VALUES ($1, $2, 0, 0, 0, 0, 0)
          ON CONFLICT (player_id, round) DO NOTHING
        `, [player.id, round]);
      }
    }
    console.log(`✓ Initialized stats for ${playersResult.rows.length} players\n`);

    console.log('✅ Seed completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Run "npm run fetch-stats" to fetch live NHL stats');
    console.log('2. Start the server with "npm start"');

  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
