import type { APIRoute } from 'astro';
import { appLocationFor } from '../../lib/app-url';

export const prerender = false;

export const ALL: APIRoute = ({ url }) => Response.redirect(appLocationFor(url), 301);
