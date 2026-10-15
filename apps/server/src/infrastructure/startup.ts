import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {withTransaction} from './db.js';
import {checkPermissionCatalog} from './catalog.js';
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
      await checkPermissionCatalog(tx,exampleNotesEnabled);
    });
  }catch(error){
    if(error instanceof Error&&error.message==='PERMISSION_CATALOG_INCOMPATIBLE')throw error;
    throw new Error('DATABASE_SCHEMA_INCOMPATIBLE');
  }
}
