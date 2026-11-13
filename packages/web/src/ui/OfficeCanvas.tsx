import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { SessionState } from '@agent-office/server/schema';
import type { TimeMode } from '../game/daynight';
import { OfficeScene, type CameraInfo } from '../game/scene';
import { matchesFilter } from '../model';
import type { AgentFilter } from '../prefs';
import type { OfficeStore } from '../store';

interface Props {
  store: OfficeStore;
  selectedKey: string | null;
  agent: AgentFilter;
  project: string;
  labels: boolean;
  areas: boolean;
  timeMode: TimeMode;
  /** Largura (px) coberta pelo painel de detalhes, à direita. */
  insetRight: number;
  onSelect(key: string | null): void;
  onActivate(key: string): void;
  onCamera(info: CameraInfo): void;
  onReady(scene: OfficeScene | null): void;
}

declare global {
  interface Window {
    /** Alça de depuração para verificação automatizada. */
    __office?: Record<string, unknown>;
  }
}

/** Monta a cena Pixi e a mantém em sincronia com o estado do app. */
export function OfficeCanvas(props: Props): ReactElement {
  const { store, selectedKey, agent, project, labels, areas, timeMode, insetRight } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let scene: OfficeScene | null = null;
    let off: (() => void) | null = null;

    OfficeScene.create(host, {
      onSelect: (key) => callbacks.current.onSelect(key),
      onActivate: (key) => callbacks.current.onActivate(key),
      onCamera: (info) => callbacks.current.onCamera(info),
    })
      .then((created) => {
        if (cancelled) {
          created.destroy();
          return;
        }
        scene = created;
        sceneRef.current = created;
        created.reset(store.getState().sessions.values());
        off = store.on({
          hello: (sessions: SessionState[]) => created.reset(sessions),
          session: (session) => created.upsert(session),
          remove: (key) => created.remove(key),
          event: (key, event) => created.event(key, event),
        });
        window.__office = {
          ...created.debugHandle(),
          state: () => {
            const s = store.getState();
            return {
              conn: s.conn,
              ready: s.ready,
              demo: s.demo,
              version: s.version,
              reconnects: s.reconnects,
              sessions: s.sessions.size,
            };
          },
          sessions: () => [...store.getState().sessions.values()],
        };
        setReady(true);
        callbacks.current.onReady(created);
      })
      .catch((err: unknown) => {
        console.error('[agent-office] falha ao iniciar a cena', err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      off?.();
      if (scene) {
        callbacks.current.onReady(null);
        scene.destroy();
      }
      sceneRef.current = null;
      delete window.__office;
      setReady(false);
    };
  }, [store]);

  useEffect(() => {
    sceneRef.current?.setSelected(selectedKey);
  }, [selectedKey, ready]);

  useEffect(() => {
    const all = agent === 'all' && !project;
    sceneRef.current?.setFilter(all ? null : (s) => matchesFilter(s, agent, project));
  }, [agent, project, ready]);

  useEffect(() => {
    sceneRef.current?.setShowLabels(labels);
  }, [labels, ready]);

  useEffect(() => {
    sceneRef.current?.setShowAreas(areas);
  }, [areas, ready]);

  useEffect(() => {
    sceneRef.current?.setTimeMode(timeMode);
  }, [timeMode, ready]);

  useEffect(() => {
    sceneRef.current?.setInsets({ right: insetRight });
  }, [insetRight, ready]);

  return (
    <div className="canvas-host" ref={hostRef}>
      {error && (
        <div className="canvas-error">
          <strong>Não foi possível iniciar a cena.</strong>
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
