// Gera os ícones do web app (PNG) em public/icons — tudo em código, sem
// dependências: o mesmo retrato do favicon, sentado atrás de uma mesa.
//   node packages/web/scripts/make-icons.mjs
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

/** Retrato 16×16 (cabeça e ombros) do mascote; '.' é transparente. */
const PORTRAIT = [
  '................',
  '................',
  '................',
  '.......aa.......',
  '.....aabbaa.....',
  '....abaccaba....',
  '.....abbbba.....',
  '....adddddda....',
  '...aeddeeeeea...',
  '..aeeeeeeeeefa..',
  '..aeggggggggfa..',
  '..aeghgggghgfa..',
  '..aeghgggghgfa..',
  '..aeiggggggifa..',
  '...afjjjjjjfa...',
  '..akkeeeeefkka..',
];
const PALETTE = {
  a: '#272133',
  b: '#ffd166',
  c: '#ffe3a3',
  d: '#c88f69',
  e: '#b9703f',
  f: '#945a34',
  g: '#b97a50',
  h: '#33242c',
  i: '#a36b47',
  j: '#9b6644',
  k: '#a76539',
};

const WALL = '#4a62b4';
const DESK_TOP = '#3a4159';
const DESK = '#1b1f2c';
/** As quatro cores da marca, como um adesivo 2×2 na frente da mesa. */
const BRAND = { '9,17': '#e8885a', '10,17': '#ffd84a', '9,18': '#7fb2ff', '10,18': '#4fc6a8' };

/** A arte ocupa 20×20 células; fora dela a parede e a mesa continuam. */
const ART = 20;
const DESK_ROW = 16;

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function colorAt(gx, gy) {
  if (gy >= DESK_ROW) return BRAND[`${gx},${gy}`] ?? (gy === DESK_ROW ? DESK_TOP : DESK);
  const key = PORTRAIT[gy]?.[gx - 2];
  return (key && PALETTE[key]) || WALL;
}

/**
 * `maskable`: quadrado inteiro, arte na zona segura (o sistema recorta).
 * Caso contrário: quadrado arredondado no padrão do macOS, com margem transparente.
 */
function render(size, maskable) {
  const cells = maskable ? 26 : ART;
  const body = maskable ? size : size * (800 / 1024);
  const off = (size - body) / 2;
  const radius = maskable ? 0 : body * 0.225;
  const cell = body / cells;
  const pad = (cells - ART) / 2;
  const half = body / 2;
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const bx = x + (sx + 0.5) / SS - off;
          const by = y + (sy + 0.5) / SS - off;
          if (bx < 0 || by < 0 || bx >= body || by >= body) continue;
          const dx = Math.max(Math.abs(bx - half) - (half - radius), 0);
          const dy = Math.max(Math.abs(by - half) - (half - radius), 0);
          if (dx * dx + dy * dy > radius * radius) continue;
          const c = rgb(colorAt(Math.floor(bx / cell - pad), Math.floor(by / cell - pad)));
          r += c[0];
          g += c[1];
          b += c[2];
          hits++;
        }
      }
      if (!hits) continue;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / hits);
      out[i + 1] = Math.round(g / hits);
      out[i + 2] = Math.round(b / hits);
      out[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(dir, { recursive: true });
const files = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-1024.png', 1024, false],
  ['maskable-192.png', 192, true],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
];
for (const [name, size, maskable] of files) {
  writeFileSync(`${dir}${name}`, png(size, render(size, maskable)));
  console.log(`${name} ${size}×${size}`);
}
