-- NetSports Fantasy Database Schema
-- Run this to set up your PostgreSQL database

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  verification_code VARCHAR(6),
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on username and email for faster lookups
CREATE INDEX idx_users_username ON users(LOWER(username));
CREATE INDEX idx_users_email ON users(LOWER(email));

-- NHL Teams
CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  abbrev VARCHAR(3) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  conference VARCHAR(10) NOT NULL CHECK (conference IN ('western', 'eastern')),
  is_eliminated BOOLEAN DEFAULT FALSE,
  eliminated_round INT,
  color VARCHAR(7),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- NHL Players
CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nhl_id INT UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  team_abbrev VARCHAR(3) REFERENCES teams(abbrev),
  position VARCHAR(10) NOT NULL CHECK (position IN ('forward', 'defense', 'goalie')),
  cost INT NOT NULL CHECK (cost >= 1 AND cost <= 5),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_players_team ON players(team_abbrev);
CREATE INDEX idx_players_position ON players(position);

-- Player Stats (updated from NHL API)
CREATE TABLE player_stats (
  id SERIAL PRIMARY KEY,
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  round INT NOT NULL CHECK (round >= 1 AND round <= 3),
  goals INT DEFAULT 0,
  assists INT DEFAULT 0,
  wins INT DEFAULT 0,
  shutouts INT DEFAULT 0,
  games_played INT DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(player_id, round)
);

CREATE INDEX idx_player_stats_player ON player_stats(player_id);

-- User Rosters (one per user per round)
CREATE TABLE rosters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  round INT NOT NULL CHECK (round >= 1 AND round <= 3),
  is_submitted BOOLEAN DEFAULT FALSE,
  submitted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, round)
);

-- Roster Players (players selected for each roster)
CREATE TABLE roster_players (
  id SERIAL PRIMARY KEY,
  roster_id UUID REFERENCES rosters(id) ON DELETE CASCADE,
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  is_star BOOLEAN DEFAULT FALSE,
  UNIQUE(roster_id, player_id)
);

CREATE INDEX idx_roster_players_roster ON roster_players(roster_id);

-- User Tiebreakers (per round)
CREATE TABLE tiebreakers (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  round INT NOT NULL CHECK (round >= 1 AND round <= 3),
  question1_answer INT,
  question2_answer INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, round)
);

-- Groups
CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  code VARCHAR(8) UNIQUE NOT NULL,
  is_private BOOLEAN DEFAULT FALSE,
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  blast_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_groups_code ON groups(UPPER(code));

-- Group Members
CREATE TABLE group_members (
  id SERIAL PRIMARY KEY,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

-- Group Chat Messages
CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_group ON chat_messages(group_id, created_at DESC);

-- System Settings
CREATE TABLE settings (
  key VARCHAR(50) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default settings
INSERT INTO settings (key, value) VALUES 
  ('current_round', '2'),
  ('lock_dates', '{"1": "2026-04-19T19:00:00-04:00", "2": "2026-05-03T19:00:00-04:00", "3": "2026-05-17T19:00:00-04:00"}'),
  ('stats_last_updated', 'null'),
  ('stats_verified', 'false');

-- Stat update log (for tracking API fetches)
CREATE TABLE stat_update_log (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  players_updated INT DEFAULT 0,
  errors TEXT[],
  status VARCHAR(20) DEFAULT 'running'
);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Add triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_players_updated_at BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rosters_updated_at BEFORE UPDATE ON rosters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_groups_updated_at BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- View for leaderboard calculation
CREATE OR REPLACE VIEW leaderboard AS
SELECT 
  u.id as user_id,
  u.username,
  COALESCE(SUM(
    CASE 
      WHEN p.position IN ('forward', 'defense') THEN 
        (ps.goals + ps.assists) * (CASE WHEN rp.is_star THEN 2 ELSE 1 END)
      ELSE 
        (ps.wins * 2 + ps.shutouts) * (CASE WHEN rp.is_star THEN 2 ELSE 1 END)
    END
  ), 0) as total_points,
  COALESCE(SUM(CASE WHEN ps.round = 1 THEN 
    CASE 
      WHEN p.position IN ('forward', 'defense') THEN 
        (ps.goals + ps.assists) * (CASE WHEN rp.is_star THEN 2 ELSE 1 END)
      ELSE 
        (ps.wins * 2 + ps.shutouts) * (CASE WHEN rp.is_star THEN 2 ELSE 1 END)
    END
  ELSE 0 END), 0) as r1_points,
  COALESCE(SUM(CASE WHEN ps.round = 2 THEN 
    CASE 
      WHEN p.position IN ('forward', 'defense') THEN 
        (ps.goals + ps.assists) * (CASE WHEN rp.is_star THEN 2 ELSE 1 END)
      ELSE 
        (ps.wins * 2 + ps.shutouts) * (CASE WHEN rp.is_star THEN 2 ELSE 1 END)
    END
  ELSE 0 END), 0) as r2_points,
  COALESCE(SUM(CASE WHEN ps.round = 3 THEN 
    CASE 
      WHEN p.position IN ('forward', 'defense') THEN 
        (ps.goals + ps.assists) * (CASE WHEN rp.is_star THEN 2 ELSE 1 END)
      ELSE 
        (ps.wins * 2 + ps.shutouts) * (CASE WHEN rp.is_star THEN 2 ELSE 1 END)
    END
  ELSE 0 END), 0) as r3_points
FROM users u
LEFT JOIN rosters r ON u.id = r.user_id AND r.is_submitted = true
LEFT JOIN roster_players rp ON r.id = rp.roster_id
LEFT JOIN players p ON rp.player_id = p.id
LEFT JOIN player_stats ps ON p.id = ps.player_id AND r.round = ps.round
WHERE u.is_verified = true
GROUP BY u.id, u.username
ORDER BY total_points DESC;
