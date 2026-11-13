import type { ReactElement } from 'react';
import type { SessionStatus, StatsResponse } from '@agent-office/server/schema';
import { STATUS_COUNT_LABEL, STATUS_ORDER, formatNumber, plural } from '../i18n';
import type { ConnState } from '../store';
import { Icon } from './Icon';

interface Props {
  conn: ConnState;
  ready: boolean;
  demo: boolean;
  version: string | null;
  counts: Record<SessionStatus, number>;
  total: number;
  attention: number;
  stats: StatsResponse | null;
  labels: boolean;
  notify: boolean;
  /** Notifica também quando um turno termina. */
  notifyDone: boolean;
  fullscreen: boolean;
  onAttention(): void;
  onToggleLabels(): void;
  onToggleNotify(): void;
  onCompact(): void;
  onFullscreen(): void;
}

export function connLabel(conn: ConnState, ready: boolean): string {
  if (conn === 'open') return 'Conectado';
  if (conn === 'connecting' && !ready) return 'Conectando…';
  return 'Reconectando…';
}

export function Header(p: Props): ReactElement {
  const today = p.stats?.today;
  return (
    <header className="topbar">
      <div className="brand" title={p.version ? `agent-office v${p.version}` : 'agent-office'}>
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="brand-name">agent-office</span>
      </div>

      <span className={`pill conn conn-${p.conn}`} role="status">
        <i className="conn-dot" />
        {connLabel(p.conn, p.ready)}
      </span>
      {p.demo && <span className="pill demo">MODO DEMO</span>}
      {p.attention > 0 && (
        <button type="button" className="pill attention" onClick={p.onAttention} title="Ir para quem está esperando">
          <Icon name="question" size={10} />
          <b>{p.attention}</b>
          <span className="attention-text">aguardando você</span>
        </button>
      )}

      <div className="counts" aria-label="Sessões por status">
        <span className="count total" title="Sessões no escritório">
          <b>{p.total}</b>
          <span className="count-label">{p.total === 1 ? 'sessão' : 'sessões'}</span>
        </span>
        {STATUS_ORDER.filter((s) => s !== 'ended' && p.counts[s] > 0).map((s) => (
          <span key={s} className={`count count-${s}`} title={`${p.counts[s]} ${STATUS_COUNT_LABEL[s]}`}>
            <i className="chip-dot" />
            <b>{p.counts[s]}</b>
            <span className="count-label">{STATUS_COUNT_LABEL[s]}</span>
          </span>
        ))}
      </div>

      {today && (
        <div className="today" title="Estatísticas de hoje">
          <span className="today-title">hoje</span>
          <span>{plural(today.sessions, 'sessão', 'sessões')}</span>
          <span>{plural(today.prompts, 'prompt', 'prompts')}</span>
          <span>{formatNumber(today.tools)} ferram.</span>
          <span className={today.errors > 0 ? 'today-errors' : ''}>{plural(today.errors, 'erro', 'erros')}</span>
        </div>
      )}

      <div className="toolbar">
        <button
          type="button"
          className={`tool ${p.labels ? 'on' : ''}`}
          onClick={p.onToggleLabels}
          title="Mostrar nomes (L)"
          aria-pressed={p.labels}
        >
          <Icon name="tag" />
        </button>
        <button
          type="button"
          className={`tool ${p.notify ? 'on' : ''}`}
          onClick={p.onToggleNotify}
          title={
            !p.notify
              ? 'Notificações: desligadas'
              : p.notifyDone
                ? 'Notificações: quando precisarem de você e ao concluir'
                : 'Notificações: quando precisarem de você'
          }
          aria-pressed={p.notify}
        >
          <Icon name="bell" />
          {p.notifyDone && <Icon name="check" size={8} className="tool-badge" />}
        </button>
        <button type="button" className="tool" onClick={p.onCompact} title="Modo compacto (C)">
          <Icon name="compact" />
        </button>
        <button
          type="button"
          className={`tool ${p.fullscreen ? 'on' : ''}`}
          onClick={p.onFullscreen}
          title="Tela cheia (F)"
          aria-pressed={p.fullscreen}
        >
          <Icon name="expand" />
        </button>
      </div>
    </header>
  );
}
