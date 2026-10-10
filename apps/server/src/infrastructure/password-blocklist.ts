import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {ConfigurationError} from './config.js';
export const DEFAULT_PASSWORD_DIRECTORY=fileURLToPath(new URL('../../../../data/passwords/',import.meta.url));
const manifestSchema=z.strictObject({
  version:z.literal(1),source:z.string().min(1).max(200),upstream_commit:z.string().regex(/^[a-f0-9]{40}$/),
  source_url:z.url(),file:z.literal('common-100000.txt'),sha256:z.string().regex(/^[a-f0-9]{64}$/),
  entries:z.literal(100000),license:z.literal('MIT'),license_file:z.literal('LICENSE.SecLists'),retrieved_at:z.iso.date(),
});
/** All data is bundled with the release. Passwords never leave this process for breach checks. */
export async function loadPasswordBlocklist(directory=DEFAULT_PASSWORD_DIRECTORY):Promise<{entries:number;passwords:ReadonlySet<string>}> {
  try {
    const manifestFile=join(directory,'manifest.json');
    if((await stat(manifestFile)).size>8192)throw new Error();
    const manifest=manifestSchema.parse(JSON.parse(await readFile(manifestFile,'utf8')));
    const path=join(directory,manifest.file);
    const size=(await stat(path)).size;
    if(size<1||size>8*1024*1024)throw new Error();
    const bytes=await readFile(path);
    if(createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error();
    const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).split(/\r?\n/);
    if(lines.at(-1)==='')lines.pop();
    if(lines.length!==manifest.entries||!(await stat(join(directory,manifest.license_file))).isFile())throw new Error();
    return {entries:lines.length,passwords:new Set(lines.map(value=>value.toLowerCase()))};
  }catch{throw new ConfigurationError(['PASSWORD_BLOCKLIST']);}
}
