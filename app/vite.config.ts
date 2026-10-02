import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// `pnpm run preview:stub` binds ADMIN_API to the in-memory stub in test/preview instead of the api worker.
const isPreview = process.env.BACKCHANNELS_PREVIEW === '1';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit({ adapter: adapter(isPreview ? { config: 'test/preview/wrangler.preview.jsonc' } : {}) })],
	server: { port: 4322, strictPort: true },
});
