-- Runtime web can only advance a validated pending bootstrap, never reset initialization.
CREATE FUNCTION complete_bootstrap_state(p_user_id uuid,p_credential_id uuid,p_version integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.system_state s SET initialization_status='initialized',initialized_at=clock_timestamp()
  WHERE s.id=1 AND s.initialization_status='pending' AND s.bootstrap_user_id=p_user_id AND s.bootstrap_version=p_version
    AND EXISTS (
      SELECT 1 FROM public.users u JOIN public.user_roles ur ON ur.user_id=u.id JOIN public.roles r ON r.id=ur.role_id
      JOIN public.one_time_credentials c ON c.user_id=u.id
      WHERE u.id=p_user_id AND u.creation_source='bootstrap' AND u.status='active' AND u.email_verified_at IS NOT NULL
        AND u.password_hash IS NOT NULL AND r.code='super_admin' AND r.is_builtin
        AND c.id=p_credential_id AND c.purpose='bootstrap' AND c.subject_version=p_version
        AND c.consumed_at IS NOT NULL AND c.revoked_at IS NULL AND c.expires_at>c.consumed_at
    );
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION complete_bootstrap_state(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_bootstrap_state(uuid,uuid,integer) TO honocraft_web;
