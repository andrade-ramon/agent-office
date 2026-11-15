// Gera os sons do alerta (WAV mono 16 bits) em assets/sounds — tudo em código,
// sem dependências nem áudio de terceiros.
//   node packages/server/scripts/make-sounds.mjs
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RATE = 22050;

/** Timbre com harmônicos (mais "buzina" que um seno puro), limitado a [-1, 1]. */
function voice(phase) {
  return Math.tanh(1.6 * (Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase)));
}

/** Evita estalos: sobe e desce o volume nas pontas. */
function fade(i, total, edge = 0.03 * RATE) {
  return Math.min(1, i / edge, (total - 1 - i) / edge);
}

/** Sirene: o tom sobe e desce entre 700 e 1200 Hz, duas vezes em 3 s. */
function siren() {
  const total = Math.round(3 * RATE);
  const out = new Float64Array(total);
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const t = i / RATE;
    const freq = 700 + 500 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 1.5));
    phase += (2 * Math.PI * freq) / RATE;
    out[i] = 0.7 * voice(phase) * fade(i, total);
  }
  return out;
}

/** Bipe: três toques curtos e agudos. */
function beep() {
  const tone = Math.round(0.16 * RATE);
  const gap = Math.round(0.09 * RATE);
  const out = new Float64Array(3 * tone + 2 * gap);
  for (let n = 0; n < 3; n++) {
    for (let i = 0; i < tone; i++) {
      const phase = (2 * Math.PI * 988 * i) / RATE;
      out[n * (tone + gap) + i] = 0.6 * voice(phase) * fade(i, tone, 0.012 * RATE);
    }
  }
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16); // tamanho do bloco fmt
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const dir = fileURLToPath(new URL('../assets/sounds/', import.meta.url));
mkdirSync(dir, { recursive: true });
for (const [name, samples] of [['siren', siren()], ['beep', beep()]]) {
  writeFileSync(`${dir}${name}.wav`, wav(samples));
  console.log(`${name}.wav ${(samples.length / RATE).toFixed(2)}s`);
}
