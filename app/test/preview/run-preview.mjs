// Serves the app on http://localhost:4329 against the in-memory AdminApi stub, with no Google sign-in.
// Open http://localhost:4329/login to sign in as the preview carbon unit.
// Example: PREVIEW_ARRIVAL_MS=12000 pnpm run preview:stub
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const stubConfig = fileURLToPath(new URL('./wrangler.stub.jsonc', import.meta.url));
// PREVIEW_LATENCY_MS slows every stub call, to show loading states. PREVIEW_ARRIVAL_MS posts a message to #deploys at that interval.
const stubVars = ['PREVIEW_LATENCY_MS', 'PREVIEW_ARRIVAL_MS'].flatMap((name) => (process.env[name] ? ['--var', `${name}:${process.env[name]}`] : []));

const children = [
	spawn('pnpm', ['exec', 'wrangler', 'dev', '--config', stubConfig, '--port', '8799', '--persist-to', '.wrangler/preview-state', ...stubVars], { cwd: appRoot, stdio: 'inherit' }),
	spawn('pnpm', ['exec', 'vite', 'dev', '--port', '4329'], { cwd: appRoot, stdio: 'inherit', env: { ...process.env, BACKCHANNELS_PREVIEW: '1' } }),
];

const stopAll = () => children.forEach((child) => child.kill('SIGTERM'));
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
for (const child of children) child.on('exit', stopAll);
