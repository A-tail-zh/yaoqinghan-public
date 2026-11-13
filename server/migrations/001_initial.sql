CREATE TABLE IF NOT EXISTS invitations (
  id INT PRIMARY KEY,
  draft_json JSON NOT NULL,
  published_json JSON NULL,
  draft_revision INT NOT NULL DEFAULT 1,
  first_published_at DATETIME(3) NULL,
  expires_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS assets (
  id CHAR(36) PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  mime_type VARCHAR(80) NOT NULL,
  storage_key VARCHAR(100) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rsvps (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  invitation_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  party_size INT UNSIGNED NOT NULL,
  submission_key CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY submission (invitation_id, submission_key),
  FOREIGN KEY (invitation_id) REFERENCES invitations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(128) PRIMARY KEY,
  data JSON NOT NULL,
  expires_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
