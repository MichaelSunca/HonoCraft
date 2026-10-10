-- Forward-only P0 structure. No users, passwords or demo data are seeded.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='honocraft_web') THEN CREATE ROLE honocraft_web NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='honocraft_worker') THEN CREATE ROLE honocraft_worker NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='honocraft_maintenance') THEN CREATE ROLE honocraft_maintenance NOLOGIN; END IF;
END $$;

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code varchar(64) NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_-]{2,63}$'),
  name varchar(80) NOT NULL CHECK (char_length(name)>0), description varchar(500) NOT NULL DEFAULT '',
  is_builtin boolean NOT NULL DEFAULT false, is_delegable boolean NOT NULL DEFAULT false,
  is_registration_default_eligible boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION protect_role_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.is_builtin IS DISTINCT FROM OLD.is_builtin THEN
    RAISE EXCEPTION 'ROLE_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roles_identity_immutable BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION protect_role_identity();

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code varchar(100) NOT NULL UNIQUE, module varchar(64) NOT NULL,
  name_key text NOT NULL, description_key text NOT NULL, is_reserved boolean NOT NULL DEFAULT false,
  is_delegable boolean NOT NULL DEFAULT false, is_self_assignable boolean NOT NULL DEFAULT false,
  catalog_version integer NOT NULL DEFAULT 1 CHECK(catalog_version>0),
  CHECK(NOT is_reserved OR (NOT is_delegable AND NOT is_self_assignable))
);
CREATE TABLE permission_dependencies (
  permission_id uuid NOT NULL REFERENCES permissions(id), required_permission_id uuid NOT NULL REFERENCES permissions(id),
  PRIMARY KEY(permission_id,required_permission_id), CHECK(permission_id<>required_permission_id)
);
CREATE INDEX permission_dependencies_reverse ON permission_dependencies(required_permission_id);
CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id), permission_id uuid NOT NULL REFERENCES permissions(id), PRIMARY KEY(role_id,permission_id)
);
CREATE INDEX role_permissions_reverse ON role_permissions(permission_id);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(254) NOT NULL,
  normalized_email varchar(254) NOT NULL UNIQUE CHECK(normalized_email=lower(btrim(normalized_email))),
  display_name varchar(80) NOT NULL CHECK(char_length(btrim(display_name))>0), password_hash text,
  password_version integer NOT NULL DEFAULT 1 CHECK(password_version>0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','deleted')),
  creation_source text NOT NULL CHECK(creation_source IN ('registration','invitation','bootstrap')),
  email_verified_at timestamptz, authorization_version integer NOT NULL DEFAULT 1 CHECK(authorization_version>0),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), registration_role_id uuid REFERENCES roles(id), avatar_file_id uuid,
  locale text CHECK(locale IN ('zh-CN','en')), theme text CHECK(theme IN ('light','dark','system')),
  locked_until timestamptz, last_login_at timestamptz, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((status='deleted')=(deleted_at IS NOT NULL)),
  CHECK(status<>'active' OR (email_verified_at IS NOT NULL AND password_hash IS NOT NULL))
);
CREATE INDEX users_created ON users(created_at DESC,id DESC);
CREATE INDEX users_status_created ON users(status,created_at DESC,id DESC);
CREATE INDEX users_registration_role ON users(registration_role_id) WHERE registration_role_id IS NOT NULL;
CREATE INDEX users_email_search ON users USING gin(normalized_email gin_trgm_ops);
CREATE INDEX users_name_search ON users USING gin(display_name gin_trgm_ops);
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id), role_id uuid NOT NULL REFERENCES roles(id),
  assigned_by uuid REFERENCES users(id), assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(user_id,role_id)
);
CREATE INDEX user_roles_reverse ON user_roles(role_id,user_id);
CREATE INDEX user_roles_assigner ON user_roles(assigned_by) WHERE assigned_by IS NOT NULL;

