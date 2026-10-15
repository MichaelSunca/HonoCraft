import type {Tx} from '../../infrastructure/db.js';
import type {NoteQuery} from '@honocraft/contracts/notes';
export type NoteRow={id:string;title:string;body:string;version:number;created_at:Date;updated_at:Date};
export async function ownedNote(tx:Tx,id:string,owner:string,lock=false){
  return (await tx.query<NoteRow>('SELECT id,title,body,version,created_at,updated_at FROM example_notes WHERE id=$1 AND owner_id=$2'+(lock?' FOR UPDATE':''),[id,owner])).rows[0];
}
export async function ownedNotes(tx:Tx,owner:string,query:NoteQuery){
  const parameters=[owner,query.query||null],predicate='owner_id=$1 AND ($2::text IS NULL OR strpos(lower(title),lower($2))>0)';
  const total=(await tx.query<{total:number}>('SELECT count(*)::int total FROM example_notes WHERE '+predicate,parameters)).rows[0]!.total;
  // Values come only from the closed query enum. ID provides stable ordering for ties.
  const field={created_at:'created_at',updated_at:'updated_at',title:'title'}[query.sort],direction=query.direction==='asc'?'ASC':'DESC';
  const rows=(await tx.query<NoteRow>(`SELECT id,title,body,version,created_at,updated_at FROM example_notes WHERE ${predicate} ORDER BY ${field} ${direction},id ${direction} LIMIT $3 OFFSET $4`,[...parameters,query.page_size,(query.page-1)*query.page_size])).rows;
  return {rows,total};
}
