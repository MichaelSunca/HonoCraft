-- Dedicated maintenance can validate startup metadata, not edit identities or policy.
GRANT SELECT ON migration_history,system_state,permissions,permission_dependencies TO honocraft_maintenance;
GRANT SELECT(id,status) ON invites,email_change_requests TO honocraft_maintenance;

-- DELETE-only maintenance needs narrowly scoped row locks, not general audit UPDATE rights.
CREATE FUNCTION lock_retention_candidates(p_task text,p_days integer,p_batch integer)
RETURNS TABLE(candidate_id uuid,scope_key text,digest_key bytea,bucket_start text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_batch IS NULL OR p_batch<1 OR p_batch>1000 OR p_days IS NULL OR p_task IS NULL THEN
    RAISE EXCEPTION 'INVALID_RETENTION_SELECTION' USING ERRCODE='22023';
  END IF;
  IF (p_task IN('sessions','credentials','task_links') AND p_days<>7)
    OR (p_task='mail' AND p_days<>90) OR (p_task='heartbeats' AND p_days<>1)
    OR (p_task IN('idempotency','rate_limits') AND p_days<>0)
    OR (p_task IN('audit','security') AND (p_days<1 OR p_days>3650)) THEN
    RAISE EXCEPTION 'INVALID_RETENTION_PERIOD' USING ERRCODE='22023';
  END IF;
  CASE p_task
  WHEN 'sessions' THEN
    RETURN QUERY SELECT r.id,NULL::text,NULL::bytea,NULL::text FROM public.sessions r
      WHERE COALESCE(r.revoked_at,LEAST(r.idle_expires_at,r.absolute_expires_at))<=clock_timestamp()-p_days*interval '1 day'
      ORDER BY COALESCE(r.revoked_at,LEAST(r.idle_expires_at,r.absolute_expires_at)),r.id LIMIT p_batch FOR UPDATE OF r SKIP LOCKED;
  WHEN 'credentials' THEN
    RETURN QUERY SELECT r.id,NULL::text,NULL::bytea,NULL::text FROM public.one_time_credentials r
      WHERE COALESCE(r.consumed_at,r.revoked_at,r.expires_at)<=clock_timestamp()-p_days*interval '1 day'
      AND NOT EXISTS(SELECT 1 FROM public.invites i WHERE i.id=r.invite_id AND i.status='pending')
      AND NOT EXISTS(SELECT 1 FROM public.email_change_requests e WHERE e.id=r.email_change_request_id AND e.status='pending')
      AND NOT EXISTS(SELECT 1 FROM public.email_tasks t WHERE t.credential_id=r.id)
      ORDER BY COALESCE(r.consumed_at,r.revoked_at,r.expires_at),r.id LIMIT p_batch FOR UPDATE OF r SKIP LOCKED;
  WHEN 'task_links' THEN
    RETURN QUERY SELECT r.id,NULL::text,NULL::bytea,NULL::text FROM public.email_tasks r
      WHERE r.status IN('sent','failed','cancelled') AND r.credential_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM public.one_time_credentials c WHERE c.id=r.credential_id
        AND COALESCE(c.consumed_at,c.revoked_at,c.expires_at)<=clock_timestamp()-p_days*interval '1 day'
        AND NOT EXISTS(SELECT 1 FROM public.invites i WHERE i.id=c.invite_id AND i.status='pending')
        AND NOT EXISTS(SELECT 1 FROM public.email_change_requests e WHERE e.id=c.email_change_request_id AND e.status='pending')
        AND NOT EXISTS(SELECT 1 FROM public.email_tasks t WHERE t.credential_id=c.id AND t.status IN('queued','sending')))
      ORDER BY r.updated_at,r.id LIMIT p_batch FOR UPDATE OF r SKIP LOCKED;
  WHEN 'mail' THEN
    RETURN QUERY SELECT r.id,NULL::text,NULL::bytea,NULL::text FROM public.email_tasks r
      WHERE r.status IN('sent','failed','cancelled') AND r.updated_at<=clock_timestamp()-p_days*interval '1 day'
      ORDER BY r.updated_at,r.id LIMIT p_batch FOR UPDATE OF r SKIP LOCKED;
  WHEN 'idempotency' THEN
    RETURN QUERY SELECT r.id,NULL::text,NULL::bytea,NULL::text FROM public.idempotency_records r
      WHERE r.expires_at<=clock_timestamp()-p_days*interval '1 day'
      ORDER BY r.expires_at,r.id LIMIT p_batch FOR UPDATE OF r SKIP LOCKED;
  WHEN 'heartbeats' THEN
    RETURN QUERY SELECT r.worker_id,NULL::text,NULL::bytea,NULL::text FROM public.worker_heartbeats r
      WHERE r.last_seen_at<=clock_timestamp()-p_days*interval '1 day'
      ORDER BY r.last_seen_at,r.worker_id LIMIT p_batch FOR UPDATE OF r SKIP LOCKED;
  WHEN 'audit' THEN
    RETURN QUERY SELECT r.id,NULL::text,NULL::bytea,NULL::text FROM public.audit_events r
      WHERE r.created_at<=clock_timestamp()-p_days*interval '1 day'
      ORDER BY r.created_at,r.id LIMIT p_batch FOR UPDATE OF r SKIP LOCKED;
  WHEN 'security' THEN
    RETURN QUERY SELECT r.id,NULL::text,NULL::bytea,NULL::text FROM public.security_events r
      WHERE r.created_at<=clock_timestamp()-p_days*interval '1 day'
      ORDER BY r.created_at,r.id LIMIT p_batch FOR UPDATE OF r SKIP LOCKED;
  WHEN 'rate_limits' THEN
    -- Text retains PostgreSQL microseconds for this composite key across the JS boundary.
    RETURN QUERY SELECT NULL::uuid,r.scope,r.key_digest,r.window_start::text FROM public.rate_limit_buckets r
      WHERE r.expires_at<=clock_timestamp()-p_days*interval '1 day' AND (r.locked_until IS NULL OR r.locked_until<=clock_timestamp())
      AND (r.window_start<>'1970-01-01 00:00:00+00'::timestamptz OR NOT EXISTS(SELECT 1 FROM public.rate_limit_buckets c
        WHERE c.scope=r.scope AND c.key_digest=r.key_digest AND c.window_start<>'1970-01-01 00:00:00+00'::timestamptz AND c.expires_at>clock_timestamp()))
      ORDER BY r.expires_at,r.scope,r.key_digest,r.window_start LIMIT p_batch FOR UPDATE OF r SKIP LOCKED;
  ELSE RAISE EXCEPTION 'INVALID_RETENTION_TASK' USING ERRCODE='22023';
  END CASE;