CREATE TABLE system_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK(id=1),
  initialization_status text NOT NULL DEFAULT 'uninitialized' CHECK(initialization_status IN ('uninitialized','pending','initialized')),
  bootstrap_user_id uuid REFERENCES users(id), bootstrap_version integer NOT NULL DEFAULT 1 CHECK(bootstrap_version>0),
  initialized_at timestamptz, catalog_version integer NOT NULL DEFAULT 1,
  example_notes_enabled boolean NOT NULL DEFAULT false,
  CHECK((initialization_status='initialized')=(initialized_at IS NOT NULL))
);
INSERT INTO system_state(id) VALUES(1);
CREATE TABLE system_settings (
  key text PRIMARY KEY CHECK(key IN ('branding','security')), typed_value jsonb NOT NULL CHECK(jsonb_typeof(typed_value)='object'),
  registration_default_role_id uuid REFERENCES roles(id), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((key='security')=(registration_default_role_id IS NOT NULL))
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32), authorization_version integer NOT NULL CHECK(authorization_version>0),
  credential_epoch text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idle_expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, reauthenticated_at timestamptz,
  revoked_at timestamptz, revoked_reason text, ip inet NOT NULL, user_agent varchar(512) NOT NULL DEFAULT '',
  CHECK(idle_expires_at>=created_at AND absolute_expires_at>=created_at)
);
CREATE INDEX sessions_active_user ON sessions(user_id,last_seen_at DESC,id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry ON sessions(absolute_expires_at);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(254) NOT NULL,
  normalized_email varchar(254) NOT NULL CHECK(normalized_email=lower(btrim(normalized_email))), inviter_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','expired','revoked')), expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0), accepted_by uuid REFERENCES users(id), accepted_at timestamptz, terminal_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((status='accepted' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL) OR (status<>'accepted' AND accepted_by IS NULL AND accepted_at IS NULL))
);
CREATE UNIQUE INDEX invites_pending_email ON invites(normalized_email) WHERE status='pending';
CREATE INDEX invites_created ON invites(created_at DESC,id DESC);
CREATE INDEX invites_inviter ON invites(inviter_id,status);
CREATE INDEX invites_expiry ON invites(expires_at) WHERE status='pending';
CREATE TABLE invite_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invite_id uuid NOT NULL REFERENCES invites(id), role_id uuid REFERENCES roles(id),
  role_id_at_issue uuid NOT NULL, role_code varchar(64) NOT NULL, role_name varchar(80) NOT NULL,
  role_version_at_issue integer NOT NULL CHECK(role_version_at_issue>0), UNIQUE(invite_id,role_id_at_issue)
);
CREATE INDEX invite_roles_live ON invite_roles(role_id) WHERE role_id IS NOT NULL;
CREATE TABLE email_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), requested_by uuid NOT NULL REFERENCES users(id),
  initiated_by_self boolean NOT NULL, new_email varchar(254) NOT NULL,
  normalized_new_email varchar(254) NOT NULL CHECK(normalized_new_email=lower(btrim(normalized_new_email))),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled','expired')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), expires_at timestamptz NOT NULL, terminal_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(id,user_id)
);
CREATE UNIQUE INDEX email_change_pending_user ON email_change_requests(user_id) WHERE status='pending';
CREATE INDEX email_change_user_created ON email_change_requests(user_id,created_at DESC);
CREATE INDEX email_change_requester ON email_change_requests(requested_by);
CREATE INDEX email_change_expiry ON email_change_requests(expires_at) WHERE status='pending';
CREATE TABLE one_time_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purpose text NOT NULL CHECK(purpose IN ('email_verify','password_reset','invite_accept','email_change','bootstrap','operator_recovery')),
  token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32), user_id uuid REFERENCES users(id), invite_id uuid REFERENCES invites(id),
  email_change_request_id uuid, subject_version integer NOT NULL CHECK(subject_version>0),
  target_email varchar(254) NOT NULL, normalized_target_email varchar(254) NOT NULL,
  credential_epoch text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz, revoked_at timestamptz, purpose_metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(purpose_metadata)='object'),
  FOREIGN KEY(email_change_request_id,user_id) REFERENCES email_change_requests(id,user_id),
  CHECK(consumed_at IS NULL OR revoked_at IS NULL),
  CHECK(
    (purpose IN ('email_verify','password_reset','bootstrap','operator_recovery') AND user_id IS NOT NULL AND invite_id IS NULL AND email_change_request_id IS NULL)
    OR (purpose='invite_accept' AND invite_id IS NOT NULL AND user_id IS NULL AND email_change_request_id IS NULL)
    OR (purpose='email_change' AND email_change_request_id IS NOT NULL AND user_id IS NOT NULL AND invite_id IS NULL)
  )
);
CREATE INDEX credentials_user_purpose ON one_time_credentials(user_id,purpose) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX credentials_invite ON one_time_credentials(invite_id) WHERE invite_id IS NOT NULL;
CREATE INDEX credentials_email_change ON one_time_credentials(email_change_request_id) WHERE email_change_request_id IS NOT NULL;
CREATE INDEX credentials_expiry ON one_time_credentials(expires_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL CHECK(actor_type IN ('user','operator','worker','anonymous')), actor_id uuid, actor_snapshot jsonb NOT NULL DEFAULT '{}',
  action text NOT NULL, target_type text NOT NULL, target_id uuid,
  result text NOT NULL CHECK(result IN ('success','denied','failed')), reason_code text, reason varchar(500), changes jsonb NOT NULL DEFAULT '{}',
  request_id uuid NOT NULL, ip inet, user_agent varchar(512)
);
CREATE INDEX audit_created ON audit_events(created_at DESC,id DESC);
CREATE INDEX audit_actor ON audit_events(actor_id,created_at DESC,id DESC);
CREATE INDEX audit_target ON audit_events(target_type,target_id,created_at DESC,id DESC);
CREATE INDEX audit_action ON audit_events(action,created_at DESC,id DESC);
CREATE TABLE security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), user_id uuid,
  event_type text NOT NULL, result text NOT NULL CHECK(result IN ('success','denied','failed')), reason_code text,
  target_digest bytea, request_id uuid NOT NULL, ip inet, user_agent varchar(512), allowed_metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX security_created ON security_events(created_at DESC,id DESC);
