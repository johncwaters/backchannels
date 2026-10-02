import { env } from 'cloudflare:workers';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ siteUrl: env.SITE_URL });
