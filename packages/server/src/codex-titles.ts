import { open, stat } from 'node:fs/promises';
import type { SessionStore } from './state.js';
import { isObj, str } from './util.js';

const TAIL_BYTES = 512 * 1024;

/**
 * O Codex mantém `~/.codex/session_index.jsonl` com o nome de cada thread
 * (`{ id, thread_name, updated_at }`, a última linha de um id vale). Usamos
 * esse nome como "assunto" das sessões do Codex.
 */
export class CodexTitleWatcher {
  private readonly names = new Map<string, string>();
  private mtimeMs = -1;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly file: string,
    private readonly store: SessionStore,
    private readonly intervalMs = 5000,
  ) {}

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const st = await stat(this.file);
      if (st.mtimeMs !== this.mtimeMs) {
        this.mtimeMs = st.mtimeMs;
        await this.read(st.size);
      }
      this.apply();
    } catch {
      /* índice ausente: sessões do Codex ficam sem assunto */
    } finally {
      this.busy = false;
    }
  }

  private async read(size: number): Promise<void> {
    const start = Math.max(0, size - TAIL_BYTES);
    const fh = await open(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      for (const line of lines) {
        if (!line.startsWith('{')) continue;
        try {
          const row: unknown = JSON.parse(line);
          if (!isObj(row)) continue;
          const id = str(row.id);
          const name = str(row.thread_name);
          if (id && name) this.names.set(id.toLowerCase(), name);
        } catch {
          /* linha parcial ou inválida */
        }
      }
    } finally {
      await fh.close();
    }
  }

  /** Aplica os nomes às sessões do Codex presentes (inclusive as que acabaram de aparecer). */
  private apply(): void {
    for (const s of this.store.list()) {
      if (s.agent !== 'codex' || s.parentKey) continue;
      const name = this.names.get(s.sessionId.toLowerCase());
      if (name && name !== s.title) {
        this.store.apply({ kind: 'meta', agent: 'codex', sessionId: s.sessionId, ts: Date.now(), meta: { title: name } });
      }
    }
  }
}
