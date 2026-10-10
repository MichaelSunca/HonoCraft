import { z } from 'zod';
import { defineMutation } from '../access/mutation-gateway.js';
// Request metadata is handled by the gateway audit; logout does not accept a client target session ID.
export const logoutMutation=defineMutation({
  input:z.strictObject({}),output:z.strictObject({logged_out:z.literal(true)}),mode:'exclusive',permission:null,recentAuth:false,auditAction:'auth.session.logged_out',
  resolveLocks:async()=>({userIds:[],roleIds:[]}),authorize:async()=>{},
  execute:async(tx,context)=>{
    await tx.query("UPDATE sessions SET revoked_at=$2,revoked_reason='logout' WHERE id=$1 AND revoked_at IS NULL",[context.sessionId,context.now]);
    return {data:{logged_out:true as const},audit:{target:{type:'session',id:context.sessionId}}};
  },
});
