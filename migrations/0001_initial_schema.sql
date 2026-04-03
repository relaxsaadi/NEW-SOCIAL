-- USERS (Créés à la volée via email Stripe)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  marketing_consent INTEGER DEFAULT 0,
  locale TEXT DEFAULT 'fr',
  source TEXT
);

-- ANALYSES
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  offer_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  context_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  input_text TEXT,
  extra_context TEXT,
  goal TEXT,
  ai_result_json TEXT,
  confidence_score REAL,
  risk_flags_json TEXT,
  prompt_version TEXT DEFAULT 'v1.0.0',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_user_id ON analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_analyses_status ON analyses(status);

-- PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  analysis_id TEXT REFERENCES analyses(id),
  user_id TEXT REFERENCES users(id),
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'eur',
  status TEXT NOT NULL,
  offer_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_session ON payments(stripe_session_id);

-- UPSELLS
CREATE TABLE IF NOT EXISTS upsells (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES analyses(id),
  user_id TEXT REFERENCES users(id),
  upsell_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  stripe_session_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- PROMPTS_VERSIONS
CREATE TABLE IF NOT EXISTS prompts_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  prompt_type TEXT NOT NULL,
  content TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- EVENTS_LOGS
CREATE TABLE IF NOT EXISTS events_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  analysis_id TEXT,
  event_name TEXT NOT NULL,
  event_payload_json TEXT,
  created_at INTEGER NOT NULL
);

-- LEADS
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  email TEXT,
  source TEXT,
  created_at INTEGER NOT NULL
);
