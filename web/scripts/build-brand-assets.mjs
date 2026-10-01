import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, '../..');
const publicDirectory = resolve(scriptDirectory, '../public');
const fontkitArgument = process.argv.indexOf('--fontkit');
const fontkitPath = fontkitArgument === -1 ? process.env.FONTKIT_MODULE : process.argv[fontkitArgument + 1];

if (!fontkitPath) {
	console.error('Install fontkit 2.0.4 outside the repository: npm install --prefix /tmp/backchannels-brand-tools --no-audit --no-fund --ignore-scripts fontkit@2.0.4');
	console.error('Then run: node web/scripts/build-brand-assets.mjs --fontkit /tmp/backchannels-brand-tools/node_modules/fontkit/dist/main.cjs');
	process.exit(1);
}

const require = createRequire(import.meta.url);
const fontkit = require(resolve(fontkitPath));
const ground = '#0e0f0c';
const accent = '#ffb547';
const textColor = '#e8e6d9';
const landingLine = 'the messaging platform where your agents collude';
const fontDirectory = join(repositoryDirectory, 'node_modules/.pnpm');
const fontSource = (family, weight) => {
	const packageDirectory = readdirSync(fontDirectory).find((entry) => entry.startsWith(`@fontsource+${family}@5.3.0`));
	if (!packageDirectory) throw new Error(`Install the repository dependencies to provide @fontsource/${family} 5.3.0`);
	return join(fontDirectory, packageDirectory, 'node_modules/@fontsource', family, 'files', `${family}-latin-${weight}-normal.woff2`);
};
const monoSource = fontSource('ibm-plex-mono', 600);
const sansSource = fontSource('ibm-plex-sans', 400);
const mono = fontkit.create(readFileSync(monoSource));
const sans = fontkit.create(readFileSync(sansSource));
const rearPane = 'M4 4H24V18H12L4 24Z';
const frontPane = 'M12 12H28V28L22 24H12Z';
const mark = (x, y, size, ink = accent, surface = ground) => `<g transform="translate(${x} ${y}) scale(${size / 32})" fill="${surface}" stroke="${ink}" stroke-width="3" stroke-linejoin="miter"><path d="${rearPane}"/><path d="${frontPane}"/></g>`;
const svg = (width, height, body, description) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>backchannels</title><desc>${description}</desc>${body}</svg>\n`;
const textPaths = (font, label, x, baseline, size, color) => {
	const layout = font.layout(label);
	const scale = size / font.unitsPerEm;
	let cursor = x;
	const paths = layout.glyphs.map((glyph, index) => {
		const position = layout.positions[index];
		const path = `<path transform="translate(${cursor + position.xOffset * scale} ${baseline - position.yOffset * scale}) scale(${scale} ${-scale})" d="${glyph.path.toSVG()}"/>`;
		cursor += position.xAdvance * scale;
		return path;
	}).join('');
	return `<g fill="${color}" aria-label="${label}">${paths}</g>`;
};
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>backchannels</title><desc>Two offset chat panes with opposite tails.</desc><style>:root{--surface:#fff;--ink:#0e0f0c}@media(prefers-color-scheme:dark){:root{--surface:#0e0f0c;--ink:#ffb547}}.pane{fill:var(--surface);stroke:var(--ink);stroke-width:3;stroke-linejoin:miter}</style><path class="pane" d="${rearPane}"/><path class="pane" d="${frontPane}"/></svg>\n`;
const ogSource = svg(1200, 630,
	`<metadata>Source: web/scripts/build-brand-assets.mjs. Typeface paths: @fontsource/ibm-plex-mono 5.3.0 latin 600 normal; @fontsource/ibm-plex-sans 5.3.0 latin 400 normal. Palette: web/src/styles/tokens.css.</metadata><rect width="1200" height="630" fill="${ground}"/>${mark(80, 83, 128)}${textPaths(mono, 'backchannels', 80, 331, 88, accent)}${textPaths(sans, 'the messaging platform', 80, 422, 52, textColor)}${textPaths(sans, 'where your agents collude', 80, 486, 52, textColor)}`,
	landingLine);

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});
const pngTextChunk = (value) => {
	const type = Buffer.from('tEXt');
	const data = Buffer.from(`impeccable:prompt\0${value}`);
	const chunk = Buffer.alloc(data.length + 12);
	chunk.writeUInt32BE(data.length);
	type.copy(chunk, 4);
	data.copy(chunk, 8);
	let crc = 0xffffffff;
	for (const byte of Buffer.concat([type, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
	chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
	return chunk;
};
const renderPng = (source, width, height, outputPath, provenance) => {
	const png = execFileSync('rsvg-convert', ['--width', String(width), '--height', String(height)], { input: source });
	const iendOffset = png.indexOf(Buffer.from('IEND')) - 4;
	if (iendOffset < 8) throw new Error('The SVG renderer did not return a valid PNG');
	writeFileSync(outputPath, Buffer.concat([png.subarray(0, iendOffset), pngTextChunk(provenance), png.subarray(iendOffset)]));
};
const provenance = 'Authored SVG geometry from web/scripts/build-brand-assets.mjs: two offset chat panes with opposite tails, three-unit miter strokes. Incumbent colors from web/src/styles/tokens.css. Rendered with rsvg-convert; no generated imagery.';
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'backchannels-brand-'));

try {
	writeFileSync(join(publicDirectory, 'favicon.svg'), favicon);
	writeFileSync(join(publicDirectory, 'og.svg'), ogSource);
	renderPng(svg(32, 32, `<rect width="32" height="32" fill="${ground}"/>${mark(0, 0, 32)}`, 'Two offset chat panes with opposite tails.'), 32, 32, join(temporaryDirectory, 'favicon.png'), provenance);
	execFileSync('magick', [join(temporaryDirectory, 'favicon.png'), '-define', 'icon:auto-resize=32', join(publicDirectory, 'favicon.ico')]);
	renderPng(svg(180, 180, `<rect width="180" height="180" fill="${ground}"/>${mark(26, 26, 128)}`, 'Two offset chat panes with opposite tails.'), 180, 180, join(publicDirectory, 'apple-touch-icon.png'), `${provenance} Opaque 180 by 180 Apple touch icon; 128-unit mark at 26,26.`);
	renderPng(ogSource, 1200, 630, join(publicDirectory, 'og.png'), `${provenance} Source: web/public/og.svg. IBM Plex Mono 600 for backchannels at 88px; IBM Plex Sans 400 for the exact landing line at 52px. Both fonts are @fontsource version 5.3.0 and converted to vector paths by fontkit 2.0.4. Exact copy: ${landingLine}`);
	console.log('Created favicon.svg (32-unit vector), favicon.ico (32x32), apple-touch-icon.png (180x180), og.svg and og.png (1200x630).');
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
