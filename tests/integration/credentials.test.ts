import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {issueToken} from '../../apps/server/src/infrastructure/crypto.js';
import {currentCredential} from '../../apps/server/src/modules/auth/credentials.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;
beforeAll(async()=>{database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{await database?.close();});
async function credential(purpose:string,subject:{user?:string;invite?:string;change?:string;email:string;version?:number;metadata?:unknown}){
  const issued=issueToken();const id=randomUUID();
  await database.pool.query(`INSERT INTO one_time_credentials(id,purpose,token_hash,user_id,invite_id,email_change_request_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at,purpose_metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text,lower($8::text),'test-epoch',clock_timestamp()+interval '30 minutes',$9)`,[
    id,purpose,issued.hash,subject.user??null,subject.invite??null,subject.change??null,subject.version??1,subject.email,subject.metadata??{},
  ]);return {id,token:issued.token,purpose,epoch:'test-epoch'};
}
const check=(ref:Awaited<ReturnType<typeof credential>>)=>withTransaction(database.pool,'read',tx=>currentCredential(tx,ref));
describe('purpose-specific credential authority',()=>{
  it('requires a pending registration and its original eligible default role for verification',async()=>{
    const user=await identity(database.pool);
    await database.pool.query("UPDATE users SET status='pending',email_verified_at=NULL,creation_source='registration',registration_role_id='00000000-0000-4000-8000-000000000003' WHERE id=$1",[user.userId]);
    const ref=await credential('email_verify',{user:user.userId,email:`${user.userId}@example.test`});expect(await check(ref)).toMatchObject({id:ref.id});
    await database.pool.query("UPDATE users SET registration_role_id='00000000-0000-4000-8000-000000000002' WHERE id=$1",[user.userId]);
    expect(await check(ref)).toBeNull();
  });
  it('binds bootstrap to the sole pending bootstrap user and current system version',async()=>{
    const user=await identity(database.pool);await database.pool.query('DELETE FROM sessions WHERE user_id=$1',[user.userId]);await database.pool.query('DELETE FROM user_roles WHERE user_id=$1',[user.userId]);
    await database.pool.query("UPDATE users SET status='pending',email_verified_at=NULL,password_hash=NULL,creation_source='bootstrap' WHERE id=$1",[user.userId]);
    await database.pool.query("UPDATE system_state SET initialization_status='pending',initialized_at=NULL,bootstrap_user_id=$1 WHERE id=1",[user.userId]);
    try{
      const ref=await credential('bootstrap',{user:user.userId,email:`${user.userId}@example.test`});expect(await check(ref)).toMatchObject({id:ref.id});
      await database.pool.query('UPDATE system_state SET bootstrap_version=bootstrap_version+1 WHERE id=1');expect(await check(ref)).toBeNull();
    }finally{await initializedDatabase(database.pool);}
  });
  it('binds password reset to the authorization version but not ordinary profile edits',async()=>{
    const user=await identity(database.pool);const ref=await credential('password_reset',{user:user.userId,email:`${user.userId}@example.test`});
    await database.pool.query('UPDATE users SET version=version+1 WHERE id=$1',[user.userId]);expect(await check(ref)).toMatchObject({id:ref.id});
    await database.pool.query('UPDATE users SET authorization_version=authorization_version+1 WHERE id=$1',[user.userId]);expect(await check(ref)).toBeNull();
  });
  it('requires current inviter qualification and unchanged role snapshots at invitation acceptance',async()=>{
    const inviter=await identity(database.pool,'admin');const invite=randomUUID();const email=`${invite}@example.test`;
    await database.pool.query("INSERT INTO invites(id,email,normalized_email,inviter_id,expires_at) VALUES ($1,$2,$2,$3,clock_timestamp()+interval '1 day')",[invite,email,inviter.userId]);
    await database.pool.query("INSERT INTO invite_roles(invite_id,role_id,role_id_at_issue,role_code,role_name,role_version_at_issue) SELECT $1,id,id,code,name,version FROM roles WHERE code='user'",[invite]);
    const ref=await credential('invite_accept',{invite,email});expect(await check(ref)).toMatchObject({id:ref.id});
    await database.pool.query("UPDATE users SET status='suspended' WHERE id=$1",[inviter.userId]);expect(await check(ref)).toBeNull();
    await database.pool.query("UPDATE users SET status='active' WHERE id=$1",[inviter.userId]);
    await database.pool.query('UPDATE invite_roles SET role_version_at_issue=role_version_at_issue+1 WHERE invite_id=$1',[invite]);expect(await check(ref)).toBeNull();
  });
  it('requires the initiating administrator to remain authorized for an email change',async()=>{
    const user=await identity(database.pool);const admin=await identity(database.pool,'admin');const change=randomUUID();const email=`new-${user.userId}@example.test`;
    await database.pool.query(`INSERT INTO email_change_requests(id,user_id,requested_by,initiated_by_self,new_email,normalized_new_email,expires_at)
      VALUES ($1,$2,$3,false,$4,$4,clock_timestamp()+interval '1 day')`,[change,user.userId,admin.userId,email]);
    const ref=await credential('email_change',{user:user.userId,change,email});expect(await check(ref)).toMatchObject({id:ref.id});
    await database.pool.query('DELETE FROM user_roles WHERE user_id=$1',[admin.userId]);expect(await check(ref)).toBeNull();
  });
  it('does not send the old-address verification while a valid email change is pending',async()=>{
    const user=await identity(database.pool);await database.pool.query("UPDATE users SET status='pending',email_verified_at=NULL,creation_source='registration',registration_role_id='00000000-0000-4000-8000-000000000003' WHERE id=$1",[user.userId]);
    const ref=await credential('email_verify',{user:user.userId,email:`${user.userId}@example.test`});
    await database.pool.query(`INSERT INTO email_change_requests(user_id,requested_by,initiated_by_self,new_email,normalized_new_email,expires_at)
      VALUES ($1,$1,true,'pending@example.test','pending@example.test',clock_timestamp()+interval '1 hour')`,[user.userId]);
    expect(await check(ref)).toBeNull();
  });
  it('requires current super-admin status for ordinary operator recovery',async()=>{
    const user=await identity(database.pool,'super_admin');
    const ref=await credential('operator_recovery',{user:user.userId,email:`${user.userId}@example.test`,metadata:{restore_access:false,operator_id:'operator-1',reason:'Verified locally',evidence_ref:'case-1'}});
    expect(await check(ref)).toMatchObject({id:ref.id});await database.pool.query('DELETE FROM user_roles WHERE user_id=$1',[user.userId]);expect(await check(ref)).toBeNull();
  });
  it('rejects restore-access recovery if another usable administrator appears',async()=>{
    const user=await identity(database.pool);await database.pool.query("UPDATE users SET status='suspended' WHERE id=$1",[user.userId]);
    const ref=await credential('operator_recovery',{user:user.userId,email:`${user.userId}@example.test`,metadata:{restore_access:true,operator_id:'operator-1',reason:'Verified locally',evidence_ref:'case-2'}});
    expect(await check(ref)).toMatchObject({id:ref.id});await identity(database.pool,'super_admin');expect(await check(ref)).toBeNull();
  });
  it('never accepts a token for another purpose or deployment epoch',async()=>{
    const user=await identity(database.pool);const ref=await credential('password_reset',{user:user.userId,email:`${user.userId}@example.test`});
    expect(await check({...ref,purpose:'email_verify'})).toBeNull();expect(await check({...ref,epoch:'new-epoch'})).toBeNull();
  });
});
