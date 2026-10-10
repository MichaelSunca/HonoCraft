import { z } from 'zod';
import { AppError } from '@honocraft/contracts/errors';
import { ProfileUpdateSchema, DisplayNameSchema, LocaleSchema, ThemeSchema } from '@honocraft/contracts/common';
import { defineMutation } from '../access/mutation-gateway.js';

export const SelfProfileSchema=z.strictObject({
  id:z.uuid(),display_name:DisplayNameSchema,locale:LocaleSchema.nullable(),theme:ThemeSchema.nullable(),version:z.number().int().positive(),
});
export const profileMutation=defineMutation({
  input:ProfileUpdateSchema,output:SelfProfileSchema,mode:'shared',permission:null,recentAuth:false,auditAction:'users.profile.updated',
  resolveLocks:async()=>({userIds:[],roleIds:[]}),
  authorize:async()=>{ /* identity was verified by the gateway; target is always the current user */ },
  execute:async(tx,context,input)=>{
    const row=(await tx.query<z.infer<typeof SelfProfileSchema>>(`UPDATE users SET display_name=COALESCE($3,display_name),
      locale=COALESCE($4,locale),theme=COALESCE($5,theme),version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND version=$2 RETURNING id,display_name,locale,theme,version`,[
      context.actor.userId,input.expected_version,input.display_name??null,input.locale??null,input.theme??null,
    ])).rows[0];
    if(!row)throw new AppError('VERSION_CONFLICT');
    const changedFields:Array<'display_name'|'locale'|'theme'>=[];
    if(input.display_name!==undefined)changedFields.push('display_name');
    if(input.locale!==undefined)changedFields.push('locale');
    if(input.theme!==undefined)changedFields.push('theme');
    return {data:row,audit:{target:{type:'user',id:row.id},changes:{before_version:input.expected_version,after_version:row.version,changed_fields:changedFields}}};
  },
});
