export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * Nome do projeto a partir do cwd. Worktrees de agentes são atribuídos ao
 * repositório de origem:
 *   /repo/.claude/worktrees/feat-x        → repo
 *   ~/.codex/worktrees/84dd/meu-projeto   → meu-projeto
 */
export function projectFromCwd(cwd: string | undefined): string {
  if (!cwd) return 'desconhecido';
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm) return '/';
  const wt = norm.match(/^(.*)\/\.(?:claude|codex|cursor)\/worktrees\/[^/]+(?:\/(.+))?$/);
  if (wt) {
    const before = wt[1] ?? '';
    const after = wt[2];
    if (after) return lastSegment(after);
    const repo = lastSegment(before);
    if (repo) return repo;
  }
  return lastSegment(norm) || '/';
}

/** Normaliza um título curto: uma linha, sem espaços repetidos, tamanho limitado. */
export function cleanTitle(v: unknown, max = 90): string | undefined {
  if (typeof v !== 'string') return undefined;
  const text = v.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** `implement_app_p0p1` → `implement app p0p1` */
export function humanizeSlug(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const last = v.split('/').filter(Boolean).pop();
  return last ? cleanTitle(last.replace(/[_-]+/g, ' ')) : undefined;
}

/** FNV-1a de 32 bits: hash estável para escolher nomes/cores. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function parseTs(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}
