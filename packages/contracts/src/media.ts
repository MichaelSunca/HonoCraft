import {z} from 'zod';
import {VersionSchema} from './common.js';
export const MediaVersionSchema=z.strictObject({expected_version:VersionSchema});
export const AvatarResultSchema=z.strictObject({avatar_url:z.string().startsWith('/api/v1/media/avatars/').nullable(),user_version:VersionSchema});
export const BrandingAssetResultSchema=z.strictObject({url:z.string().startsWith('/api/v1/media/branding/').nullable(),version:VersionSchema});
export const MediaReadQuerySchema=z.strictObject({size:z.enum(['32','64']).optional()});
