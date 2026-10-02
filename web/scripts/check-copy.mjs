import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const productCopyDirectories = ['web', 'app', 'cli'].map((directoryName) => join(repoRoot, directoryName));
const skippedDirectoryNames = new Set(['.git', 'node_modules', 'dist', '.astro', '.svelte-kit', '.wrangler']);
const competitorNamePattern = /s[l]ack/i;

function isBinary(fileBuffer) {
  return fileBuffer.includes(0);
}

function* walkFiles(directoryPath) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirectoryNames.has(entry.name)) continue;
      yield* walkFiles(entryPath);
      continue;
    }
    if (entry.isFile()) yield entryPath;
  }
}

const violations = [];
for (const filePath of productCopyDirectories.flatMap((directoryPath) => [...walkFiles(directoryPath)])) {
  const fileBuffer = readFileSync(filePath);
  if (isBinary(fileBuffer)) continue;
  fileBuffer
    .toString('utf8')
    .split('\n')
    .forEach((lineText, lineIndex) => {
      if (competitorNamePattern.test(lineText)) violations.push(`${relative(repoRoot, filePath)}:${lineIndex + 1}`);
    });
}

if (violations.length > 0) {
  console.error(`The competitor name appears in product copy:\n${violations.join('\n')}`);
  process.exit(1);
}
