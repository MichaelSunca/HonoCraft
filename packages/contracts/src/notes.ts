import {z} from 'zod';
import {PaginationSchema,VersionSchema,text} from './common.js';
export {NoteInputSchema,NoteUpdateSchema} from './common.js';
export const NoteQuerySchema=PaginationSchema.extend({
  query:z.string().trim().pipe(text(0,100)).refine(value=>!value||[...value].length>=2).optional(),
  sort:z.enum(['created_at','updated_at','title']).default('created_at'),direction:z.enum(['asc','desc']).default('desc'),
});
export const NoteDtoSchema=z.strictObject({id:z.uuid(),title:text(1,120),body:text(0,20000),version:VersionSchema,
  created_at:z.iso.datetime(),updated_at:z.iso.datetime(),allowed_actions:z.array(z.enum(['update','delete']))});
export const NoteListSchema=z.strictObject({items:z.array(NoteDtoSchema),page:z.number().int().positive(),page_size:z.number().int().positive(),total:z.number().int().nonnegative()});
export const NoteDeleteInputSchema=z.strictObject({expected_version:VersionSchema});
export const NoteDeleteResultSchema=z.strictObject({id:z.uuid(),deleted:z.literal(true),version:VersionSchema});
export type NoteDto=z.infer<typeof NoteDtoSchema>;
export type NoteQuery=z.infer<typeof NoteQuerySchema>;
