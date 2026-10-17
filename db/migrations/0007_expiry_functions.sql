-- Worker-owned expiration only: no arbitrary user, state, timestamp, or SQL parameters.
CREATE FUNCTION expire_pending_invites(p_batch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE candidates uuid[]; affected uuid[]; run_id uuid:=gen_random_uuid(); total integer;
BEGIN
  IF p_batch IS NULL OR p_batch<1 OR p_batch>100 THEN RAISE EXCEPTION 'INVALID_MAINTENANCE_BATCH' USING ERRCODE='22023'; END IF;
  PERFORM id FROM public.system_state WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SYSTEM_STATE_MISSING' USING ERRCODE='55000'; END IF;
  SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO candidates FROM
    (SELECT id FROM public.invites WHERE status='pending' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_batch) selected;
  PERFORM u.id FROM public.users u WHERE u.id IN(SELECT inviter_id FROM public.invites WHERE id=ANY(candidates)) ORDER BY u.id FOR UPDATE;
  PERFORM r.id FROM public.roles r WHERE r.id IN(SELECT role_id FROM public.invite_roles WHERE invite_id=ANY(candidates)) ORDER BY r.id FOR SHARE;
  SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO candidates FROM
    (SELECT id FROM public.invites WHERE id=ANY(candidates) AND status='pending' AND expires_at<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED) locked;
  IF cardinality(candidates)=0 THEN RETURN 0; END IF;
  INSERT INTO public.audit_events(actor_type,action,target_type,result,request_id,ip,user_agent,changes)
    VALUES('worker','maintenance.invites.started','maintenance','success',run_id,'127.0.0.1','HonoCraft expiry',jsonb_build_object('affected_count',cardinality(candidates)));
  PERFORM id FROM public.one_time_credentials WHERE invite_id=ANY(candidates) ORDER BY id FOR UPDATE;
  WITH changed AS(UPDATE public.invites SET status='expired',version=version+1,terminal_reason='EXPIRED',updated_at=clock_timestamp()
    WHERE id=ANY(candidates) AND status='pending' AND expires_at<=clock_timestamp() RETURNING id)
    SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO affected FROM changed;
  UPDATE public.one_time_credentials SET revoked_at=clock_timestamp() WHERE invite_id=ANY(affected) AND consumed_at IS NULL AND revoked_at IS NULL;
  UPDATE public.email_tasks t SET status='cancelled',error_code='CREDENTIAL_INVALID',lease_owner=NULL,lease_expires_at=NULL,lease_version=t.lease_version+1,
    recipient=NULL,payload_ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_id=NULL,updated_at=clock_timestamp()
    FROM public.one_time_credentials c WHERE t.credential_id=c.id AND c.invite_id=ANY(affected) AND t.status IN('queued','sending');
  INSERT INTO public.audit_events(actor_type,action,target_type,target_id,result,request_id,ip,user_agent,changes)
    SELECT 'worker','invitations.invite.expired','invite',id,'success',run_id,'127.0.0.1','HonoCraft expiry',
      jsonb_build_object('before_version',version-1,'after_version',version,'status_before','pending','status_after','expired') FROM public.invites WHERE id=ANY(affected);
  total:=cardinality(affected);
  INSERT INTO public.audit_events(actor_type,action,target_type,result,request_id,ip,user_agent,changes)
    VALUES('worker','maintenance.invites.completed','maintenance','success',run_id,'127.0.0.1','HonoCraft expiry',jsonb_build_object('affected_count',total));
  RETURN total;
END $$;

CREATE FUNCTION expire_email_change_requests(p_batch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE candidates uuid[]; affected uuid[]; run_id uuid:=gen_random_uuid(); total integer;
BEGIN
  IF p_batch IS NULL OR p_batch<1 OR p_batch>100 THEN RAISE EXCEPTION 'INVALID_MAINTENANCE_BATCH' USING ERRCODE='22023'; END IF;
  PERFORM id FROM public.system_state WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SYSTEM_STATE_MISSING' USING ERRCODE='55000'; END IF;
  SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO candidates FROM
    (SELECT id FROM public.email_change_requests WHERE status='pending' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_batch) selected;
  PERFORM u.id FROM public.users u WHERE u.id IN(SELECT user_id FROM public.email_change_requests WHERE id=ANY(candidates)
    UNION SELECT requested_by FROM public.email_change_requests WHERE id=ANY(candidates)) ORDER BY u.id FOR UPDATE;
  SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO candidates FROM
    (SELECT id FROM public.email_change_requests WHERE id=ANY(candidates) AND status='pending' AND expires_at<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED) locked;
  IF cardinality(candidates)=0 THEN RETURN 0; END IF;
  INSERT INTO public.audit_events(actor_type,action,target_type,result,request_id,ip,user_agent,changes)
    VALUES('worker','maintenance.email_changes.started','maintenance','success',run_id,'127.0.0.1','HonoCraft expiry',jsonb_build_object('affected_count',cardinality(candidates)));
  PERFORM id FROM public.one_time_credentials WHERE email_change_request_id=ANY(candidates) ORDER BY id FOR UPDATE;
  WITH changed AS(UPDATE public.email_change_requests SET status='expired',version=version+1,terminal_reason='EXPIRED',updated_at=clock_timestamp()
    WHERE id=ANY(candidates) AND status='pending' AND expires_at<=clock_timestamp() RETURNING id)
    SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO affected FROM changed;
  UPDATE public.one_time_credentials SET revoked_at=clock_timestamp() WHERE email_change_request_id=ANY(affected) AND consumed_at IS NULL AND revoked_at IS NULL;
  UPDATE public.email_tasks t SET status='cancelled',error_code='CREDENTIAL_INVALID',lease_owner=NULL,lease_expires_at=NULL,lease_version=t.lease_version+1,
    recipient=NULL,payload_ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_id=NULL,updated_at=clock_timestamp()
    FROM public.one_time_credentials c WHERE t.credential_id=c.id AND c.email_change_request_id=ANY(affected) AND t.status IN('queued','sending');
  INSERT INTO public.audit_events(actor_type,action,target_type,target_id,result,request_id,ip,user_agent,changes)
    SELECT 'worker','users.email_change.expired','email_change',id,'success',run_id,'127.0.0.1','HonoCraft expiry',
      jsonb_build_object('before_version',version-1,'after_version',version,'status_before','pending','status_after','expired') FROM public.email_change_requests WHERE id=ANY(affected);
  total:=cardinality(affected);
  INSERT INTO public.audit_events(actor_type,action,target_type,result,request_id,ip,user_agent,changes)
    VALUES('worker','maintenance.email_changes.completed','maintenance','success',run_id,'127.0.0.1','HonoCraft expiry',jsonb_build_object('affected_count',total));
  RETURN total;
END $$;

CREATE FUNCTION expire_one_time_credentials(p_batch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE candidates uuid[]; affected uuid[]; run_id uuid:=gen_random_uuid(); total integer;
BEGIN
  IF p_batch IS NULL OR p_batch<1 OR p_batch>100 THEN RAISE EXCEPTION 'INVALID_MAINTENANCE_BATCH' USING ERRCODE='22023'; END IF;
  PERFORM id FROM public.system_state WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SYSTEM_STATE_MISSING' USING ERRCODE='55000'; END IF;
  SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO candidates FROM
    (SELECT id FROM public.one_time_credentials WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at<=clock_timestamp()
      ORDER BY expires_at,id LIMIT p_batch FOR UPDATE SKIP LOCKED) locked;
  IF cardinality(candidates)=0 THEN RETURN 0; END IF;
  INSERT INTO public.audit_events(actor_type,action,target_type,result,request_id,ip,user_agent,changes)
    VALUES('worker','maintenance.credentials.started','maintenance','success',run_id,'127.0.0.1','HonoCraft expiry',jsonb_build_object('affected_count',cardinality(candidates)));
  WITH changed AS(UPDATE public.one_time_credentials SET revoked_at=clock_timestamp()
    WHERE id=ANY(candidates) AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at<=clock_timestamp() RETURNING id)
    SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO affected FROM changed;
  UPDATE public.email_tasks SET status='cancelled',error_code='CREDENTIAL_INVALID',lease_owner=NULL,lease_expires_at=NULL,lease_version=lease_version+1,
    recipient=NULL,payload_ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_id=NULL,updated_at=clock_timestamp()
    WHERE credential_id=ANY(affected) AND status IN('queued','sending');
  total:=cardinality(affected);
  INSERT INTO public.audit_events(actor_type,action,target_type,result,request_id,ip,user_agent,changes)
    VALUES('worker','maintenance.credentials.completed','maintenance','success',run_id,'127.0.0.1','HonoCraft expiry',jsonb_build_object('affected_count',total));
  RETURN total;
END $$;

REVOKE ALL ON FUNCTION expire_pending_invites(integer),expire_email_change_requests(integer),expire_one_time_credentials(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_pending_invites(integer),expire_email_change_requests(integer),expire_one_time_credentials(integer) TO honocraft_worker;
