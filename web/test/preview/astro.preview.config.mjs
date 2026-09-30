// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

const webRoot = fileURLToPath(new URL('../../', import.meta.url));
const previewFile = (/** @type {string} */ name) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  root: webRoot,
  cacheDir: 'node_modules/.astro-preview',
  integrations: [svelte()],
  adapter: cloudflare({
    configPath: previewFile('./wrangler.preview.jsonc'),
    auxiliaryWorkers: [{ configPath: previewFile('./wrangler.stub.jsonc') }],
    persistState: false,
  }),
  server: { port: 4329 },
  vite: { cacheDir: 'node_modules/.vite-preview', plugins: [tailwindcss()] },
});
