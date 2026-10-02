import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const domTests = 'src/**/*.dom.test.ts';

export default defineConfig({
	resolve: { alias: { '#lib': fileURLToPath(new URL('./src/lib', import.meta.url)) } },
	test: {
		projects: [
			{ extends: true, test: { name: 'node', include: ['src/**/*.test.ts'], exclude: [domTests] } },
			{ extends: true, test: { name: 'dom', include: [domTests], environment: 'happy-dom' } },
		],
	},
});