END $$;
REVOKE ALL ON FUNCTION lock_retention_candidates(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_retention_candidates(text,integer,integer) TO honocraft_maintenance;

-- Preserve notification sentinel ownership against concurrent retention cleanup.
-- The worker may reserve only the notification-delivery quota, never edit authentication limits.
CREATE OR REPLACE FUNCTION reserve_notification_delivery(p_id uuid,p_owner uuid,p_version integer,p_digest bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  task public.email_tasks%ROWTYPE;
  stamp timestamptz;
  boundary timestamptz;
  total bigint;
  earliest timestamptz;
BEGIN
  IF p_digest IS NULL OR octet_length(p_digest)<>32 THEN RAISE EXCEPTION 'INVALID_NOTIFICATION_DIGEST'; END IF;
  SELECT * INTO task FROM public.email_tasks WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR task.status<>'sending' OR task.lease_owner IS DISTINCT FROM p_owner OR task.lease_version IS DISTINCT FROM p_version
    OR task.lease_expires_at<=clock_timestamp() THEN RETURN 'lease_lost'; END IF;
  IF task.credential_id IS NOT NULL OR task.purpose NOT IN ('password_changed','email_change_started','email_changed','account_suspended') THEN
    RAISE EXCEPTION 'INVALID_NOTIFICATION_TASK';
  END IF;
  INSERT INTO public.rate_limit_buckets(scope,key_digest,window_start,expires_at)
    VALUES ('mail.notification.delivery',p_digest,'1970-01-01 00:00:00+00',clock_timestamp()+interval '61 seconds') ON CONFLICT(scope,key_digest,window_start) DO UPDATE SET expires_at=public.rate_limit_buckets.expires_at;
  PERFORM 1 FROM public.rate_limit_buckets WHERE scope='mail.notification.delivery' AND key_digest=p_digest
    AND window_start='1970-01-01 00:00:00+00' FOR UPDATE;
  stamp:=clock_timestamp();
  IF task.lease_expires_at<=stamp THEN RETURN 'lease_lost'; END IF;
  boundary:=date_trunc('second',stamp-interval '60 seconds');
  SELECT COALESCE(sum(count),0),min(window_start) INTO total,earliest FROM public.rate_limit_buckets
    WHERE scope='mail.notification.delivery' AND key_digest=p_digest AND window_start>=boundary
    AND window_start<>'1970-01-01 00:00:00+00';
  IF total>=5 THEN
    UPDATE public.email_tasks SET status='queued',attempts=greatest(attempts-1,0),next_attempt_at=earliest+interval '61 seconds',
      lease_owner=NULL,lease_expires_at=NULL,lease_version=lease_version+1,error_code='NOTIFICATION_THROTTLED',updated_at=stamp WHERE id=p_id;
    RETURN 'queued';
  END IF;
  INSERT INTO public.rate_limit_buckets(scope,key_digest,window_start,count,expires_at)
    VALUES ('mail.notification.delivery',p_digest,date_trunc('second',stamp),1,date_trunc('second',stamp)+interval '61 seconds')
    ON CONFLICT(scope,key_digest,window_start) DO UPDATE SET count=public.rate_limit_buckets.count+1;
  UPDATE public.rate_limit_buckets SET last_accepted_at=stamp,expires_at=stamp+interval '61 seconds'
    WHERE scope='mail.notification.delivery' AND key_digest=p_digest AND window_start='1970-01-01 00:00:00+00';
  RETURN 'send';
END $$;
REVOKE ALL ON FUNCTION reserve_notification_delivery(uuid,uuid,integer,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_notification_delivery(uuid,uuid,integer,bytea) TO honocraft_worker;
