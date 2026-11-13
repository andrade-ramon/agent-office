import type { ReactElement, ReactNode } from 'react';
import type { EventSource, SessionState } from '@agent-office/server/schema';
import {
  AGENT_LABEL,
  CATEGORY_ICON,
  CATEGORY_LABEL,
  EVENT_LABEL,
  describeActivity,
  formatAgo,
  formatClock,
  formatDuration,
  formatNumber,
  formatTokens,
  sourceLabel,
} from '../i18n';
import { Avatar, StatusChip } from './bits';
import { Icon } from './Icon';

interface Props {
  session: SessionState;
  parent: SessionState | null;
  subagents: SessionState[];
  demo: boolean;
  now: number;
  following: boolean;
  onClose(): void;
  onSelect(key: string): void;
  onFocusCamera(): void;
  onFocusWindow(): void;
}

const SOURCE_TAG: Record<EventSource, string> = {
  hook: 'hook',
  watcher: 'arquivo',
  demo: 'demo',
  system: 'sistema',
};

function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }): ReactElement {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </div>
  );
}

function PersonLink({ session, onSelect }: { session: SessionState; onSelect(key: string): void }): ReactElement {
  return (
    <button type="button" className="person" onClick={() => onSelect(session.key)}>
      <Avatar session={session} size={24} />
      <span className="person-name">{session.label}</span>
      <StatusChip status={session.status} />
    </button>
  );
}

export function DetailPanel(p: Props): ReactElement {
  const s = p.session;
  const end = s.status === 'ended' && s.endedAt ? s.endedAt : p.now;
  const ctx = s.context;
  const pct = ctx ? Math.round(ctx.pct * 100) : 0;
  const timeline = [...s.timeline].reverse();

  return (
    <aside className={`detail detail-${s.agent}`} aria-label={`Detalhes de ${s.label}`}>
      <header className="detail-head">
        <Avatar session={s} size={48} />
        <div className="detail-title">
          <h2>{s.label}</h2>
          <div className="detail-tags">
            <span className={`agent-tag agent-${s.agent}`}>{AGENT_LABEL[s.agent]}</span>
            {s.parentKey && <span className="agent-tag sub">subagente</span>}
          </div>
        </div>
        <button type="button" className="tool" onClick={p.onClose} title="Fechar (Esc)" aria-label="Fechar">
          <Icon name="close" />
        </button>
      </header>

      <div className="detail-status">
        <StatusChip status={s.status} />
        <span className="muted">{formatAgo(p.now - s.statusSince)}</span>
      </div>
      <p className="detail-activity">{describeActivity(s)}</p>

      <div className="detail-actions">
        <button type="button" className={`btn ${p.following ? 'on' : ''}`} onClick={p.onFocusCamera}>
          <Icon name="target" size={12} />
          Focar
        </button>
        <button type="button" className="btn" onClick={p.onFocusWindow} title="Traz o terminal ou app da sessão para a frente">
          <Icon name="window" size={12} />
          Abrir janela
        </button>
      </div>

      <div className="detail-scroll">
        <dl className="fields">
          <Field label="Projeto">{s.project || '—'}</Field>
          <Field label="Diretório" mono>
            <span className="path" title={s.cwd}>
              <bdi>{s.cwd || '—'}</bdi>
            </span>
          </Field>
          <Field label="Ferramenta">
            {s.toolName || s.toolCategory ? (
              <span className="tool-now">
                {s.toolCategory && <Icon name={CATEGORY_ICON[s.toolCategory]} size={11} />}
                <b>{s.toolName ?? '—'}</b>
                {s.toolCategory && <span className="muted">{CATEGORY_LABEL[s.toolCategory]}</span>}
              </span>
            ) : (
              '—'
            )}
          </Field>
          <Field label="Modelo">{s.model ?? '—'}</Field>
          <Field label="Origem">{s.entrypoint ?? '—'}</Field>
          <Field label="Fonte">{sourceLabel(s, p.demo)}</Field>
          {s.agentType && <Field label="Tipo">{s.agentType}</Field>}
          {s.pid !== undefined && <Field label="PID">{s.pid}</Field>}
          <Field label="Tempo ativo">{formatDuration(end - s.startedAt)}</Field>
          <Field label="Neste status">{formatDuration(end - s.statusSince)}</Field>
        </dl>

        <section className="block">
          <h3>
            Contexto
            {ctx && (
              <span className="muted">
                {formatTokens(ctx.tokens)} / {formatTokens(ctx.window)} tokens
              </span>
            )}
          </h3>
          {ctx ? (
            <div
              className={`meter ${pct >= 85 ? 'high' : pct >= 60 ? 'mid' : ''}`}
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <i style={{ width: `${Math.max(2, pct)}%` }} />
              <span>{pct}%</span>
            </div>
          ) : (
            <p className="muted small">Sem informação de contexto.</p>
          )}
        </section>

        <section className="block counters">
          <div>
            <b>{formatNumber(s.counts.prompts)}</b>
            <span>prompts</span>
          </div>
          <div>
            <b>{formatNumber(s.counts.tools)}</b>
            <span>ferram.</span>
          </div>
          <div className={s.counts.errors > 0 ? 'bad' : ''}>
            <b>{formatNumber(s.counts.errors)}</b>
            <span>erros</span>
          </div>
          <div>
            <b>{formatNumber(s.subagents)}</b>
            <span>subag.</span>
          </div>
        </section>

        {p.parent && (
          <section className="block">
            <h3>Sessão principal</h3>
            <PersonLink session={p.parent} onSelect={p.onSelect} />
          </section>
        )}

        {p.subagents.length > 0 && (
          <section className="block">
            <h3>Subagentes</h3>
            <div className="people">
              {p.subagents.map((c) => (
                <PersonLink key={c.key} session={c} onSelect={p.onSelect} />
              ))}
            </div>
          </section>
        )}

        <section className="block">
          <h3>Linha do tempo</h3>
          {timeline.length === 0 ? (
            <p className="muted small">Nenhum evento ainda.</p>
          ) : (
            <ol className="timeline">
              {timeline.map((e, i) => (
                <li key={`${e.ts}-${i}`} className={`tl tl-${e.event}`}>
                  <span className="tl-time" title={formatClock(e.ts)}>
                    {formatAgo(p.now - e.ts)}
                  </span>
                  <span className="tl-text">
                    {EVENT_LABEL[e.event]}
                    {e.toolName && <b> {e.toolName}</b>}
                  </span>
                  <span className="tl-src">{SOURCE_TAG[e.source]}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </aside>
  );
}
