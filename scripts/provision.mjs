// Creates every Cloudflare resource the two workers bind to, if it is missing.
// Safe to run again: existing resources are left alone. New KV and D1 IDs are
// written back into the worker's wrangler.jsonc. Run `pnpm run deploy` to
// provision and then deploy both workers.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBin = join(repoRoot, 'api', 'node_modules', '.bin', 'wrangler');

// KV titles are not in wrangler.jsonc, so they live here, keyed by binding.
const kvTitles = { OAUTH_KV: 'backchannels-oauth', SESSION: 'backchannels-sessions' };
const vectorizeShape = { dimensions: 1024, metric: 'cosine' };

const workers = [
  { dir: 'api', secrets: ['GOOGLE_CLIENT_SECRET'] },
  { dir: 'web', secrets: [] },
];

function wrangler(args, { quiet = false } = {}) {
  return execFileSync(wranglerBin, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  });
}

function succeeds(args) {
  try {
    wrangler(args, { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function jsonFrom(output) {
  return JSON.parse(output.slice(output.search(/[[{]/)));
}

function readConfig(dir) {
  const path = join(repoRoot, dir, 'wrangler.jsonc');
  return { path, config: JSON.parse(readFileSync(path, 'utf8')) };
}

// Rewrites one ID inside the binding's object literal, keeping the file's layout.
function writeId(path, binding, key, id) {
  const text = readFileSync(path, 'utf8');
  const updated = text.replace(/\{[^{}]*\}/g, (object) =>
    object.includes(`"binding": "${binding}"`) ? object.replace(new RegExp(`"${key}":\\s*"[^"]*"`), `"${key}": "${id}"`) : object,
  );
  writeFileSync(path, updated);
}

function ensureD1(path, database) {
  const existing = jsonFrom(wrangler(['d1', 'list', '--json'])).find((row) => row.name === database.database_name);
  let id = existing?.uuid;
  if (!id) {
    console.log(`create  d1 ${database.database_name}`);
    wrangler(['d1', 'create', database.database_name]);
    id = jsonFrom(wrangler(['d1', 'list', '--json'])).find((row) => row.name === database.database_name).uuid;
  } else {
    console.log(`ok      d1 ${database.database_name}`);
  }
  if (database.database_id !== id) writeId(path, database.binding, 'database_id', id);

  const migrations = join(dirname(path), database.migrations_dir ?? 'migrations');
  if (existsSync(migrations)) {
    wrangler(['d1', 'migrations', 'apply', database.database_name, '--remote', '--config', path]);
  }
}

function ensureKv(path, namespace, existingNamespaces) {
  const title = kvTitles[namespace.binding];
  if (!title) throw new Error(`No KV title for binding ${namespace.binding}; add it to kvTitles.`);
  let found = existingNamespaces.find((row) => row.id === namespace.id) ?? existingNamespaces.find((row) => row.title === title);
  if (!found) {
    console.log(`create  kv ${title}`);
    wrangler(['kv', 'namespace', 'create', title]);
    found = jsonFrom(wrangler(['kv', 'namespace', 'list'])).find((row) => row.title === title);
  } else {
    console.log(`ok      kv ${found.title}`);
  }
  if (namespace.id !== found.id) writeId(path, namespace.binding, 'id', found.id);
}

function ensureByName(kind, name, getArgs, createArgs) {
  if (succeeds(getArgs)) {
    console.log(`ok      ${kind} ${name}`);
    return;
  }
  console.log(`create  ${kind} ${name}`);
  wrangler(createArgs);
}

function queueNames(config) {
  const names = new Set();
  for (const producer of config.queues?.producers ?? []) names.add(producer.queue);
  for (const consumer of config.queues?.consumers ?? []) {
    names.add(consumer.queue);
    if (consumer.dead_letter_queue) names.add(consumer.dead_letter_queue);
  }
  return names;
}

function warnOnMissingSecrets(config, secrets) {
  let present = [];
  try {
    present = jsonFrom(wrangler(['secret', 'list', '--name', config.name, '--format', 'json'], { quiet: true })).map(
      (secret) => secret.name,
    );
  } catch {
    // The worker is not deployed yet, so it has no secrets.
  }
  for (const secret of secrets.filter((name) => !present.includes(name))) {
    console.warn(`missing secret ${secret} on ${config.name}: pnpm --filter ${config.name} exec wrangler secret put ${secret}`);
  }
}

const kvNamespaces = jsonFrom(wrangler(['kv', 'namespace', 'list']));

for (const worker of workers) {
  const { path, config } = readConfig(worker.dir);
  console.log(`\n${config.name}`);

  for (const database of config.d1_databases ?? []) ensureD1(path, database);
  for (const namespace of config.kv_namespaces ?? []) ensureKv(path, namespace, kvNamespaces);
  for (const bucket of config.r2_buckets ?? []) {
    ensureByName('r2', bucket.bucket_name, ['r2', 'bucket', 'info', bucket.bucket_name], ['r2', 'bucket', 'create', bucket.bucket_name]);
  }
  for (const queue of queueNames(config)) {
    ensureByName('queue', queue, ['queues', 'info', queue], ['queues', 'create', queue]);
  }
  for (const index of config.vectorize ?? []) {
    ensureByName('vectorize', index.index_name, ['vectorize', 'get', index.index_name], [
      'vectorize',
      'create',
      index.index_name,
      `--dimensions=${vectorizeShape.dimensions}`,
      `--metric=${vectorizeShape.metric}`,
    ]);
  }

  warnOnMissingSecrets(config, worker.secrets);
}
