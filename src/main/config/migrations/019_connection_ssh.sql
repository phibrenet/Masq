ALTER TABLE connections ADD COLUMN ssh_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connections ADD COLUMN ssh_host TEXT;
ALTER TABLE connections ADD COLUMN ssh_port INTEGER;
ALTER TABLE connections ADD COLUMN ssh_username TEXT;
ALTER TABLE connections ADD COLUMN ssh_auth_method TEXT;
ALTER TABLE connections ADD COLUMN ssh_private_key_path TEXT;
ALTER TABLE connections ADD COLUMN ssh_host_fingerprint TEXT;

-- Separate from DB credentials: SSH-only secrets need no dummy database password.
CREATE TABLE ssh_credentials (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  encrypted_secret BLOB NOT NULL
);
