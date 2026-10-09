#!/usr/bin/env node
/**
 * PNG icon generation for the PWA (finding F-09).
 *
 * The manifest previously listed a single SVG. That is enough for a browser tab and
 * not enough for an install: Chrome and Android require at least one 192px and one
 * 512px PNG, iOS ignores SVG for `apple-touch-icon`, and a `maskable` icon needs its
 * own safe-zone geometry. So the platform ships a real PNG set.
 *
 * It is generated here, in this repository, with `node:zlib` and arithmetic — no
 * image package, no binary blob committed without a source. `--check` re-renders and
 * compares bytes, so a hand-edited or stale icon fails `npm run verify:install`
 * instead of silently shipping. Rendering is deterministic: same input, same bytes.
 *
 * Usage:  node tools/generate-icons.mjs [--check] [--out public/icons]
 */

import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encodes RGBA samples (4 bytes per pixel, top-down) as a PNG.
 * Filter type 0 on every row: the images are small and deflate does the work.
 */
export function encodePng(width, height, rgba) {
  if (!(rgba instanceof Uint8Array)) throw new Error("RGBA samples must be a Uint8Array");
  if (rgba.length !== width * height * 4) throw new Error(`Expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None) for every scanline
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Reads width/height/colour type back out of a PNG, for the verification checks. */
export function readPngHeader(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("Not a PNG file");
  if (buffer.toString("ascii", 12, 16) !== "IHDR") throw new Error("Malformed PNG: IHDR is not the first chunk");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

// ------------------------------------------------------------------- geometry

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

/** Signed distance to a rounded rectangle centred on the unit square. */
function roundedRectDistance(x, y, { inset, radius }) {
  const half = 0.5 - inset;
  const dx = Math.abs(x - 0.5) - half + radius;
  const dy = Math.abs(y - 0.5) - half + radius;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax;
  const vy = by - ay;
  const length2 = vx * vx + vy * vy;
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / length2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * The brand mark: a "W" drawn as a round-capped polyline. Coordinates are in the
 * unit square so every icon size renders the same geometry.
 */
const W_POINTS = Object.freeze([
  [0.185, 0.295],
  [0.345, 0.715],
  [0.5, 0.435],
  [0.655, 0.715],
  [0.815, 0.295],
]);

function insideMark(x, y, { scale, strokeWidth }) {
  // Scale the glyph about the centre so a maskable icon can shrink into its
  // safe zone without a second set of coordinates.
  const cx = 0.5 + (x - 0.5) / scale;
  const cy = 0.5 + (y - 0.5) / scale;
  for (let index = 0; index < W_POINTS.length - 1; index += 1) {
    if (distanceToSegment(cx, cy, W_POINTS[index], W_POINTS[index + 1]) <= strokeWidth / 2) return true;
  }
  return false;
}

/**
 * @param {object} options
 * @param {number} options.size          pixel width/height (square)
 * @param {boolean} [options.fullBleed]  background covers the canvas (maskable, apple-touch)
 * @param {number} [options.scale]       glyph scale, 1 = full, 0.62 = maskable safe zone
 * @param {number} [options.samples]     supersampling per axis for anti-aliasing
 * @returns {Buffer} RGBA samples
 */
export function renderMark({ size, fullBleed = false, scale = 1, samples = 3, background = "#071511", ring = "#c1f18b", glyph = "#c1f18b" }) {
  const rgba = Buffer.alloc(size * size * 4);
  const [br, bg, bb] = hexToRgb(background);
  const [rr, rg, rb] = hexToRgb(ring);
  const [gr, gg, gb] = hexToRgb(glyph);
  const inset = fullBleed ? 0 : 0.015;
  const radius = fullBleed ? 0 : 0.185;
  const strokeWidth = 0.088 * scale;
  const ringWidth = 0.022;
  const step = 1 / samples;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let backgroundHits = 0;
      let ringHits = 0;
      let glyphHits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        const y = (py + (sy + 0.5) * step) / size;
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) * step) / size;
          const distance = roundedRectDistance(x, y, { inset, radius });
          if (distance > 0) continue;
          backgroundHits += 1;
          const ringDistance = Math.abs(distance + ringWidth / 2);
          if (!fullBleed && ringDistance <= ringWidth / 2) ringHits += 1;
          if (insideMark(x, y, { scale, strokeWidth })) glyphHits += 1;
        }
      }
      const total = samples * samples;
      if (backgroundHits === 0) continue;

      // Painter's order: background, then ring, then glyph, each with its own
      // coverage so the edges stay smooth at 192px and crisp at 512px.
      let alpha = backgroundHits / total;
      let red = br;
      let green = bg;
      let blue = bb;
      const blend = (coverage, [cr, cg, cb]) => {
        if (coverage <= 0) return;
        red = red * (1 - coverage) + cr * coverage;
        green = green * (1 - coverage) + cg * coverage;
        blue = blue * (1 - coverage) + cb * coverage;
        alpha = Math.min(1, alpha + coverage * (1 - alpha));
      };
      blend(ringHits / total, [rr, rg, rb]);
      blend(glyphHits / total, [gr, gg, gb]);

      const offset = (py * size + px) * 4;
      rgba[offset] = Math.round(red);
      rgba[offset + 1] = Math.round(green);
      rgba[offset + 2] = Math.round(blue);
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

/**
 * The icon set. Sizes and purposes are the ones Chromium, Safari and the Web App
 * Manifest specification actually consult; `maskable` keeps the glyph inside the
 * inner 80% safe zone so an adaptive launcher cannot crop it.
 */
export const ICON_SPECS = Object.freeze([
  { file: "icon-192.png", size: 192, purpose: "any" },
  { file: "icon-512.png", size: 512, purpose: "any" },
  { file: "maskable-512.png", size: 512, purpose: "maskable", fullBleed: true, scale: 0.62 },
  { file: "apple-touch-icon.png", size: 180, purpose: "apple-touch-icon", fullBleed: true, scale: 0.86 },
]);

export function renderIcon(spec) {
  return encodePng(spec.size, spec.size, renderMark({ size: spec.size, fullBleed: spec.fullBleed || false, scale: spec.scale || 1 }));
}

async function main() {
  const check = process.argv.includes("--check");
  const outIndex = process.argv.indexOf("--out");
  const target = path.resolve(ROOT, outIndex >= 0 ? process.argv[outIndex + 1] : "public/icons");
  await mkdir(target, { recursive: true });

  let failures = 0;
  for (const spec of ICON_SPECS) {
    const rendered = renderIcon(spec);
    const destination = path.join(target, spec.file);
    if (!check) {
      await writeFile(destination, rendered);
      console.log(`wrote ${path.relative(ROOT, destination)} (${spec.size}x${spec.size}, ${rendered.length} bytes)`);
      continue;
    }
    const existing = await readFile(destination).catch(() => null);
    if (!existing) {
      console.error(`[FAIL] ${spec.file} is missing — run \`npm run build:icons\``);
      failures += 1;
      continue;
    }
    const same = existing.equals(rendered);
    const header = readPngHeader(existing);
    if (!same || header.width !== spec.size || header.height !== spec.size || header.colorType !== 6) {
      console.error(`[FAIL] ${spec.file} does not match the generated icon (${header.width}x${header.height}, ${existing.length} bytes on disk vs ${rendered.length} generated)`);
      failures += 1;
    } else {
      console.log(`[PASS] ${spec.file} ${spec.size}x${spec.size} RGBA`);
    }
  }
  if (failures) {
    console.error(`${failures} icon check(s) failed`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
