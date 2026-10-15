import {enabledPermissions} from '@honocraft/contracts/permissions';
import type {Tx} from './db.js';
/** Validation only. Operator transitions and startup use the same exact catalog contract. */
export async function checkPermissionCatalog(tx:Tx,exampleNotesEnabled:boolean):Promise<void>{
  const state=(await tx.query<{catalog_version:number;example_notes_enabled:boolean}>('SELECT catalog_version,example_notes_enabled FROM system_state WHERE id=1')).rows[0];
  if(!state||state.catalog_version!==1||state.example_notes_enabled!==exampleNotesEnabled)throw new Error('PERMISSION_CATALOG_INCOMPATIBLE');
  const permissions=(await tx.query<{code:string;module:string;name_key:string;description_key:string;is_reserved:boolean;is_delegable:boolean;is_self_assignable:boolean;catalog_version:number}>('SELECT code,module,name_key,description_key,is_reserved,is_delegable,is_self_assignable,catalog_version FROM permissions')).rows;
  const definitions=enabledPermissions(exampleNotesEnabled);
  if(permissions.length!==definitions.length)throw new Error('PERMISSION_CATALOG_INCOMPATIBLE');
  for(const definition of definitions){
    const row=permissions.find(item=>item.code===definition.code);
    if(!row||row.module!==definition.code.split(':')[0]||row.name_key!==`permissions.${definition.code}`||row.description_key!==`permissions.${definition.code}.description`||row.is_reserved!==definition.reserved||row.is_delegable!==definition.delegable||row.is_self_assignable!==definition.selfAssignable||row.catalog_version!==1)throw new Error('PERMISSION_CATALOG_INCOMPATIBLE');
  }
  const dependencies=(await tx.query<{code:string;required:string}>(`SELECT p.code,r.code AS required FROM permission_dependencies d
    JOIN permissions p ON p.id=d.permission_id JOIN permissions r ON r.id=d.required_permission_id`)).rows.map(row=>`${row.code}|${row.required}`).sort();
  const required=definitions.flatMap(item=>item.dependencies.map(code=>`${item.code}|${code}`)).sort();
  if(JSON.stringify(dependencies)!==JSON.stringify(required))throw new Error('PERMISSION_CATALOG_INCOMPATIBLE');
}
