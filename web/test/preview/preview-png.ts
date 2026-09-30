const CHART_WIDTH = 240;
const CHART_HEIGHT = 120;
const BYTES_PER_PIXEL = 3;
const BACKGROUND = [0x14, 0x12, 0x0f];
const GRID = [0x2a, 0x26, 0x20];
const BAR = [0xf5, 0xa6, 0x23];
const MAX_STORED_BLOCK = 65_535;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
	let low = 1;
	let high = 0;
	for (const byte of bytes) {
		low = (low + byte) % 65521;
		high = (high + low) % 65521;
	}
	return ((high << 16) | low) >>> 0;
}

const uint32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

function storedZlib(raw: Uint8Array): Uint8Array {
	const output: number[] = [0x78, 0x01];
	const blockCount = Math.max(1, Math.ceil(raw.length / MAX_STORED_BLOCK));
	for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
		const block = raw.subarray(blockIndex * MAX_STORED_BLOCK, (blockIndex + 1) * MAX_STORED_BLOCK);
		const isFinal = blockIndex === blockCount - 1;
		const inverted = ~block.length & 0xffff;
		output.push(isFinal ? 1 : 0, block.length & 0xff, block.length >>> 8, inverted & 0xff, inverted >>> 8);
		for (const byte of block) output.push(byte);
	}
	for (const byte of uint32(adler32(raw))) output.push(byte);
	return Uint8Array.from(output);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const typed = new Uint8Array(4 + data.length);
	typed.set([...type].map((character) => character.charCodeAt(0)), 0);
	typed.set(data, 4);
	const chunk = new Uint8Array(4 + typed.length + 4);
	chunk.set(uint32(data.length), 0);
	chunk.set(typed, 4);
	chunk.set(uint32(crc32(typed)), 4 + typed.length);
	return chunk;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

export function chartPng(barValues: number[]): Uint8Array {
	const rowLength = 1 + CHART_WIDTH * BYTES_PER_PIXEL;
	const raw = new Uint8Array(rowLength * CHART_HEIGHT);
	const barWidth = Math.floor(CHART_WIDTH / barValues.length);
	const maxValue = Math.max(...barValues, 1);
	for (let y = 0; y < CHART_HEIGHT; y += 1) {
		for (let x = 0; x < CHART_WIDTH; x += 1) {
			const barIndex = Math.min(Math.floor(x / barWidth), barValues.length - 1);
			const barHeight = Math.round((barValues[barIndex] / maxValue) * (CHART_HEIGHT - 12));
			const isInsideBar = CHART_HEIGHT - y <= barHeight && x % barWidth > 2;
			const isGridLine = y % 30 === 0;
			const color = isInsideBar ? BAR : isGridLine ? GRID : BACKGROUND;
			raw.set(color, y * rowLength + 1 + x * BYTES_PER_PIXEL);
		}
	}
	const header = Uint8Array.from([...uint32(CHART_WIDTH), ...uint32(CHART_HEIGHT), 8, 2, 0, 0, 0]);
	return concatBytes([
		Uint8Array.from(PNG_SIGNATURE),
		pngChunk('IHDR', header),
		pngChunk('IDAT', storedZlib(raw)),
		pngChunk('IEND', new Uint8Array()),
	]);
}
