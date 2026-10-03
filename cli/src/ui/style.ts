import { env, stdout } from "node:process";

type ColorDepth = "none" | "basic" | "ansi256" | "truecolor";
export type Rgb = readonly [number, number, number];

export interface Tone {
  rgb: Rgb;
  ansi256: number;
  basic: number;
}

export const tones = {
  accent: { rgb: [255, 181, 71], ansi256: 215, basic: 33 },
  glow: { rgb: [255, 236, 196], ansi256: 230, basic: 93 },
  text: { rgb: [232, 230, 217], ansi256: 254, basic: 37 },
  muted: { rgb: [201, 199, 186], ansi256: 251, basic: 37 },
  dim: { rgb: [140, 138, 125], ansi256: 245, basic: 90 },
  faint: { rgb: [86, 85, 76], ansi256: 240, basic: 90 },
  success: { rgb: [124, 227, 139], ansi256: 114, basic: 32 },
  danger: { rgb: [255, 138, 122], ansi256: 210, basic: 31 },
  claude: { rgb: [217, 161, 242], ansi256: 183, basic: 35 },
  codex: { rgb: [124, 227, 139], ansi256: 114, basic: 32 },
  cursor: { rgb: [110, 193, 255], ansi256: 75, basic: 36 },
} as const satisfies Record<string, Tone>;

interface Emphasis {
  bold?: boolean;
  underline?: boolean;
}

const ESCAPE = "\x1b[";
const RESET = `${ESCAPE}0m`;
const ESCAPE_SEQUENCE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function detectColorDepth(): ColorDepth {
  if (isSet(env.NO_COLOR) || env.FORCE_COLOR === "0" || env.TERM === "dumb") return "none";
  if (!stdout.isTTY && !isSet(env.FORCE_COLOR)) return "none";
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return "truecolor";
  if (/256/.test(env.TERM ?? "")) return "ansi256";
  return "basic";
}

export const colorDepth = detectColorDepth();
export const hasTrueColor = colorDepth === "truecolor";

function foregroundCode(tone: Tone): string {
  if (colorDepth === "truecolor") return `38;2;${tone.rgb.join(";")}`;
  if (colorDepth === "ansi256") return `38;5;${tone.ansi256}`;
  return String(tone.basic);
}

function emphasisCodes({ bold = false, underline = false }: Emphasis): string[] {
  return [...bold ? ["1"] : [], ...underline ? ["4"] : []];
}

export function paint(tone: Tone, text: string, emphasis: Emphasis = {}): string {
  if (colorDepth === "none" || text === "") return text;
  return `${ESCAPE}${[...emphasisCodes(emphasis), foregroundCode(tone)].join(";")}m${text}${RESET}`;
}

export function paintRgb(rgb: Rgb, text: string, emphasis: Emphasis = {}): string {
  if (!hasTrueColor) return paint(tones.accent, text, emphasis);
  return `${ESCAPE}${[...emphasisCodes(emphasis), `38;2;${rgb.map(Math.round).join(";")}`].join(";")}m${text}${RESET}`;
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const clamped = Math.min(1, Math.max(0, amount));
  const channel = (index: 0 | 1 | 2) => from[index] + (to[index] - from[index]) * clamped;
  return [channel(0), channel(1), channel(2)];
}

export function visibleLength(text: string): number {
  return [...text.replace(ESCAPE_SEQUENCE, "")].length;
}

export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}
