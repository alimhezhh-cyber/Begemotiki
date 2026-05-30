-- ============================================================
--  schema.sql — реляционная схема КопиМотик.
--  Восстановлена 1:1 из db_adapter.js (имена и алиасы колонок —
--  это контракт адаптера). Используется и браузерной сборкой
--  (sql.js), и бэкендом (node:sqlite / better-sqlite3).
-- ============================================================
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS financial_profiles (
  user_id            TEXT PRIMARY KEY,
  income             REAL    NOT NULL DEFAULT 0,
  mandatory_expenses REAL    NOT NULL DEFAULT 0,
  credit_payments    REAL    NOT NULL DEFAULT 0,
  savings            REAL    NOT NULL DEFAULT 0,
  income_stability   TEXT    NOT NULL DEFAULT 'stable',
  impulse_level      INTEGER NOT NULL DEFAULT 0,
  living_rent        REAL    NOT NULL DEFAULT 0,
  living_food        REAL    NOT NULL DEFAULT 0,
  living_other       REAL    NOT NULL DEFAULT 0,
  onboarded          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS debts (
  id              TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  monthly_payment REAL NOT NULL DEFAULT 0,
  balance         REAL NOT NULL DEFAULT 0,
  rate            REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id);

CREATE TABLE IF NOT EXISTS goals (
  id            TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  target_amount REAL    NOT NULL DEFAULT 0,
  months        INTEGER NOT NULL DEFAULT 6,
  saved         REAL    NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'active',
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);

CREATE TABLE IF NOT EXISTS purchase_plans (
  id              TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  price           REAL    NOT NULL DEFAULT 0,
  payment_type    TEXT    NOT NULL DEFAULT 'credit',
  monthly_payment REAL    NOT NULL DEFAULT 0,
  rate            REAL    NOT NULL DEFAULT 0,
  term            INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_plans_user ON purchase_plans(user_id);

CREATE TABLE IF NOT EXISTS user_progress (
  user_id           TEXT PRIMARY KEY,
  xp                INTEGER NOT NULL DEFAULT 0,
  level             INTEGER NOT NULL DEFAULT 1,
  streak            INTEGER NOT NULL DEFAULT 0,
  clean_streak      INTEGER NOT NULL DEFAULT 0,
  best_clean_streak INTEGER NOT NULL DEFAULT 0,
  last_check_in     TEXT
);

CREATE TABLE IF NOT EXISTS user_cosmetics (
  user_id   TEXT PRIMARY KEY,
  palette   TEXT NOT NULL DEFAULT 'mood',
  hat       TEXT NOT NULL DEFAULT 'none',
  accessory TEXT NOT NULL DEFAULT 'none'
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id         TEXT PRIMARY KEY,
  money_remind_at TEXT,
  flag_onboard    INTEGER NOT NULL DEFAULT 0,
  flag_checkin    INTEGER NOT NULL DEFAULT 0,
  flag_purchase   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checkins (
  id             TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  check_date     TEXT NOT NULL,
  score          INTEGER,
  status         TEXT,
  impulse_level  INTEGER,
  pdn            REAL,
  free_balance   REAL,
  cushion_months REAL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id, check_date);

CREATE TABLE IF NOT EXISTS user_lessons (
  user_id   TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  acked     INTEGER NOT NULL DEFAULT 0,
  shown_on  TEXT
);
CREATE INDEX IF NOT EXISTS idx_lessons_user ON user_lessons(user_id);

CREATE TABLE IF NOT EXISTS user_challenges (
  user_id      TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  progress     REAL    NOT NULL DEFAULT 0,
  claimed      INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenges_user ON user_challenges(user_id);

-- Универсальное KV-хранилище для НЕ-пользовательских ключей приложения
-- (km:users — аккаунты, km:session — текущий вход). Так весь стейт
-- приложения целиком лежит в одном .sqlite, не расширяя контракт адаптера.
CREATE TABLE IF NOT EXISTS app_kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);