CREATE INDEX security_user ON security_events(user_id,created_at DESC,id DESC);
CREATE INDEX security_type ON security_events(event_type,created_at DESC,id DESC);

CREATE TABLE email_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_key text NOT NULL UNIQUE, purpose text NOT NULL,
  recipient varchar(254), recipient_masked text NOT NULL, credential_id uuid REFERENCES one_time_credentials(id),
  payload_ciphertext bytea, nonce bytea, auth_tag bytea, key_id text, template_version integer NOT NULL DEFAULT 1,
  locale text NOT NULL CHECK(locale IN ('zh-CN','en')), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3), next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner uuid, lease_version integer NOT NULL DEFAULT 0 CHECK(lease_version>=0), lease_expires_at timestamptz,
  provider_message_id text, error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((status='sending' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status<>'sending' AND lease_owner IS NULL AND lease_expires_at IS NULL)),
  CHECK(status IN ('queued','sending') OR (payload_ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND key_id IS NULL AND recipient IS NULL)),
  CHECK(status NOT IN ('queued','sending') OR (payload_ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND octet_length(nonce)=12 AND octet_length(auth_tag)=16 AND key_id IS NOT NULL AND recipient IS NOT NULL))
);
CREATE INDEX email_tasks_ready ON email_tasks(next_attempt_at,id) WHERE status='queued';
CREATE INDEX email_tasks_leased ON email_tasks(lease_expires_at,id) WHERE status='sending';
CREATE INDEX email_tasks_credential ON email_tasks(credential_id) WHERE credential_id IS NOT NULL;
CREATE INDEX email_tasks_created ON email_tasks(created_at DESC,id DESC);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES users(id), operation text NOT NULL,
  key_digest bytea NOT NULL CHECK(octet_length(key_digest)=32), request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32), digest_key_id text NOT NULL,
  target_type text NOT NULL, target_id uuid, policy_context jsonb NOT NULL DEFAULT '{}', result_summary jsonb NOT NULL,
  http_status smallint NOT NULL CHECK(http_status BETWEEN 200 AND 299), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  UNIQUE(actor_id,operation,key_digest)
);
CREATE INDEX idempotency_expiry ON idempotency_records(expires_at);
CREATE TABLE rate_limit_buckets (
  scope text NOT NULL, key_digest bytea NOT NULL CHECK(octet_length(key_digest)=32), window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK(count>=0), expires_at timestamptz NOT NULL, locked_until timestamptz,
  last_accepted_at timestamptz, failure_window_started_at timestamptz, PRIMARY KEY(scope,key_digest,window_start)
);
CREATE INDEX rate_limit_expiry ON rate_limit_buckets(expires_at);
CREATE TABLE file_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), storage_key text NOT NULL UNIQUE CHECK(storage_key ~ '^[a-zA-Z0-9_-]+\.(webp|png)$'),
  owner_id uuid REFERENCES users(id), purpose text NOT NULL CHECK(purpose IN ('avatar','brand_logo','brand_favicon')),
  state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','attached','orphaned','deleting')),
  content_type text NOT NULL CHECK(content_type IN ('image/webp','image/png')), byte_size bigint NOT NULL CHECK(byte_size>=0),
  width integer NOT NULL CHECK(width>0), height integer NOT NULL CHECK(height>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_expires_at timestamptz,
  CHECK(purpose<>'avatar' OR owner_id IS NOT NULL)
);
CREATE INDEX file_objects_owner ON file_objects(owner_id);
CREATE INDEX file_objects_cleanup ON file_objects(state,created_at);
ALTER TABLE users ADD CONSTRAINT users_avatar_file_fk FOREIGN KEY(avatar_file_id) REFERENCES file_objects(id);
CREATE INDEX users_avatar ON users(avatar_file_id) WHERE avatar_file_id IS NOT NULL;
CREATE TABLE example_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
  title varchar(120) NOT NULL CHECK(char_length(btrim(title))>0), body text NOT NULL CHECK(char_length(body)<=20000),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX notes_owner_created ON example_notes(owner_id,created_at DESC,id DESC);
