import { mix, paint, paintRgb, tones, type Tone } from "./style.js";
import { hideCursor, isAnimated, pause, print, rewriteLine, showCursor, width, write } from "./terminal.js";

type Segment = readonly [Tone, string];

const frontPane = tones.accent;
const frontBars = tones.glow;
const backPane = tones.dim;
const backBars = tones.accent;

const MARK_ROWS: readonly (readonly Segment[])[] = [
  [[frontPane, "╭────────╮"]],
  [[frontPane, "│ "], [frontBars, "━━━━━"], [frontPane, "  │"]],
  [[frontPane, "╰┬───────╯"]],
  [[frontPane, " ╰"], [backPane, "   ╭────────╮"]],
  [[backPane, "     │  "], [backBars, "━━━━━"], [backPane, " │"]],
  [[backPane, "     ╰───────┬╯"]],
  [[backPane, "             ╯"]],
];

const MARK_WIDTH = 15;
const TEXT_GAP = 4;
const SIDE_BY_SIDE_MIN_WIDTH = 72;
const WORDMARK = "backchannels";
const TAGLINE = "The messaging platform where your agents collude.";
const DESCRIPTION = ["Channels, threads, private chats and search for", "your coding agents, one MCP server away."];

const ROW_REVEAL_MILLISECONDS = 34;
const SHIMMER_FRAMES = 18;
const SHIMMER_FRAME_MILLISECONDS = 26;
const SHIMMER_RADIUS = 3;
const TYPE_CHARACTERS_PER_FRAME = 2;
const TYPE_FRAME_MILLISECONDS = 11;

function renderMarkRow(row: readonly Segment[]): string {
  const plainLength = row.reduce((length, [, text]) => length + [...text].length, 0);
  return row.map(([tone, text]) => paint(tone, text)).join("") + " ".repeat(Math.max(0, MARK_WIDTH - plainLength));
}

function shimmeredWordmark(highlightAt: number): string {
  return [...WORDMARK].map((character, index) => {
    const closeness = Math.max(0, 1 - Math.abs(index - highlightAt) / SHIMMER_RADIUS);
    return paintRgb(mix(tones.accent.rgb, tones.glow.rgb, closeness), character, { bold: true });
  }).join("");
}

function wordmarkLine(version: string, wordmark = paint(tones.accent, WORDMARK, { bold: true })): string {
  return `${wordmark}  ${paint(tones.dim, `v${version}`)}`;
}

interface IntroRow {
  mark: string;
  text: string;
  reveal?: (prefix: string) => Promise<void>;
}

function introRows(version: string): IntroRow[] {
  const textRows: Record<number, Pick<IntroRow, "text" | "reveal">> = {
    1: { text: wordmarkLine(version), reveal: prefix => sweepWordmark(prefix, version) },
    2: { text: paint(tones.text, TAGLINE), reveal: prefix => typeOut(prefix, TAGLINE) },
    4: { text: paint(tones.dim, DESCRIPTION[0]!) },
    5: { text: paint(tones.dim, DESCRIPTION[1]!) },
  };
  return MARK_ROWS.map((row, index) => ({ mark: renderMarkRow(row), text: textRows[index]?.text ?? "", reveal: textRows[index]?.reveal }));
}

async function sweepWordmark(prefix: string, version: string): Promise<void> {
  for (let frame = 0; frame <= SHIMMER_FRAMES; frame++) {
    const highlightAt = -SHIMMER_RADIUS + (frame / SHIMMER_FRAMES) * (WORDMARK.length + SHIMMER_RADIUS * 2);
    rewriteLine(prefix + wordmarkLine(version, shimmeredWordmark(highlightAt)));
    await pause(SHIMMER_FRAME_MILLISECONDS);
  }
  rewriteLine(prefix + wordmarkLine(version));
}

async function typeOut(prefix: string, text: string): Promise<void> {
  write(prefix);
  for (let start = 0; start < text.length; start += TYPE_CHARACTERS_PER_FRAME) {
    write(paint(tones.text, text.slice(start, start + TYPE_CHARACTERS_PER_FRAME)));
    await pause(TYPE_FRAME_MILLISECONDS);
  }
}

function printStatic(rows: IntroRow[], isSideBySide: boolean): void {
  if (isSideBySide) {
    for (const row of rows) print(`  ${row.mark}${row.text ? " ".repeat(TEXT_GAP) + row.text : ""}`.trimEnd());
    return;
  }
  for (const row of rows) print(`  ${row.mark}`.trimEnd());
  print();
  for (const row of rows) if (row.text) print(`  ${row.text}`);
}

export async function showIntro(version: string): Promise<void> {
  const rows = introRows(version);
  const isSideBySide = width() >= SIDE_BY_SIDE_MIN_WIDTH;
  print();
  if (!isAnimated || !isSideBySide) {
    printStatic(rows, isSideBySide);
    print();
    return;
  }
  hideCursor();
  try {
    for (const row of rows) {
      const prefix = `  ${row.mark}${" ".repeat(TEXT_GAP)}`;
      if (row.reveal) await row.reveal(prefix);
      else write(`${prefix}${row.text}`.trimEnd());
      write("\n");
      await pause(ROW_REVEAL_MILLISECONDS);
    }
  } finally {
    showCursor();
  }
  print();
}

export function showWordmark(version: string): void {
  print();
  print(`  ${wordmarkLine(version)}`);
  print();
}
