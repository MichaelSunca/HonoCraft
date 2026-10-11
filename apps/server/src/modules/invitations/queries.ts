import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {InvitationDtoSchema,InvitationListSchema,InvitationQuerySchema} from '@honocraft/contracts/invitations';
import {databaseNow,withTransaction,type Tx} from '../../infrastructure/db.js';
import {authenticateRead,type SessionContext} from '../auth/sessions.js';
import {readRoleSnapshots} from '../auth/credentials.js';
import {assertGrantableRoles,isSuperAdmin} from '../access/policy.js';
import {invitationHighRisk} from './management.js';

type Row={id:string;email:string;status:'pending'|'accepted'|'expired'|'revoked';version:number;created_at:Date;expires_at:Date;inviter:{id:string;display_name:string};
  roles:Array<{id:string;code:string;name:string;version:number}>;mail:{status:string;attempts:number;error_code:string|null;updated_at:string}|null};
const effectiveStatus="CASE WHEN i.status='pending' AND i.expires_at<=$1 THEN 'expired' ELSE i.status END";
const projection=`i.id,i.email,${effectiveStatus} AS status,i.version,i.created_at,i.expires_at,
  jsonb_build_object('id',u.id,'display_name',u.display_name) AS inviter,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.role_id_at_issue,'code',r.role_code,'name',r.role_name,'version',r.role_version_at_issue) ORDER BY r.role_code,r.role_id_at_issue)
    FROM invite_roles r WHERE r.invite_id=i.id),'[]'::jsonb) AS roles,
  (SELECT jsonb_build_object('status',t.status,'attempts',t.attempts,'error_code',t.error_code,'updated_at',t.updated_at)
    FROM one_time_credentials c JOIN email_tasks t ON t.credential_id=c.id WHERE c.invite_id=i.id
    ORDER BY c.subject_version DESC,t.created_at DESC,t.id DESC LIMIT 1) AS mail`;
async function project(tx:Tx,context:SessionContext,rows:Row[]){
  const currentRoles=await readRoleSnapshots(tx,[...new Set(rows.flatMap(row=>row.roles.map(role=>role.id)))]);
  return rows.map(row=>{
    const roles=row.roles.flatMap(snapshot=>{const role=currentRoles.find(role=>role.id===snapshot.id);return role?[role]:[];});
    let grantable=context.permissions.has('invite:manage')&&roles.length===row.roles.length&&roles.length>0;
    try{assertGrantableRoles(context.actor,roles);}catch(error){if(!(error instanceof AppError))throw error;grantable=false;}
    const high=invitationHighRisk(roles);if(high&&(!isSuperAdmin(context.actor)||!context.permissions.has('user:manage-privileged')))grantable=false;
    const actions=grantable?(row.status==='pending'?['resend','revoke']:row.status==='accepted'?[]:['reinvite']):[];
    return InvitationDtoSchema.parse({...row,created_at:row.created_at.toISOString(),expires_at:row.expires_at.toISOString(),
      mail:row.mail?{...row.mail,updated_at:new Date(row.mail.updated_at).toISOString()}:null,allowed_actions:actions,requires_reauth_actions:high?actions:[]});
  });
}
export function createInvitationQueries(pool:Pool,epoch:string){
  async function authenticate(ref:{token:string}){const context=await authenticateRead(pool,{token:ref.token,epoch});if(!context.permissions.has('invite:read'))throw new AppError('FORBIDDEN');return context;}
  async function list(ref:{token:string},raw:unknown){
    const parsed=InvitationQuerySchema.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const input=parsed.data,context=await authenticate(ref);
    return withTransaction(pool,'read',async tx=>{
      const now=await databaseNow(tx),pattern=input.query?`%${input.query.replace(/[\\%_]/g,'\\$&')}%`:null;
      const parameters=[now,pattern,input.status??null,input.inviter_id??null,input.created_from??null,input.created_to??null];
      const where=`($2::text IS NULL OR i.email ILIKE $2) AND ($3::text IS NULL OR ${effectiveStatus}=$3)
        AND ($4::uuid IS NULL OR i.inviter_id=$4) AND ($5::timestamptz IS NULL OR i.created_at>=$5) AND ($6::timestamptz IS NULL OR i.created_at<$6)`;
      const total=(await tx.query<{total:number}>(`SELECT count(*)::int AS total FROM invites i WHERE ${where}`,parameters)).rows[0]!.total;
      // Both interpolated identifiers are constrained by the strict enum schema above.
      const rows=(await tx.query<Row>(`SELECT ${projection} FROM invites i JOIN users u ON u.id=i.inviter_id WHERE ${where}
        ORDER BY i.${input.sort} ${input.direction},i.id ${input.direction} LIMIT $7 OFFSET $8`,[...parameters,input.page_size,(input.page-1)*input.page_size])).rows;
      return InvitationListSchema.parse({items:await project(tx,context,rows),page:input.page,page_size:input.page_size,total});
    });
  }
  async function get(ref:{token:string},id:unknown){
    const parsed=z.uuid().safeParse(id);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const context=await authenticate(ref);
    return withTransaction(pool,'read',async tx=>{
      const rows=(await tx.query<Row>(`SELECT ${projection} FROM invites i JOIN users u ON u.id=i.inviter_id WHERE i.id=$2`,[await databaseNow(tx),parsed.data])).rows;
      if(!rows.length)throw new AppError('NOT_FOUND');return (await project(tx,context,rows))[0]!;
    });
  }
  return {list,get};
}
