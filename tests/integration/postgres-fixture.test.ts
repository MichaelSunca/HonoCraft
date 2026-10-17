import {setTimeout as delay} from 'node:timers/promises';
import {expect,it,vi} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {createDatabase} from '../../apps/server/src/infrastructure/db.js';
it('lets closing pool connections disconnect before stopping the isolated PostgreSQL server',async()=>{
  const database=await startTestPostgres(),client=await database.pool.connect(),errors:string[]=[],pending:Promise<void>[]=[];
  database.pool.on('error',(error:Error&{code?:string})=>errors.push(error.code??'UNKNOWN'));
  const end=client.end.bind(client),spy=vi.spyOn(client,'end').mockImplementation(callback=>{
    // Simulate a slow socket close without faking the server, pool or protocol.
    const done=delay(250).then(()=>callback?end(callback):end());pending.push(done);return done;
  });
  client.release();
  try{await database.close();await Promise.all(pending);expect(errors).toEqual([]);}
  finally{spy.mockRestore();}
});
it('keeps the runtime database close pending until every client has actually disconnected',async()=>{
  const fixture=await startTestPostgres(),runtime=createDatabase(fixture.connectionString),client=await runtime.pool.connect();
  let disconnected=false;const finished=new Promise<void>(resolve=>client.once('end',()=>{disconnected=true;resolve();}));
  const end=client.end.bind(client),spy=vi.spyOn(client,'end').mockImplementation(callback=>delay(250).then(()=>callback?end(callback):end()));
  client.release();
  try{await runtime.close();expect(disconnected).toBe(true);}
  finally{await finished;spy.mockRestore();await fixture.close();}
});
