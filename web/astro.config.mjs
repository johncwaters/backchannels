// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  integrations: [svelte()],
  // The site keeps no per-visitor state, so the adapter needs no session KV namespace.
  session: false,
  adapter: cloudflare(),
});
