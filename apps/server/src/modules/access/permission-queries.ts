import type {Pool} from 'pg';
import {AppError} from '@honocraft/contracts/errors';
import {PermissionQuerySchema,PermissionCatalogSchema,type PermissionDto,type PermissionCatalog} from '@honocraft/contracts/permission-catalog';
import {withTransaction} from '../../infrastructure/db.js';
import {authenticateRead} from '../auth/sessions.js';

export function createPermissionQueries(pool:Pool,epoch:string){
  return {async list(ref:{token:string},raw:unknown):Promise<PermissionCatalog>{
    const context=await authenticateRead(pool,{token:ref.token,epoch});
    if(!context.permissions.has('permission:read'))throw new AppError('FORBIDDEN');
    const parsed=PermissionQuerySchema.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');
    return withTransaction(pool,'read',async tx=>{
      const state=(await tx.query<{catalog_version:number}>('SELECT catalog_version FROM system_state WHERE id=1')).rows[0];
      if(!state)throw new AppError('DEPENDENCY_UNAVAILABLE');
      const permissions=(await tx.query<PermissionDto>(`SELECT p.code,p.module,p.name_key,p.description_key,p.is_reserved,p.is_delegable,p.is_self_assignable,p.catalog_version,
        ARRAY(SELECT required.code FROM permission_dependencies d JOIN permissions required ON required.id=d.required_permission_id
          WHERE d.permission_id=p.id ORDER BY required.code) AS dependencies
        FROM permissions p CROSS JOIN system_state s WHERE s.id=1 AND (p.module<>'example-note' OR s.example_notes_enabled)
        AND ($1::text IS NULL OR p.module=$1) ORDER BY p.module,p.code`,[parsed.data.module??null])).rows;
      const groups=new Map<PermissionDto['module'],PermissionDto[]>();
      for(const permission of permissions){const group=groups.get(permission.module)??[];group.push(permission);groups.set(permission.module,group);}
      return PermissionCatalogSchema.parse({catalog_version:state.catalog_version,modules:[...groups].map(([module,items])=>({module,permissions:items}))});
    });
  }};
}
