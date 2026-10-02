// Creates every Cloudflare resource the three workers bind to, if it is missing.
// Safe to run again: existing resources are left alone. New KV and D1 IDs are
// written back into the worker's wrangler.jsonc. Run `pnpm run deploy` to
// provision and then deploy all three workers.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonConfig, updateBindingId } from './jsonc.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBin = join(repoRoot, 'api', 'node_modules', '.bin', 'wrangler');

// KV titles are not in wrangler.jsonc, so they live here, keyed by binding.
const kvTitles = { OAUTH_KV: 'backchannels-oauth', SESSION: 'backchannels-sessions' };
const vectorizeShape = { dimensions: 1024, metric: 'cosine' };
const vectorizeMetadataIndexes = [
  { propertyName: 'vis', type: 'string' },
  { propertyName: 'kind', type: 'string' },
  { propertyName: 'author', type: 'string' },
  { propertyName: 'ch', type: 'number' },
  { propertyName: 'day', type: 'number' },
];
const metadataIndexPollMs = 5000;
const metadataIndexPollAttempts = 60;
const onlyKinds = process.argv.filter((arg) => arg.startsWith('--only=')).flatMap((arg) => arg.slice('--only='.length).split(','));
const shouldProvision = (kind) => onlyKinds.length === 0 || onlyKinds.includes(kind);

const workers = [
  { dir: 'api', secrets: ['GOOGLE_CLIENT_SECRET'] },
  { dir: 'app', secrets: [] },
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
  return { path, config: parseJsonConfig(readFileSync(path, 'utf8')) };
}

function writeId(path, binding, key, id) {
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, updateBindingId(text, binding, key, id));
}

function ensureD1(path, database) {
  const existing = jsonFrom(wrangler(['d1', 'list', '--json'])).find((row) => row.name === database.database_name);
  let id = existing?.uuid;
  if (!id) {
    console.log(`create  d1 ${database.database_name}`);
    wrangler(['d1', 'create', database.database_name]);
    id = jsonFrom(wrangler(['d1', 'list', '--json'])).find((row) => row.name === database.database_name).uuid;
  }
  if (existing) console.log(`ok      d1 ${database.database_name}`);
  if (database.database_id !== id) writeId(path, database.binding, 'database_id', id);

  const migrations = join(dirname(path), database.migrations_dir ?? 'migrations');
  if (existsSync(migrations)) {
    wrangler(['d1', 'migrations', 'apply', database.database_name, '--remote', '--config', path]);
  }
}

function ensureKv(path, namespace, existingNamespaces) {
  const title = kvTitles[namespace.binding];
  if (!title) throw new Error(`No KV title for binding ${namespace.binding}; add it to kvTitles.`);
  const existing = existingNamespaces.find((row) => row.id === namespace.id) ?? existingNamespaces.find((row) => row.title === title);
  let found = existing;
  if (!found) {
    console.log(`create  kv ${title}`);
    wrangler(['kv', 'namespace', 'create', title]);
    found = jsonFrom(wrangler(['kv', 'namespace', 'list'])).find((row) => row.title === title);
  }
  if (existing) console.log(`ok      kv ${found.title}`);
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

function metadataIndexNames(indexName) {
  return jsonFrom(wrangler(['vectorize', 'list-metadata-index', indexName, '--json'], { quiet: true })).map((row) => row.propertyName);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureMetadataIndexes(indexName) {
  for (const { propertyName, type } of vectorizeMetadataIndexes) {
    if (metadataIndexNames(indexName).includes(propertyName)) {
      console.log(`ok      vectorize ${indexName} metadata ${propertyName}`);
      continue;
    }
    console.log(`create  vectorize ${indexName} metadata ${propertyName} (${type})`);
    wrangler(['vectorize', 'create-metadata-index', indexName, `--propertyName=${propertyName}`, `--type=${type}`]);
    for (let attempt = 0; !metadataIndexNames(indexName).includes(propertyName); attempt++) {
      if (attempt >= metadataIndexPollAttempts) throw new Error(`metadata index ${propertyName} on ${indexName} did not appear`);
      sleep(metadataIndexPollMs);
    }
  }
}

function vectorizeIndexes(config) {
  const environments = Object.values(config.env ?? {});
  return [...new Set([config, ...environments].flatMap((section) => section.vectorize ?? []).map((index) => index.index_name))];
}

const kvNamespaces = shouldProvision('kv') ? jsonFrom(wrangler(['kv', 'namespace', 'list'])) : [];

for (const worker of workers) {
  const { path, config } = readConfig(worker.dir);
  console.log(`\n${config.name}`);

  if (shouldProvision('d1')) for (const database of config.d1_databases ?? []) ensureD1(path, database);
  if (shouldProvision('kv')) for (const namespace of config.kv_namespaces ?? []) ensureKv(path, namespace, kvNamespaces);
  if (shouldProvision('r2')) {
    for (const bucket of config.r2_buckets ?? []) {
      ensureByName('r2', bucket.bucket_name, ['r2', 'bucket', 'info', bucket.bucket_name], ['r2', 'bucket', 'create', bucket.bucket_name]);
    }
  }
  if (shouldProvision('queues')) {
    for (const queue of queueNames(config)) {
      ensureByName('queue', queue, ['queues', 'info', queue], ['queues', 'create', queue]);
    }
  }
  if (shouldProvision('vectorize')) {
    for (const indexName of vectorizeIndexes(config)) {
      ensureByName('vectorize', indexName, ['vectorize', 'get', indexName], [
        'vectorize',
        'create',
        indexName,
        `--dimensions=${vectorizeShape.dimensions}`,
        `--metric=${vectorizeShape.metric}`,
      ]);
      ensureMetadataIndexes(indexName);
    }
  }

  if (onlyKinds.length === 0) warnOnMissingSecrets(config, worker.secrets);
}
