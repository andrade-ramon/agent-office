/**
 * Mesclagem pura (sem I/O) de hooks em arquivos de configuração no formato
 * usado tanto pelo Claude Code (`settings.json`) quanto pelo Codex (`hooks.json`):
 *
 *   { "hooks": { "<Evento>": [ { "matcher"?: "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
 *
 * Regras:
 *   • nunca sobrescrever o que já existe — só acrescentar um grupo nosso por evento;
 *   • idempotente — instalar duas vezes dá exatamente o mesmo resultado;
 *   • remover só o que é nosso (comandos contendo o marcador) e desfazer
 *     apenas as chaves que nós mesmos criamos.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface HookHandler {
  type: 'command';
  command: string;
  timeout?: number;
  async?: boolean;
}

/** O que a instalação criou — necessário para desfazer com exatidão. */
export interface InstallRecord {
  /** Eventos cuja chave não existia antes de nós. */
  createdEvents: string[];
  /** A chave "hooks" não existia antes de nós. */
  createdHooksKey: boolean;
}

export class HooksConfigError extends Error {}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function clone<T extends Json>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isOurs(handler: Json, marker: string): boolean {
  return isObject(handler) && typeof handler.command === 'string' && handler.command.includes(marker);
}

/**
 * Remove todos os handlers nossos. Grupos que ficarem vazios por causa da
 * remoção são descartados; chaves de evento e a chave "hooks" só são apagadas
 * se constarem no registro de instalação (ou, sem registro, se ficarem vazias
 * por nossa causa).
 */
export function removeHooks(
  config: JsonObject,
  marker: string,
  record?: InstallRecord,
): { config: JsonObject; removed: number } {
  const next = clone(config);
  const hooks = next.hooks;
  if (!isObject(hooks)) return { config: next, removed: 0 };

  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let touched = false;
    const kept: Json[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((h) => !isOurs(h, marker));
      const diff = group.hooks.length - handlers.length;
      if (diff === 0) {
        kept.push(group);
        continue;
      }
      removed += diff;
      touched = true;
      if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
    }
    if (!touched) continue;
    const weCreated = record ? record.createdEvents.includes(event) : true;
    if (kept.length === 0 && weCreated) delete hooks[event];
    else hooks[event] = kept;
  }

  if (removed > 0 && Object.keys(hooks).length === 0) {
    const weCreated = record ? record.createdHooksKey : true;
    if (weCreated) delete next.hooks;
  }
  return { config: next, removed };
}

/**
 * Acrescenta (ou atualiza) nossos handlers. O resultado é sempre:
 * configuração original + um grupo nosso ao final de cada evento.
 */
export function addHooks(
  config: JsonObject,
  handlers: Record<string, HookHandler>,
  marker: string,
  previous?: InstallRecord,
): { config: JsonObject; record: InstallRecord; changed: boolean } {
  for (const [event, handler] of Object.entries(handlers)) {
    if (!handler.command.includes(marker)) {
      throw new HooksConfigError(`comando do evento ${event} não contém o marcador "${marker}"`);
    }
  }
  if ('hooks' in config && !isObject(config.hooks)) {
    throw new HooksConfigError('a chave "hooks" existe mas não é um objeto; nada foi alterado');
  }

  // Parte sempre da configuração "limpa" (sem nada nosso).
  const base = removeHooks(config, marker, previous).config;
  const record: InstallRecord = { createdEvents: [], createdHooksKey: !isObject(base.hooks) };
  const next = clone(base);
  const hooks: JsonObject = isObject(next.hooks) ? next.hooks : {};
  next.hooks = hooks;

  for (const [event, handler] of Object.entries(handlers)) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new HooksConfigError(`hooks.${event} existe mas não é uma lista; nada foi alterado`);
    }
    if (existing === undefined) record.createdEvents.push(event);
    const group: JsonObject = { hooks: [{ ...handler } as unknown as JsonObject] };
    hooks[event] = [...(existing ?? []), group];
  }

  return { config: next, record, changed: !deepEqual(config, next) };
}

/** Quantos eventos da lista têm um handler nosso instalado. */
export function countInstalled(config: unknown, events: string[], marker: string): number {
  if (!isObject(config) || !isObject(config.hooks)) return 0;
  let n = 0;
  for (const event of events) {
    const groups = config.hooks[event];
    if (!Array.isArray(groups)) continue;
    const found = groups.some(
      (g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h, marker)),
    );
    if (found) n++;
  }
  return n;
}

/** Detecta a indentação usada no arquivo original (padrão: 2 espaços). */
export function detectIndent(text: string): string {
  const m = text.match(/\n([ \t]+)"/);
  return m ? m[1]! : '  ';
}

export function serialize(config: JsonObject, originalText?: string): string {
  const indent = originalText ? detectIndent(originalText) : '  ';
  const trailing = originalText === undefined || /\n\s*$/.test(originalText) ? '\n' : '';
  return JSON.stringify(config, null, indent) + trailing;
}
