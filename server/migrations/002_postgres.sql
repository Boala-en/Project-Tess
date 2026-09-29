CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  identifier text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  pin_hash text NOT NULL,
  withdrawal_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  referral_code text NOT NULL UNIQUE,
  referred_by uuid REFERENCES users(id),
  identity_status text NOT NULL DEFAULT 'not_submitted' CHECK (identity_status IN ('not_submitted', 'pending', 'approved', 'rejected')),
  identity_rejection_reason text
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('general', 'trading', 'staking')),
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  PRIMARY KEY (user_id, kind)
);
CREATE TABLE IF NOT EXISTS demo_claims (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ledger_id uuid NOT NULL UNIQUE,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ledger (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  wallet text NOT NULL,
  amount_cents bigint NOT NULL,
  fee_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'completed',
  reference text NOT NULL UNIQUE,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_created ON ledger(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS tess_sessions (
  sid text PRIMARY KEY,
  sess jsonb NOT NULL,
  expires bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS tess_sessions_expiry ON tess_sessions(expires);
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  subject_id uuid REFERENCES users(id),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket text PRIMARY KEY,
  window_started timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0)
);