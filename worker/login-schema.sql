-- Icy Rose Exchange • user accounts and secure sessions
-- Run once in the SAME D1 database bound as DB to your receipt Worker.
-- Safe to repeat. Existing inventory, catalogue, orders and receipts are untouched.
CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  password_hash TEXT,
  password_salt TEXT,
  iterations INTEGER NOT NULL DEFAULT 310000,
  must_change INTEGER NOT NULL DEFAULT 1,
  disabled INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_activity (
  event_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_auth_activity_latest ON auth_activity(created_at DESC);
-- Initial accounts have NO stored default password. For first login,
-- the Worker checks the private AUTH_BOOTSTRAP_CODE secret, then requires a personal password.
INSERT OR IGNORE INTO auth_users(id,username,role) VALUES ('seed-david','David','admin');
INSERT OR IGNORE INTO auth_users(id,username,role) VALUES ('seed-ice','Ice','admin');
INSERT OR IGNORE INTO auth_users(id,username,role) VALUES ('seed-rick','Rick','admin');
INSERT OR IGNORE INTO auth_users(id,username,role) VALUES ('seed-tink','Tink','admin');
INSERT OR IGNORE INTO auth_users(id,username,role) VALUES ('seed-tiff','Tiff','admin');
