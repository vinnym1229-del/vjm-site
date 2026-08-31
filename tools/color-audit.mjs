#!/usr/bin/env node
/* Palette audit — measures how much of the site's color is red.
 *
 * The site was originally gold/emerald/blue and was mass find-replaced to red,
 * which left every border, glow, chip and "positive" state the same alarm red.
 * This tool parses every color literal out of the shipped HTML/CSS/JS and
 * reports the share that is red, plus any retired literal still present.
 *
 * Usage: node tools/color-audit.mjs [--json] [--ref <git-ref>]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Files whose colors reach a browser. Anything else (docs, tests) is ignored. */
export function shippedFiles(root = ROOT) {
  const out = [];
  for (const name of readdirSync(root)) {
    if (name.endsWith('.html')) out.push(name);
  }
  for (const name of readdirSync(join(root, 'assets'))) {
    if (name.endsWith('.css') || name.endsWith('.js')) out.push(join('assets', name));
  }
  return out.sort();
}

/** Literals from the old all-red palette that must not come back. */
export const RETIRED = [
  '#dc2626', '#ef4444', '#b91c1c', '#991b1b', '#f87171', '#fca5a5',
  '#ff4d4d', '#ff4444', '#ff6b6b', '#ff9a9a', '#ff7a7a',
  '#e11d48', '#f43f5e', '#dc2f02',
];
const RETIRED_RGBA = [
  /rgba?\(\s*220\s*,\s*38\s*,\s*38\s*[,)]/i,
  /rgba?\(\s*255\s*,\s*68\s*,\s*68\s*[,)]/i,
  /rgba?\(\s*239\s*,\s*68\s*,\s*68\s*[,)]/i,
  /rgba?\(\s*185\s*,\s*28\s*,\s*28\s*[,)]/i,
];

const HEX = /#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
const FUNC = /\brgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/gi;

export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a };
}

/** Extract every color literal in a source string, with its alpha. */
export function extractColors(src) {
  const colors = [];
  for (const m of src.matchAll(HEX)) colors.push({ raw: m[0], ...hexToRgb(m[0]) });
  for (const m of src.matchAll(FUNC)) {
    const rawA = m[4];
    const a = rawA === undefined ? 1 : rawA.endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
    colors.push({ raw: m[0], r: +m[1], g: +m[2], b: +m[3], a: Number.isFinite(a) ? a : 1 });
  }
  return colors;
}

function hsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === R) h = 60 * (((G - B) / d) % 6);
  else if (max === G) h = 60 * ((B - R) / d + 2);
  else h = 60 * ((R - G) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

/** Red = a saturated, visible warm-red hue. Near-grays and faint washes don't count. */
export function isRed(c) {
  const { h, s, l } = hsl(c);
  if (s < 0.25 || l < 0.06 || l > 0.94) return false;
  if (c.a < 0.06) return false;
  return h <= 18 || h >= 342;
}
export function isChromatic(c) {
  const { s, l } = hsl(c);
  return s >= 0.25 && l >= 0.06 && l <= 0.94 && c.a >= 0.06;
}

function relLuminance({ r, g, b }) {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(fg, bg) {
  const a = relLuminance(fg), b = relLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function auditFile(path, src) {
  const colors = extractColors(src);
  const chromatic = colors.filter(isChromatic);
  const red = chromatic.filter(isRed);
  const retired = [];
  for (const lit of RETIRED) {
    const n = (src.match(new RegExp(lit, 'gi')) || []).length;
    if (n) retired.push(`${lit} x${n}`);
  }
  for (const re of RETIRED_RGBA) {
    const n = (src.match(new RegExp(re.source, 'gi')) || []).length;
    if (n) retired.push(`${re.source} x${n}`);
  }
  return {
    path,
    total: colors.length,
    chromatic: chromatic.length,
    red: red.length,
    redShare: chromatic.length ? red.length / chromatic.length : 0,
    retired,
  };
}

export function auditTree(root = ROOT, readFile = (p) => readFileSync(join(root, p), 'utf8')) {
  return shippedFiles(root).map((p) => auditFile(p, readFile(p)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootArg = process.argv.indexOf('--root');
  const root = rootArg > -1 ? process.argv[rootArg + 1] : ROOT;
  const rows = auditTree(root, (p) => readFileSync(join(root, p), 'utf8'));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const tot = rows.reduce((a, r) => ({ t: a.t + r.total, c: a.c + r.chromatic, r: a.r + r.red }), { t: 0, c: 0, r: 0 });
    console.log('file                              colors   red  red/all  retired');
    for (const r of rows.filter((r) => r.total)) {
      console.log(
        `${r.path.padEnd(33)} ${String(r.total).padStart(6)} ${String(r.red).padStart(5)} ` +
        `${((r.red / r.total) * 100).toFixed(0).padStart(6)}%  ${r.retired.join(', ')}`,
      );
    }
    console.log(`\nsite-wide: ${tot.r} of ${tot.t} color literals are red (${((tot.r / tot.t) * 100).toFixed(1)}%)`);
    console.log(`non-red chromatic hues remaining: ${tot.c - tot.r}`);
    const bad = rows.filter((r) => r.retired.length);
    if (bad.length) {
      console.log(`\nRETIRED LITERALS STILL PRESENT in ${bad.length} file(s):`);
      for (const r of bad) console.log(`  ${r.path}: ${r.retired.join(', ')}`);
      process.exitCode = 1;
    }
  }
}
