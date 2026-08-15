-- Fantasy LoL - Datenmodell
--
-- Zwei Hälften, die bewusst getrennt bleiben:
--   1. Spielbetrieb (users, leagues, members, squads) - schreibt die App.
--   2. Statistik (players, rounds, player_round, prices, lines, fixtures) -
--      schreibt ausschließlich der Sammler über /api/ingest. Diese Tabellen
--      sind aus Sicht der App nur lesbar; ein Neuaufbau der Statistik löscht
--      deshalb nie einen Kader.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,   -- kleingeschrieben, damit "Domi" und "domi" dieselbe Person sind
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS leagues (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  budget      REAL NOT NULL DEFAULT 35.0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  league_id   TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (league_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);

-- Ein Platz je Rolle. Der bezahlte Preis wird mitgeschrieben: spätere
-- Preisänderungen entwerten einen Kader dadurch nicht.
CREATE TABLE IF NOT EXISTS squads (
  league_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  round_key   TEXT NOT NULL,
  role        TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  paid        REAL NOT NULL,
  PRIMARY KEY (league_id, user_id, round_key, role)
);

CREATE TABLE IF NOT EXISTS squad_meta (
  league_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  round_key   TEXT NOT NULL,
  captain     TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (league_id, user_id, round_key)
);

-- ---------------------------------------------------------------- Statistik

CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  team_id       TEXT,
  team          TEXT,
  code          TEXT,
  league        TEXT,
  image         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  season_pts    REAL NOT NULL DEFAULT 0,
  season_games  INTEGER NOT NULL DEFAULT 0,
  season_avg    REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_players_role ON players(role);

CREATE TABLE IF NOT EXISTS rounds (
  round_key   TEXT PRIMARY KEY,
  start_at    INTEGER NOT NULL,
  end_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_round (
  round_key   TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  pts         REAL NOT NULL,
  games       INTEGER NOT NULL,
  PRIMARY KEY (round_key, player_id)
);

CREATE TABLE IF NOT EXISTS prices (
  round_key   TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  price       REAL NOT NULL,
  PRIMARY KEY (round_key, player_id)
);

-- Einzelne Spielzeilen für die Aufschlüsselung ("warum 34 Punkte?").
CREATE TABLE IF NOT EXISTS lines (
  game_id     TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  round_key   TEXT NOT NULL,
  match_id    TEXT,
  league      TEXT,
  champion    TEXT,
  k           INTEGER NOT NULL DEFAULT 0,
  d           INTEGER NOT NULL DEFAULT 0,
  a           INTEGER NOT NULL DEFAULT 0,
  cs          INTEGER NOT NULL DEFAULT 0,
  pts         REAL NOT NULL DEFAULT 0,
  win_bonus   INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_lines_round ON lines(round_key, player_id);

-- Wann ein Team in einer Runde zum ersten Mal spielt. Daran hängt die Sperre:
-- ein Platz ist fest, sobald das Team des Spielers angepfiffen hat.
CREATE TABLE IF NOT EXISTS fixtures (
  round_key   TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  first_start INTEGER NOT NULL,
  PRIMARY KEY (round_key, team_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
