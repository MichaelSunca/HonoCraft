-- The worker may reserve only the notification-delivery quota, never edit authentication limits.
CREATE FUNCTION reserve_notification_delivery(p_id uuid,p_owner uuid,p_version integer,p_digest bytea)
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
    VALUES ('mail.notification.delivery',p_digest,'1970-01-01 00:00:00+00',clock_timestamp()+interval '61 seconds') ON CONFLICT DO NOTHING;
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
