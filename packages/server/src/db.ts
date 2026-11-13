import type { NormalizedEvent, SessionState, StatsResponse } from './schema.js';

/** Subconjunto da API de `node:sqlite` que usamos. */
interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  cwd TEXT,
  project TEXT,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  ended_at INTEGER,
  prompts INTEGER NOT NULL DEFAULT 0,
  tools INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  project TEXT,
  event TEXT NOT NULL,
  tool_category TEXT,
  tool_name TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(agent, session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function n(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

/**
 * Persistência leve em SQLite (módulo nativo `node:sqlite`): histórico de
 * eventos e estatísticas. Guarda somente metadados.
 */
export class HistoryDb {
  private readonly insertEvent: Statement;
  private readonly upsert: Statement;

  private constructor(private readonly db: Database) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    this.insertEvent = db.prepare(
      `INSERT INTO events (ts, agent, session_id, parent_session_id, project, event, tool_category, tool_name, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.upsert = db.prepare(
      `INSERT INTO sessions (key, agent, session_id, parent_session_id, cwd, project, started_at, last_activity_at, ended_at, prompts, tools, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         cwd = excluded.cwd,
         project = excluded.project,
         parent_session_id = excluded.parent_session_id,
         started_at = MIN(sessions.started_at, excluded.started_at),
         last_activity_at = excluded.last_activity_at,
         ended_at = excluded.ended_at,
         prompts = excluded.prompts,
         tools = excluded.tools,
         errors = excluded.errors`,
    );
  }

  static async open(path: string): Promise<HistoryDb> {
    // Import dinâmico para que o aviso experimental do node:sqlite possa ser
    // silenciado antes de o módulo carregar (ver index.ts).
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => Database;
    };
    return new HistoryDb(new sqlite.DatabaseSync(path));
  }

  recordEvent(ev: NormalizedEvent): void {
    this.insertEvent.run(
      ev.ts,
      ev.agent,
      ev.sessionId,
      ev.parentSessionId ?? null,
      ev.project,
      ev.event,
      ev.toolCategory,
      ev.toolName ?? null,
      ev.source,
    );
  }

  upsertSession(s: SessionState): void {
    this.upsert.run(
      s.key,
      s.agent,
      s.sessionId,
      s.parentSessionId ?? null,
      s.cwd,
      s.project,
      s.startedAt,
      s.lastActivityAt,
      s.endedAt ?? null,
      s.counts.prompts,
      s.counts.tools,
      s.counts.errors,
    );
  }

  stats(now: number = Date.now()): StatsResponse {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const since = midnight.getTime();

    const byAgent: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT agent, COUNT(*) AS c FROM events WHERE ts >= ? GROUP BY agent').all(since)) {
      byAgent[String(row.agent)] = n(row.c);
    }
    const byCategory: Record<string, number> = {};
    for (const row of this.db
      .prepare(`SELECT tool_category, COUNT(*) AS c FROM events WHERE ts >= ? AND event = 'tool_start' GROUP BY tool_category`)
      .all(since)) {
      byCategory[String(row.tool_category)] = n(row.c);
    }
    const byEvent: Record<string, number> = {};
    let events = 0;
    for (const row of this.db.prepare('SELECT event, COUNT(*) AS c FROM events WHERE ts >= ? GROUP BY event').all(since)) {
      byEvent[String(row.event)] = n(row.c);
      events += n(row.c);
    }
    const sessionsToday = n(
      this.db
        .prepare('SELECT COUNT(*) AS c FROM sessions WHERE last_activity_at >= ? AND parent_session_id IS NULL')
        .get(since)?.c,
    );
    const allEvents = n(this.db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c);
    const allSessions = n(this.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE parent_session_id IS NULL').get()?.c);

    const firstHour = Math.floor((now - 23 * HOUR_MS) / HOUR_MS);
    const buckets = new Map<number, number>();
    for (const row of this.db
      .prepare('SELECT CAST(ts / ? AS INTEGER) AS h, COUNT(*) AS c FROM events WHERE ts >= ? GROUP BY h')
      .all(HOUR_MS, firstHour * HOUR_MS)) {
      buckets.set(n(row.h), n(row.c));
    }
    const hourly: StatsResponse['hourly'] = [];
    for (let h = firstHour; h <= firstHour + 23; h++) {
      hourly.push({ hour: h * HOUR_MS, events: buckets.get(h) ?? 0 });
    }

    return {
      since,
      today: {
        events,
        sessions: sessionsToday,
        prompts: byEvent.prompt ?? 0,
        tools: byEvent.tool_start ?? 0,
        errors: byEvent.error ?? 0,
        byAgent,
        byCategory,
      },
      allTime: { events: allEvents, sessions: allSessions },
      hourly,
    };
  }

  recentEvents(limit = 100): Record<string, unknown>[] {
    const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
    return this.db
      .prepare(
        'SELECT ts, agent, session_id AS sessionId, project, event, tool_category AS toolCategory, tool_name AS toolName, source FROM events ORDER BY id DESC LIMIT ?',
      )
      .all(capped);
  }

  /** Remove eventos e sessões antigos. */
  prune(now: number = Date.now(), keepDays = 30): void {
    const cutoff = now - keepDays * DAY_MS;
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM sessions WHERE last_activity_at < ?').run(cutoff);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* já fechado */
    }
  }
}
