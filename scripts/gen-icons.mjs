// Generates the extension's sun icons (16/32/48/128 px) as PNGs.
// Pure Node — hand-rolled PNG encoding via zlib, no image libraries.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

/* ---------- minimal PNG encoder ---------- */

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- sun drawing ---------- */

const CORE = [255, 221, 102]; // warm center
const EDGE = [245, 158, 11]; // amber edge / rays

// Coverage+color at a normalized point (0..1); returns [r,g,b,coverage].
function sampleSun(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const d = Math.hypot(dx, dy);

  const diskR = 0.27;
  if (d < diskR) {
    const t = d / diskR;
    return [
      CORE[0] + (EDGE[0] - CORE[0]) * t,
      CORE[1] + (EDGE[1] - CORE[1]) * t,
      CORE[2] + (EDGE[2] - CORE[2]) * t,
      1,
    ];
  }

  const rayIn = 0.36;
  const rayOut = 0.48;
  if (d >= rayIn && d <= rayOut) {
    const seg = Math.PI / 4; // 8 rays
    const ang = Math.atan2(dy, dx);
    const angDist = Math.abs(ang - Math.round(ang / seg) * seg);
    if (angDist < 0.16) return [...EDGE, 1];
  }
  return [0, 0, 0, 0];
}

function drawSun(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // 4×4 supersampling for smooth edges at small sizes
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sampleSun(
            (px + (sx + 0.5) / SS) / size,
            (py + (sy + 0.5) / SS) / size,
          );
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return rgba;
}

mkdirSync("icons", { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`icons/icon${size}.png`, encodePng(size, drawSun(size)));
  console.log(`icons/icon${size}.png`);
}
