CREATE TABLE IF NOT EXISTS injection_pod_reservations (
    session_id UUID PRIMARY KEY,
    owner_ip_hash CHAR(64) NOT NULL,
    pod_name TEXT,
    status TEXT NOT NULL DEFAULT 'starting'
        CHECK (status IN ('starting', 'active', 'deleting')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS injection_pod_reservations_owner_status_idx
    ON injection_pod_reservations (owner_ip_hash, status);

CREATE INDEX IF NOT EXISTS injection_pod_reservations_updated_at_idx
    ON injection_pod_reservations (updated_at);


SELECT * FROM injection_pod_reservations;

SELECT COUNT(session_id) AS "session_count"
FROM injection_pod_reservations
WHERE owner_ip_hash = '8349ghdsfj';  

DELETE FROM injection_pod_reservations;

SELECT * from direct_pi_attempts;