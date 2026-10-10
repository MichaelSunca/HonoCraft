import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {enabledPermissions} from '@honocraft/contracts/permissions';
import {withTransaction} from './db.js';
import {DEFAULT_MIGRATION_DIRECTORY} from './migrations.js';

/** Startup is read-only; deploying the matching schema and catalog is an explicit operator action. */
export async function checkDatabaseCompatibility(pool:Pool,exampleNotesEnabled:boolean,directory=DEFAULT_MIGRATION_DIRECTORY):Promise<void> {
  try {
    const names=(await readdir(directory)).filter(name=>/^\d{4}_[a-z0-9_-]+\.sql$/.test(name)).sort();
    if(!names.length)throw new Error('DATABASE_SCHEMA_INCOMPATIBLE');
    const expected=await Promise.all(names.map(async name=>({name,checksum:createHash('sha256').update(await readFile(join(directory,name))).digest('hex')})));
    const version=Number((await pool.query<{server_version_num:string}>('SHOW server_version_num')).rows[0]?.server_version_num);
    if(!Number.isInteger(version)||version<170000||version>=180000)throw new Error('DATABASE_SCHEMA_INCOMPATIBLE');
    await withTransaction(pool,'read',async tx=>{
      const history=(await tx.query<{name:string;checksum:string}>('SELECT name,checksum FROM migration_history ORDER BY name')).rows;
      if(history.length!==expected.length||history.some((row,index)=>row.name!==expected[index]?.name||row.checksum!==expected[index]?.checksum))throw new Error('DATABASE_SCHEMA_INCOMPATIBLE');
      const state=(await tx.query<{catalog_version:number;example_notes_enabled:boolean}>('SELECT catalog_version,example_notes_enabled FROM system_state WHERE id=1')).rows[0];
      if(!state||state.catalog_version!==1||state.example_notes_enabled!==exampleNotesEnabled)throw new Error('PERMISSION_CATALOG_INCOMPATIBLE');
      const permissions=(await tx.query<{code:string;module:string;name_key:string;description_key:string;is_reserved:boolean;is_delegable:boolean;is_self_assignable:boolean;catalog_version:number}>(
        'SELECT code,module,name_key,description_key,is_reserved,is_delegable,is_self_assignable,catalog_version FROM permissions')).rows;
      const definitions=enabledPermissions(exampleNotesEnabled);
      if(permissions.length!==definitions.length)throw new Error('PERMISSION_CATALOG_INCOMPATIBLE');
      for(const definition of definitions){
        const row=permissions.find(item=>item.code===definition.code);
        if(!row||row.module!==definition.code.split(':')[0]||row.name_key!==`permissions.${definition.code}`||row.description_key!==`permissions.${definition.code}.description`||
          row.is_reserved!==definition.reserved||row.is_delegable!==definition.delegable||row.is_self_assignable!==definition.selfAssignable||row.catalog_version!==1)throw new Error('PERMISSION_CATALOG_INCOMPATIBLE');
      }
      const dependencies=(await tx.query<{code:string;required:string}>(`SELECT p.code,r.code AS required FROM permission_dependencies d
        JOIN permissions p ON p.id=d.permission_id JOIN permissions r ON r.id=d.required_permission_id`)).rows.map(row=>`${row.code}|${row.required}`).sort();
      const required=definitions.flatMap(item=>item.dependencies.map(code=>`${item.code}|${code}`)).sort();
      if(JSON.stringify(dependencies)!==JSON.stringify(required))throw new Error('PERMISSION_CATALOG_INCOMPATIBLE');
    });
  }catch(error){
    if(error instanceof Error&&error.message==='PERMISSION_CATALOG_INCOMPATIBLE')throw error;
    throw new Error('DATABASE_SCHEMA_INCOMPATIBLE');
  }
}