CREATE TABLE worker_heartbeats (
  worker_id uuid PRIMARY KEY, last_seen_at timestamptz NOT NULL, app_version text NOT NULL, credential_epoch_digest text NOT NULL
);

INSERT INTO roles(id,code,name,is_builtin,is_delegable,is_registration_default_eligible) VALUES
('00000000-0000-4000-8000-000000000001','super_admin','Super administrator',true,false,false),
('00000000-0000-4000-8000-000000000002','admin','Administrator',true,false,false),
('00000000-0000-4000-8000-000000000003','user','User',true,true,true);
INSERT INTO permissions(code,module,name_key,description_key,is_reserved,is_delegable)
SELECT code,split_part(code,':',1),'permissions.'||code,'permissions.'||code||'.description',reserved,NOT reserved FROM (VALUES
('user:read',false),('user:update',false),('user:update-email',false),('user:change-status',false),('user:delete',false),('user:reset-password',false),('user:assign-role',false),('user:manage-privileged',true),
('invite:read',false),('invite:manage',false),('role:read',false),('role:manage',false),('role:delegate',true),('permission:read',false),('audit:read',false),('security-log:read',false),('email-task:read',false),('settings:read',false),('settings:update-branding',false),('settings:update-security',true)
) AS catalog(code,reserved);
INSERT INTO permission_dependencies(permission_id,required_permission_id)
SELECT p.id,r.id FROM (VALUES
('user:update','user:read'),('user:update-email','user:read'),('user:change-status','user:read'),('user:delete','user:read'),('user:reset-password','user:read'),('user:assign-role','user:read'),('user:assign-role','role:read'),
('invite:manage','invite:read'),('invite:manage','role:read'),('role:manage','role:read'),('role:manage','permission:read'),('settings:update-branding','settings:read'),('settings:update-security','settings:read')
) AS deps(code,required) JOIN permissions p ON p.code=deps.code JOIN permissions r ON r.code=deps.required;
INSERT INTO role_permissions(role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000002',id FROM permissions WHERE is_delegable;
INSERT INTO system_settings(key,typed_value) VALUES('branding','{"instance_name":"HonoCraft","copyright":"","default_locale":"zh-CN","default_theme":"system","timezone":"UTC","logo_file_id":null,"favicon_file_id":null}');
INSERT INTO system_settings(key,registration_default_role_id,typed_value) VALUES('security','00000000-0000-4000-8000-000000000003','{"registration_open":false,"password_min_length":15,"session_idle_minutes":30,"session_absolute_minutes":480,"email_verify_hours":24,"password_reset_minutes":30,"invite_hours":72,"email_change_hours":24,"login_ip_per_minute":20,"account_failures_per_window":5,"account_lock_minutes":15,"mail_cooldown_seconds":60,"mail_target_per_hour":5,"mail_ip_per_hour":20}');

GRANT USAGE ON SCHEMA public TO honocraft_web,honocraft_worker,honocraft_maintenance;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO honocraft_web;
GRANT INSERT,UPDATE,DELETE ON users,roles,user_roles,role_permissions,sessions,invites,invite_roles,email_change_requests,one_time_credentials,system_settings,idempotency_records,rate_limit_buckets,file_objects,example_notes,email_tasks TO honocraft_web;
GRANT SELECT ON system_state TO honocraft_web;
-- PostgreSQL row locks require UPDATE privilege on at least one column. The singleton ID cannot change.
GRANT UPDATE(id) ON system_state TO honocraft_web;
GRANT INSERT ON audit_events,security_events TO honocraft_web;
GRANT SELECT ON users,roles,user_roles,role_permissions,permissions,permission_dependencies,system_state,system_settings,invites,invite_roles,email_change_requests,one_time_credentials,file_objects TO honocraft_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON email_tasks,worker_heartbeats TO honocraft_worker;
GRANT UPDATE,DELETE ON file_objects TO honocraft_worker;
GRANT INSERT ON audit_events,security_events TO honocraft_worker;
GRANT SELECT,DELETE ON audit_events,security_events,sessions,one_time_credentials,idempotency_records,rate_limit_buckets,worker_heartbeats TO honocraft_maintenance;
GRANT SELECT,UPDATE,DELETE ON email_tasks TO honocraft_maintenance;
GRANT INSERT ON audit_events TO honocraft_maintenance;
