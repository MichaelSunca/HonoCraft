import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {BrandingValueSchema} from '@honocraft/contracts/settings';
import type {Tx} from '../../infrastructure/db.js';
const brandingSchema=BrandingValueSchema;
const securitySchema=z.object({registration_open:z.boolean(),password_min_length:z.number().int().min(15).max(64)});
export async function loadPublicSettings(tx:Tx) {
  const row=(await tx.query<{branding:unknown;security:unknown;initialization_status:string}>(`SELECT b.typed_value AS branding,s.typed_value AS security,i.initialization_status
    FROM system_settings b CROSS JOIN system_settings s CROSS JOIN system_state i WHERE b.key='branding' AND s.key='security' AND i.id=1`)).rows[0];
  const branding=brandingSchema.safeParse(row?.branding);const security=securitySchema.safeParse(row?.security);
  if(!row||!branding.success||!security.success)throw new AppError('DEPENDENCY_UNAVAILABLE');
  const b=branding.data;const initialized=row.initialization_status==='initialized';
  return {instance_name:b.instance_name,copyright:b.copyright,default_locale:b.default_locale,default_theme:b.default_theme,timezone:b.timezone,
    logo_url:b.logo_file_id?`/api/v1/media/branding/${b.logo_file_id}`:null,favicon_url:b.favicon_file_id?`/api/v1/media/branding/${b.favicon_file_id}`:null,
    registration_open:initialized&&security.data.registration_open,password_min_length:security.data.password_min_length,initialized};
}
