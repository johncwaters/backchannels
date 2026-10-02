import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Unknown paths show the not found page inside the signed-in frame.
export const load: PageServerLoad = () => error(404, 'Page not found');
