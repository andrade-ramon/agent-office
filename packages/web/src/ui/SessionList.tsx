import { useEffect, useRef, type ReactElement } from 'react';
import { needsAttention, type SessionState } from '@agent-office/server/schema';
import { AGENT_LABEL, describeActivity, formatDuration, shortActivity } from '../i18n';
import type { ListRow, ProjectCount } from '../model';
import type { AgentFilter } from '../prefs';
import { Avatar, StatusChip } from './bits';

interface Props {
  rows: ListRow[];
  total: number;
  agent: AgentFilter;
  project: string;
  projects: ProjectCount[];
  agentCounts: { claude: number; codex: number };
  selectedKey: string | null;
  now: number;
  onAgent(agent: AgentFilter): void;
  onProject(project: string): void;
  onSelect(key: string): void;
  onActivate(key: string): void;
}

function Row({
  row,
  selected,
  now,
  onSelect,
  onActivate,
}: {
  row: ListRow;
  selected: boolean;
  now: number;
  onSelect(key: string): void;
  onActivate(key: string): void;
}): ReactElement {
  const s: SessionState = row.session;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const attention = needsAttention(s.status);
  const cls = [
    'row',
    `row-${s.agent}`,
    row.depth === 1 ? 'row-child' : '',
    selected ? 'selected' : '',
    attention ? 'attention' : '',
    s.status === 'ended' ? 'ended' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li ref={ref} className={cls}>
      <button
        type="button"
        className="row-button"
        onClick={() => onSelect(s.key)}
        onDoubleClick={() => onActivate(s.key)}
        title={`${s.label} — ${AGENT_LABEL[s.agent]} · ${s.project}${s.title ? `\n${s.title}` : ''}\n${describeActivity(s)}\nDuplo clique: trazer a janela para a frente`}
      >
        <Avatar session={s} size={row.depth === 1 ? 24 : 32} />
        <span className="row-main">
          <span className="row-title">
            <span className="row-name">{s.label}</span>
            <span className="row-project">{s.project}</span>
          </span>
          {s.title && <span className="row-subject">{s.title}</span>}
          <span className="row-sub">
            <StatusChip status={s.status} />
            <span className="row-what">{shortActivity(s)}</span>
          </span>
        </span>
        <span className="row-time">{formatDuration(now - s.statusSince)}</span>
      </button>
    </li>
  );
}

export function SessionList(p: Props): ReactElement {
  const knownProject = !p.project || p.projects.some((x) => x.project === p.project);
  const filtered = p.agent !== 'all' || Boolean(p.project);
  return (
    <aside className="sidebar" aria-label="Sessões">
      <div className="filters">
        <div className="seg" role="group" aria-label="Filtrar por agente">
          <button type="button" className={p.agent === 'all' ? 'on' : ''} onClick={() => p.onAgent('all')}>
            Todos
          </button>
          <button
            type="button"
            className={`seg-claude ${p.agent === 'claude' ? 'on' : ''}`}
            onClick={() => p.onAgent(p.agent === 'claude' ? 'all' : 'claude')}
          >
            Claude <b>{p.agentCounts.claude}</b>
          </button>
          <button
            type="button"
            className={`seg-codex ${p.agent === 'codex' ? 'on' : ''}`}
            onClick={() => p.onAgent(p.agent === 'codex' ? 'all' : 'codex')}
          >
            Codex <b>{p.agentCounts.codex}</b>
          </button>
        </div>
        <select
          className="select"
          value={p.project}
          onChange={(e) => p.onProject(e.target.value)}
          aria-label="Filtrar por projeto"
        >
          <option value="">Todos os projetos</option>
          {!knownProject && <option value={p.project}>{p.project} (0)</option>}
          {p.projects.map((x) => (
            <option key={x.project} value={x.project}>
              {x.project} ({x.count})
            </option>
          ))}
        </select>
      </div>

      <div className="list-head">
        <span>Sessões</span>
        <span>
          {filtered ? `${p.rows.length} de ${p.total}` : p.total}
          {filtered && (
            <button
              type="button"
              className="link"
              onClick={() => {
                p.onAgent('all');
                p.onProject('');
              }}
            >
              limpar
            </button>
          )}
        </span>
      </div>

      {p.rows.length === 0 ? (
        <p className="list-empty">
          {p.total === 0 ? 'Nenhuma sessão no momento.' : 'Nenhuma sessão com esses filtros.'}
        </p>
      ) : (
        <ul className="list">
          {p.rows.map((row) => (
            <Row
              key={row.session.key}
              row={row}
              selected={row.session.key === p.selectedKey}
              now={p.now}
              onSelect={p.onSelect}
              onActivate={p.onActivate}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
