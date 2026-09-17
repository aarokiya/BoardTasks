import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Lives in the `unit` project rather than `dom`: Vitest stubs CSS imports in
 * the jsdom project, so the stylesheet has to be read from disk, and the web
 * tsconfig deliberately has no `node` types.
 */
const CSS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/renderer/src/styles/tokens.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const i = CSS.indexOf(selector);
  if (i < 0) throw new Error(`Selector not found: ${selector}`);
  const open = CSS.indexOf('{', i);
  const close = CSS.indexOf('\n}', open);
  const body = CSS.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--bt-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const base = block(':root {');
const light = block(':root, :root[data-theme="light"]');
const dark = block(':root[data-theme="dark"]');

type RGB = [number, number, number];

function parseColor(raw: string, themeTokens: Record<string, string>, depth = 0): { rgb: RGB; alpha: number } | null {
  const v = raw.trim();
  if (depth > 4) return null;
  const varMatch = /^var\((--bt-[a-z0-9-]+)\)$/.exec(v);
  if (varMatch) {
    const next = themeTokens[varMatch[1]!] ?? base[varMatch[1]!];
    return next ? parseColor(next, themeTokens, depth + 1) : null;
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = (a: number, b: number): number => parseInt(h.slice(a, b), 16);
    return { rgb: [n(0, 2), n(2, 4), n(4, 6)], alpha: h.length === 8 ? n(6, 8) / 255 : 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (rgba) {
    return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  return null;
}

function composite(fg: { rgb: RGB; alpha: number }, bg: RGB): RGB {
  return [0, 1, 2].map((i) => fg.rgb[i]! * fg.alpha + bg[i]! * (1 - fg.alpha)) as RGB;
}

function luminance([r, g, b]: RGB): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fgToken: string, bgToken: string, tokens: Record<string, string>): number {
  const bgRaw = tokens[bgToken] ?? base[bgToken];
  const fgRaw = tokens[fgToken] ?? base[fgToken];
  if (!bgRaw || !fgRaw) throw new Error(`Missing token: ${!bgRaw ? bgToken : fgToken}`);
  const bgParsed = parseColor(bgRaw, tokens);
  const fgParsed = parseColor(fgRaw, tokens);
  if (!bgParsed || !fgParsed) throw new Error(`Unparseable colour: ${bgToken}=${bgRaw} / ${fgToken}=${fgRaw}`);
  // Panes sit on --bt-surface-1, so alpha-bearing tokens composite over it.
  const bgBase = composite(bgParsed, parseColor(tokens['--bt-surface-1'] ?? '#ffffff', tokens)!.rgb);
  const fg = composite(fgParsed, bgBase);
  const l1 = luminance(fg);
  const l2 = luminance(bgBase);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: Array<[string, Record<string, string>]> = [['light', light], ['dark', dark]];

const TEXT_TOKENS = ['--bt-text-primary', '--bt-text-secondary', '--bt-text-tertiary'];
const SURFACES = ['--bt-surface-1', '--bt-surface-2', '--bt-surface-3', '--bt-surface-selected'];
const SEMANTIC = ['success', 'warning', 'danger', 'overdue', 'info', 'gh-open', 'gh-closed', 'gh-merged', 'gh-draft'];
const BOUNDARIES = ['--bt-border-strong', '--bt-accent', '--bt-danger'];

describe('design tokens', () => {
  it('light and dark define the identical token set', () => {
    const l = Object.keys(light).sort();
    const d = Object.keys(dark).sort();
    expect(d.filter((k) => !l.includes(k))).toEqual([]);
    expect(l.filter((k) => !d.includes(k))).toEqual([]);
  });

  it('every list colour exists in both themes', () => {
    for (const c of ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']) {
      expect(light[`--bt-list-${c}`], `light --bt-list-${c}`).toBeTruthy();
      expect(dark[`--bt-list-${c}`], `dark --bt-list-${c}`).toBeTruthy();
    }
  });

  describe.each(THEMES)('%s theme', (name, tokens) => {
    it('text colours reach 4.5:1 on every surface', () => {
      const failures: string[] = [];
      for (const t of TEXT_TOKENS) {
        for (const s of SURFACES) {
          const ratio = contrast(t, s, tokens);
          if (ratio < 4.5) failures.push(`${name}: ${t} on ${s} = ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it('on-accent text reaches 4.5:1 on the accent', () => {
      expect(contrast('--bt-text-on-accent', '--bt-accent', tokens)).toBeGreaterThanOrEqual(4.5);
    });

    it('semantic colours reach 4.5:1 on their own subtle backgrounds', () => {
      const failures: string[] = [];
      for (const s of SEMANTIC) {
        const ratio = contrast(`--bt-${s}`, `--bt-${s}-subtle`, tokens);
        if (ratio < 4.5) failures.push(`${name}: --bt-${s} on --bt-${s}-subtle = ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });

    it('control boundaries reach 3:1 on surface-1', () => {
      const failures: string[] = [];
      for (const b of BOUNDARIES) {
        const ratio = contrast(b, '--bt-surface-1', tokens);
        if (ratio < 3) failures.push(`${name}: ${b} on --bt-surface-1 = ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });
  });
});
