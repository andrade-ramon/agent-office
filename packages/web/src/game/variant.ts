import type { AgentKind } from '@agent-office/server/schema';

/** Hash FNV-1a de 32 bits (determinístico, sem dependências). */
export function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Mistura final para espalhar chaves parecidas.
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** Claude: tons quentes. */
export const CLAUDE_BODIES = [
  '#d97757',
  '#e8923c',
  '#c9603f',
  '#e3a33a',
  '#d6705f',
  '#b9703f',
  '#ef8a52',
  '#cc7a86',
] as const;

/** Codex: tons frios. */
export const CODEX_BODIES = [
  '#2fa58e',
  '#3f9fd0',
  '#3f8f6d',
  '#5b86e0',
  '#52bfb2',
  '#4c7f9c',
  '#63a852',
  '#7a7fd6',
] as const;

/** Cor de destaque (crista / visor / etiqueta) — compartilhada entre pai e subagentes. */
export const ACCENTS = [
  '#ffd166',
  '#6fe3ff',
  '#ff8fb1',
  '#b4f05a',
  '#f4f1e8',
  '#b79cff',
  '#ffb347',
  '#ff7b6b',
  '#5ff0c8',
  '#7fb2ff',
] as const;

export const SKINS = ['#f6dcc0', '#eec39a', '#d9a070', '#b97a50'] as const;

export interface Variant {
  agent: AgentKind;
  /** Subagente: sprite menor. */
  small: boolean;
  body: number;
  accent: number;
  skin: number;
  /** Estilo da crista (Claude) ou da antena (Codex): 0–2. */
  style: number;
  /** Chave de cache do sprite sheet. */
  id: string;
}

/**
 * Aparência determinística a partir da chave da sessão. Subagentes herdam as
 * cores do pai (corpo e destaque) para ficarem visualmente ligados a ele.
 */
export function variantFor(key: string, agent: AgentKind, parentKey?: string): Variant {
  const own = hash32(key);
  const family = parentKey ? hash32(parentKey) : own;
  const bodies = agent === 'claude' ? CLAUDE_BODIES : CODEX_BODIES;
  const body = family % bodies.length;
  const accent = (family >>> 8) % ACCENTS.length;
  const skin = (own >>> 16) % SKINS.length;
  const style = (own >>> 20) % 3;
  const small = Boolean(parentKey);
  return {
    agent,
    small,
    body,
    accent,
    skin,
    style,
    id: `${agent}-${small ? 's' : 'l'}-${body}-${accent}-${skin}-${style}`,
  };
}

export function bodyColor(v: Variant): string {
  return (v.agent === 'claude' ? CLAUDE_BODIES : CODEX_BODIES)[v.body]!;
}

export function accentColor(v: Variant): string {
  return ACCENTS[v.accent]!;
}

export function skinColor(v: Variant): string {
  return SKINS[v.skin]!;
}

/** "#rrggbb" → 0xrrggbb. */
export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}
