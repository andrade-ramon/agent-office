import { TIME_MODES, type TimeMode } from './game/daynight';

/** Preferências de interface, guardadas no localStorage. */

export type AgentFilter = 'all' | 'claude' | 'codex';

export interface Prefs {
  agent: AgentFilter;
  /** '' = todos os projetos. */
  project: string;
  compact: boolean;
  labels: boolean;
  /** Legenda das áreas sobre a cena. */
  areas: boolean;
  notify: boolean;
  notifyDone: boolean;
  timeMode: TimeMode;
}

export const DEFAULT_PREFS: Prefs = {
  agent: 'all',
  project: '',
  compact: false,
  labels: true,
  areas: false,
  notify: false,
  notifyDone: false,
  timeMode: 'auto',
};

const KEY = 'agent-office:prefs:v1';

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const data = JSON.parse(raw) as Record<string, unknown>;
    const agent = data.agent === 'claude' || data.agent === 'codex' ? data.agent : 'all';
    const timeMode = TIME_MODES.includes(data.timeMode as TimeMode) ? (data.timeMode as TimeMode) : 'auto';
    return {
      agent,
      project: typeof data.project === 'string' ? data.project : '',
      compact: bool(data.compact, DEFAULT_PREFS.compact),
      labels: bool(data.labels, DEFAULT_PREFS.labels),
      areas: bool(data.areas, DEFAULT_PREFS.areas),
      notify: bool(data.notify, DEFAULT_PREFS.notify),
      notifyDone: bool(data.notifyDone, DEFAULT_PREFS.notifyDone),
      timeMode,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* armazenamento indisponível: segue sem persistir */
  }
}
