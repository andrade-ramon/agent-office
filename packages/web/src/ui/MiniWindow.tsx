import { useEffect, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { SessionStatus } from '@agent-office/server/schema';
import type { TimeMode } from '../game/daynight';
import { miniSize, resizeMiniWindow, type MiniSize } from '../pip';
import type { ConnState, OfficeStore } from '../store';
import { Icon } from './Icon';
import { OfficeCanvas } from './OfficeCanvas';

interface Props {
  /** A janela flutuante, já aberta. */
  win: Window & typeof globalThis;
  store: OfficeStore;
  conn: ConnState;
  /** Sessões presentes no escritório. */
  total: number;
  counts: Record<SessionStatus, number>;
  /** Quantas esperam por você. */
  attention: number;
  duck: boolean;
  timeMode: TimeMode;
  selectedKey: string | null;
  /** Clique em um personagem: seleciona na janela principal. */
  onSelect(key: string): void;
  onActivate(key: string): void;
  /** Clique no aviso de "aguardando você". */
  onAttention(): void;
  onClose(): void;
}

const SIZES: { id: MiniSize; label: string; title: string }[] = [
  { id: 'p', label: 'P', title: 'Pequeno' },
  { id: 'm', label: 'M', title: 'Médio' },
  { id: 'g', label: 'G', title: 'Grande' },
];

const noop = (): void => undefined;

/**
 * O mini mapa: o escritório inteiro em uma janela flutuante, com uma barra de
 * status embaixo. É desenhado a partir da árvore da janela principal (portal),
 * então compartilha o mesmo estado; só a cena é outra, com o ritmo da janela
 * flutuante.
 */
export function MiniWindow(p: Props): ReactElement {
  const { win, onClose } = p;

  // Esc ou M dentro da janela flutuante: fecha.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' || e.key.toLowerCase() === 'm') onClose();
    };
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  }, [win, onClose]);

  const working = p.counts.working + p.counts.thinking;
  return createPortal(
    <div className={`mini-root ${p.attention > 0 ? 'attention' : ''}`}>
      <div className="mini-map">
        <OfficeCanvas
          store={p.store}
          view={win}
          selectedKey={p.selectedKey}
          agent="all"
          project=""
          labels={false}
          areas={false}
          duck={p.duck}
          timeMode={p.timeMode}
          insetRight={0}
          onSelect={(key) => {
            if (key) p.onSelect(key);
          }}
          onActivate={p.onActivate}
          onCamera={noop}
          onReady={noop}
        />
      </div>
      <div className="mini-bar">
        <i className={`conn-dot conn-${p.conn}`} title={p.conn === 'open' ? 'Conectado' : 'Reconectando…'} />
        {p.attention > 0 ? (
          <button type="button" className="mini-attention" onClick={p.onAttention} title="Ir para quem está esperando">
            <Icon name="question" size={9} />
            <b>{p.attention}</b> aguardando você
          </button>
        ) : (
          <span className="mini-counts">
            <b>{p.total}</b> {p.total === 1 ? 'sessão' : 'sessões'}
            {working > 0 && (
              <>
                {' · '}
                <b>{working}</b> trabalhando
              </>
            )}
          </span>
        )}
        <span className="mini-tools">
          {SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              className="mini-size"
              onClick={() => resizeMiniWindow(win, miniSize(s.id))}
              title={`Tamanho: ${s.title} (ou arraste a borda da janela)`}
            >
              {s.label}
            </button>
          ))}
          <button type="button" className="mini-size" onClick={onClose} title="Ocultar o mini mapa (Esc)" aria-label="Ocultar o mini mapa">
            <Icon name="close" size={9} />
          </button>
        </span>
      </div>
    </div>,
    win.document.body,
  );
}
