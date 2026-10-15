import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {text} from '@honocraft/contracts/common';
import {permissionDefinitions} from '@honocraft/contracts/permissions';
import {withTransaction} from '../../infrastructure/db.js';
import {checkPermissionCatalog} from '../../infrastructure/catalog.js';
import {lockIdentityRows} from '../access/repository.js';
import {appendAudit,type RequestMeta} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';
import {cancelCredentialTasks} from '../mail/cancellation.js';
const inputSchema=z.strictObject({enabled:z.boolean(),reason:z.string().trim().pipe(text(1,500))});
const definitions=permissionDefinitions.filter(permission=>permission.code.startsWith('example-note:'));
/** Explicit operator catalog migration. Never called by HTTP, startup, or normal web credentials. */
export async function setExampleNotesEnabled(pool:Pool,input:unknown,meta:RequestMeta){
  const parsed=inputSchema.safeParse(input);if(!parsed.success)throw new AppError('VALIDATION_ERROR');
  const desired=parsed.data.enabled;
  return withTransaction(pool,'exclusive',async tx=>{
    const state=(await tx.query<{example_notes_enabled:boolean}>('SELECT example_notes_enabled FROM system_state WHERE id=1')).rows[0];
    if(!state)throw new AppError('DEPENDENCY_UNAVAILABLE');
    await checkPermissionCatalog(tx,state.example_notes_enabled);
    if(state.example_notes_enabled===desired)return {changed:false,enabled:desired,roles_affected:0,users_affected:0,invites_revoked:0,permissions_changed:0};
    // The built-in super administrator implicitly owns the entire registered catalog.
    const roleIds=(await tx.query<{id:string}>(`SELECT r.id FROM roles r WHERE (r.is_builtin AND r.code='super_admin')
      OR EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id AND p.module='example-note') ORDER BY r.id`)).rows.map(row=>row.id);
    const userIds=(await tx.query<{user_id:string}>('SELECT DISTINCT user_id FROM user_roles WHERE role_id=ANY($1::uuid[]) ORDER BY user_id',[roleIds])).rows.map(row=>row.user_id);
    const invites=(await tx.query<{id:string;inviter_id:string;version:number}>(`SELECT i.id,i.inviter_id,i.version FROM invites i WHERE i.status='pending'
      AND EXISTS(SELECT 1 FROM invite_roles ir WHERE ir.invite_id=i.id AND ir.role_id=ANY($1::uuid[])) ORDER BY i.id`,[roleIds])).rows;
    await lockIdentityRows(tx,[...userIds,...invites.map(invite=>invite.inviter_id)],roleIds,'update');
    await tx.query('SELECT id FROM sessions WHERE user_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[userIds]);
    const inviteIds=invites.map(invite=>invite.id);
    await tx.query('SELECT id FROM invites WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[inviteIds]);
    await tx.query('SELECT id FROM one_time_credentials WHERE invite_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[inviteIds]);
    if(desired){
      for(const permission of definitions)await tx.query(`INSERT INTO permissions(code,module,name_key,description_key,is_reserved,is_delegable,is_self_assignable,catalog_version)
        VALUES($1,'example-note',$2,$3,$4,$5,$6,1)`,[permission.code,'permissions.'+permission.code,'permissions.'+permission.code+'.description',permission.reserved,permission.delegable,permission.selfAssignable]);
      for(const permission of definitions)for(const dependency of permission.dependencies)await tx.query('INSERT INTO permission_dependencies(permission_id,required_permission_id) SELECT p.id,r.id FROM permissions p CROSS JOIN permissions r WHERE p.code=$1 AND r.code=$2',[permission.code,dependency]);
    }else{
      const ids=(await tx.query<{id:string}>("SELECT id FROM permissions WHERE module='example-note' ORDER BY id")).rows.map(row=>row.id);
      await tx.query('DELETE FROM permission_dependencies WHERE permission_id=ANY($1::uuid[]) OR required_permission_id=ANY($1::uuid[])',[ids]);
      await tx.query('DELETE FROM role_permissions WHERE permission_id=ANY($1::uuid[])',[ids]);
      await tx.query('DELETE FROM permissions WHERE id=ANY($1::uuid[])',[ids]);
    }
    await tx.query('UPDATE roles SET version=version+1,updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])',[roleIds]);
    await tx.query('UPDATE users SET version=version+1,authorization_version=authorization_version+1,updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])',[userIds]);
    await tx.query("UPDATE sessions SET revoked_at=clock_timestamp(),revoked_reason=$2 WHERE user_id=ANY($1::uuid[]) AND revoked_at IS NULL",[userIds,desired?'module_enabled':'module_disabled']);
    await tx.query("UPDATE invites SET status='revoked',version=version+1,terminal_reason=$2,updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])",[inviteIds,desired?'MODULE_ENABLED':'MODULE_DISABLED']);
    const credentials=(await tx.query<{id:string}>('UPDATE one_time_credentials SET revoked_at=clock_timestamp() WHERE invite_id=ANY($1::uuid[]) AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id',[inviteIds])).rows.map(row=>row.id);
    await cancelCredentialTasks(tx,credentials,'CREDENTIAL_REPLACED');
    await tx.query('UPDATE system_state SET example_notes_enabled=$1 WHERE id=1',[desired]);
    await checkPermissionCatalog(tx,desired);
    await appendAudit(tx,{actor:{type:'operator'},action:desired?'ops.module.enabled':'ops.module.disabled',target:{type:'example_notes_module'},result:'success',reason:parsed.data.reason,meta,
      changes:{affected_count:userIds.length,...(desired?{permissions_added:definitions.map(p=>p.code)}:{permissions_removed:definitions.map(p=>p.code)})}});
    await appendSecurityEvent(tx,{userId:null,type:'access.role.permissions_changed',result:'success',reasonCode:null,targetDigest:null,meta});
    return {changed:true,enabled:desired,roles_affected:roleIds.length,users_affected:userIds.length,invites_revoked:invites.length,permissions_changed:definitions.length};
  });
}
