/* Generates the PWA icons: a chunky pixel "SO" mark in the app's palette
   (paper background, ink S, accent-orange O). No image libraries — writes
   RGB PNGs directly with zlib. Run `npm run icons` to regenerate. */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PAPER = [0xfc, 0xf8, 0xef];
const INK = [0x11, 0x25, 0x3f];
const ACCENT = [0xff, 0x4f, 0x1f];

// 5×7 glyphs
const S = [
  ".####",
  "#....",
  "#....",
  ".###.",
  "....#",
  "....#",
  "####.",
];
const O = [
  ".###.",
  "#...#",
  "#...#",
  "#...#",
  "#...#",
  "#...#",
  ".###.",
];

/* ---------- minimal PNG writer ---------- */
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
};
function png(width, height, pixels /* Uint8Array RGB */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: none
    pixels.subarray(y * width * 3, (y + 1) * width * 3).forEach((v, i) => {
      raw[y * (1 + width * 3) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- drawing ---------- */
function makeIcon(size, { frame = true, glyphFrac = 0.58 } = {}) {
  const px = new Uint8Array(size * size * 3);
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  const rect = (x0, y0, w, h, col) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++)
        if (x >= 0 && y >= 0 && x < size && y < size) set(x, y, col);
  };
  rect(0, 0, size, size, PAPER);
  if (frame) {
    const t = Math.max(2, Math.round(size / 26));
    const m = Math.round(size / 11);
    rect(m, m, size - 2 * m, t, INK);
    rect(m, size - m - t, size - 2 * m, t, INK);
    rect(m, m, t, size - 2 * m, INK);
    rect(size - m - t, m, t, size - 2 * m, INK);
  }
  // "S O" = 5 + 1 gap + 5 = 11 units wide, 7 tall
  const u = Math.max(1, Math.floor((size * glyphFrac) / 11));
  const gw = 11 * u, gh = 7 * u;
  const ox = Math.floor((size - gw) / 2), oy = Math.floor((size - gh) / 2);
  const drawGlyph = (glyph, gx, col) => {
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++)
        if (glyph[r][c] === "#") rect(ox + (gx + c) * u, oy + r * u, u, u, col);
  };
  drawGlyph(S, 0, INK);
  drawGlyph(O, 6, ACCENT);
  return png(size, size, px);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "icon-192.png"), makeIcon(192));
writeFileSync(join(outDir, "icon-512.png"), makeIcon(512));
writeFileSync(join(outDir, "apple-touch-icon.png"), makeIcon(180));
// maskable: full-bleed paper, extra padding so the OS crop can't clip the mark
writeFileSync(join(outDir, "icon-512-maskable.png"), makeIcon(512, { frame: false, glyphFrac: 0.46 }));
console.log("icons written to", outDir);
