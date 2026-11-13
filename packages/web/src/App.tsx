import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { SessionState } from '@agent-office/server/schema';
import type { TimeMode } from './game/daynight';
import type { CameraInfo, OfficeScene } from './game/scene';
import { attentionList, buildRows, countByStatus, matchesFilter, projectCounts } from './model';
import {
  notificationsGranted,
  requestNotifications,
  setFavicon,
  setTitle,
  showNotification,
} from './notify';
import { DETAIL_WIDTH, loadPrefs, savePrefs, SIDEBAR_WIDTH, type AgentFilter, type Prefs } from './prefs';
import { Resizer } from './ui/Resizer';
import type { OfficeStore } from './store';
import { DetailPanel } from './ui/DetailPanel';
import { Header, connLabel } from './ui/Header';
import { Hud } from './ui/Hud';
import { Icon } from './ui/Icon';
import { OfficeCanvas } from './ui/OfficeCanvas';
import { SessionList } from './ui/SessionList';
import { useNow } from './ui/bits';

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'warn';
}

let toastSeq = 0;

export function App({ store }: { store: OfficeStore }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fullscreen, setFullscreen] = useState<boolean>(() => Boolean(document.fullscreenElement));
  const sceneRef = useRef<OfficeScene | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const now = useNow(1000) + state.clockOffset;

  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastSeq;
    setToasts((list) => [...list.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4200);
  }, []);

  // ───────────── dados derivados ─────────────
  const sessions = state.sessions;
  const all = useMemo(() => [...sessions.values()], [sessions]);
  /** Sessões presentes no escritório (as encerradas somem em instantes). */
  const alive = useMemo(() => all.filter((s) => s.status !== 'ended'), [all]);
  /** Na lista: as vivas e as principais recém-encerradas (subagentes encerrados só poluem). */
  const listed = useMemo(() => all.filter((s) => s.status !== 'ended' || !s.parentKey), [all]);
  const visible = useCallback(
    (s: SessionState) => matchesFilter(s, prefs.agent, prefs.project),
    [prefs.agent, prefs.project],
  );
  const rows = useMemo(() => buildRows(listed, visible), [listed, visible]);
  const counts = useMemo(() => countByStatus(all), [all]);
  const attention = useMemo(() => attentionList(all), [all]);
  const projects = useMemo(() => projectCounts(listed), [listed]);
  const agentCounts = useMemo(() => {
    let claude = 0;
    let codex = 0;
    for (const s of listed) {
      if (s.agent === 'claude') claude++;
      else codex++;
    }
    return { claude, codex };
  }, [listed]);

  const selected = selectedKey ? (sessions.get(selectedKey) ?? null) : null;
  const parent = selected?.parentKey ? (sessions.get(selected.parentKey) ?? null) : null;
  const subagents = useMemo(
    () => (selected ? alive.filter((s) => s.parentKey === selected.key).sort((a, b) => a.startedAt - b.startedAt) : []),
    [alive, selected],
  );

  // A sessão selecionada foi removida pelo servidor.
  useEffect(() => {
    if (selectedKey && state.ready && !sessions.has(selectedKey)) setSelectedKey(null);
  }, [selectedKey, sessions, state.ready]);

  // ───────────── ações ─────────────
  const focusWindow = useCallback(
    (key: string) => {
      void store.focusWindow(key).then((res) => toast(res.detail, res.ok ? 'ok' : 'warn'));
    },
    [store, toast],
  );

  const selectAndFocus = useCallback((key: string) => {
    setSelectedKey(key);
    sceneRef.current?.focusOn(key);
  }, []);

  const activate = useCallback(
    (key: string) => {
      setSelectedKey(key);
      focusWindow(key);
    },
    [focusWindow],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      document.documentElement.requestFullscreen().catch(() => toast('Tela cheia indisponível neste navegador.', 'warn'));
    }
  }, [toast]);

  const cycleNotify = useCallback(async () => {
    const p = prefsRef.current;
    if (p.notify && p.notifyDone) {
      update({ notify: false, notifyDone: false });
      toast('Notificações desligadas.');
      return;
    }
    if (p.notify && notificationsGranted()) {
      update({ notifyDone: true });
      toast('Notificações: também quando um turno terminar.', 'ok');
      return;
    }
    const result = await requestNotifications();
    if (result === 'granted') {
      update({ notify: true, notifyDone: false });
      toast('Notificações ligadas: avisaremos quando um agente precisar de você.', 'ok');
    } else if (result === 'denied') {
      update({ notify: false, notifyDone: false });
      toast('Notificações bloqueadas. Libere-as nas configurações do navegador.', 'warn');
    } else {
      toast('Este navegador não oferece notificações.', 'warn');
    }
  }, [toast, update]);

  // ───────────── efeitos globais ─────────────
  useEffect(() => {
    return store.on({
      attention: (session, kind) => {
        const p = prefsRef.current;
        if (!p.notify) return;
        if (kind === 'done' && !p.notifyDone) return;
        if (!document.hidden && document.hasFocus()) return;
        showNotification(session, kind, () => {
          setSelectedKey(session.key);
          sceneRef.current?.focusOn(session.key);
        });
      },
    });
  }, [store]);

  useEffect(() => {
    setTitle(attention.length);
    setFavicon(attention.length > 0);
  }, [attention.length]);

  useEffect(() => {
    const onChange = (): void => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      const p = prefsRef.current;
      switch (e.key.toLowerCase()) {
        case 'escape':
          setSelectedKey(null);
          break;
        case 'c':
          update({ compact: !p.compact });
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'l':
          update({ labels: !p.labels });
          break;
        case 'a':
          update({ areas: !p.areas });
          break;
        case '0':
          sceneRef.current?.fit();
          break;
        case '+':
        case '=':
          sceneRef.current?.zoomBy(1);
          break;
        case '-':
        case '_':
          sceneRef.current?.zoomBy(-1);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFullscreen, update]);

  const onReady = useCallback((scene: OfficeScene | null) => {
    sceneRef.current = scene;
  }, []);

  const notifyOn = prefs.notify && notificationsGranted();
  const empty = state.ready && alive.length === 0;
  const offline = state.conn !== 'open';
  const firstAttention = attention[0];
  const goAttention = useCallback(() => {
    if (firstAttention) selectAndFocus(firstAttention.key);
  }, [firstAttention, selectAndFocus]);

  return (
    <div
      className={`app ${prefs.compact ? 'compact' : ''}`}
      style={{ '--sidebar-w': `${prefs.sidebarWidth}px`, '--detail-w': `${prefs.detailWidth}px` } as CSSProperties}
    >
      {!prefs.compact && (
        <Header
          conn={state.conn}
          ready={state.ready}
          demo={state.demo}
          version={state.version}
          counts={counts}
          total={alive.length}
          attention={attention.length}
          stats={state.stats}
          labels={prefs.labels}
          notify={notifyOn}
          notifyDone={notifyOn && prefs.notifyDone}
          fullscreen={fullscreen}
          onAttention={goAttention}
          onToggleLabels={() => update({ labels: !prefs.labels })}
          onToggleNotify={() => void cycleNotify()}
          onCompact={() => update({ compact: true })}
          onFullscreen={toggleFullscreen}
        />
      )}

      <div className="main">
        {!prefs.compact && (
          <SessionList
            rows={rows}
            total={listed.length}
            agent={prefs.agent}
            project={prefs.project}
            projects={projects}
            agentCounts={agentCounts}
            selectedKey={selectedKey}
            now={now}
            onAgent={(agent: AgentFilter) => update({ agent })}
            onProject={(project: string) => update({ project })}
            onSelect={selectAndFocus}
            onActivate={activate}
          />
        )}
        {!prefs.compact && (
          <Resizer
            edge="right"
            className="resizer-sidebar"
            label="Largura da lista de sessões"
            width={prefs.sidebarWidth}
            min={SIDEBAR_WIDTH.min}
            max={SIDEBAR_WIDTH.max}
            defaultWidth={SIDEBAR_WIDTH.default}
            onResize={(sidebarWidth) => update({ sidebarWidth })}
          />
        )}

        <main className={selected ? 'stage has-detail' : 'stage'}>
          <OfficeCanvas
            store={store}
            selectedKey={selectedKey}
            agent={prefs.agent}
            project={prefs.project}
            labels={prefs.labels}
            areas={prefs.areas}
            timeMode={prefs.timeMode}
            insetRight={selected ? prefs.detailWidth : 0}
            onSelect={setSelectedKey}
            onActivate={activate}
            onCamera={setCamera}
            onReady={onReady}
          />

          {prefs.compact && (
            <div className="mini">
              <i className={`conn-dot conn-${state.conn}`} title={connLabel(state.conn, state.ready)} />
              <span className="mini-name">agent-office</span>
              {state.demo && <span className="pill demo">DEMO</span>}
              {attention.length > 0 && (
                <button type="button" className="pill attention" onClick={goAttention} title="Ir para quem está esperando">
                  <Icon name="question" size={10} />
                  <b>{attention.length}</b>
                </button>
              )}
              <span className="muted">
                {alive.length} {alive.length === 1 ? 'sessão' : 'sessões'}
              </span>
              <button
                type="button"
                className="tool on"
                onClick={() => update({ compact: false })}
                title="Sair do modo compacto (C)"
              >
                <Icon name="compact" size={12} />
              </button>
              <button
                type="button"
                className={`tool ${fullscreen ? 'on' : ''}`}
                onClick={toggleFullscreen}
                title="Tela cheia (F)"
              >
                <Icon name="expand" size={12} />
              </button>
            </div>
          )}

          {offline && state.ready && (
            <div className="banner" role="status">
              <i className="conn-dot conn-reconnecting" />
              Sem conexão com o servidor — tentando reconectar…
            </div>
          )}

          {!state.ready && (
            <div className="empty">
              <h2>{state.conn === 'connecting' ? 'Conectando ao servidor…' : 'Servidor fora do ar'}</h2>
              <p>
                {state.conn === 'connecting'
                  ? 'Abrindo o escritório.'
                  : 'Tentando reconectar automaticamente. Verifique se o agent-office está rodando.'}
              </p>
            </div>
          )}

          {empty && (
            <div className="empty">
              <h2>O escritório está vazio</h2>
              <p>Nenhuma sessão do Claude Code ou do Codex em andamento.</p>
              <p>Para conectar seus agentes, rode no terminal:</p>
              <code>agent-office connect</code>
              <p className="muted">Assim que uma sessão começar, ela entra pela porta.</p>
            </div>
          )}

          <Hud
            camera={camera}
            timeMode={prefs.timeMode}
            areas={prefs.areas}
            labels={prefs.labels}
            hasSelection={Boolean(selected)}
            onZoom={(steps) => sceneRef.current?.zoomBy(steps)}
            onFit={() => sceneRef.current?.fit()}
            onFocus={() => {
              if (selectedKey) sceneRef.current?.focusOn(selectedKey);
            }}
            onTimeMode={(timeMode: TimeMode) => update({ timeMode })}
            onToggleAreas={() => update({ areas: !prefs.areas })}
            onToggleLabels={() => update({ labels: !prefs.labels })}
          />

          {selected && (
            <DetailPanel
              session={selected}
              parent={parent}
              subagents={subagents}
              demo={state.demo}
              now={now}
              following={camera?.mode === 'follow' && camera.followKey === selected.key}
              onClose={() => setSelectedKey(null)}
              onSelect={selectAndFocus}
              onFocusCamera={() => sceneRef.current?.focusOn(selected.key)}
              onFocusWindow={() => focusWindow(selected.key)}
            />
          )}
          {selected && (
            <Resizer
              edge="left"
              className="resizer-detail"
              label="Largura do painel de detalhes"
              width={prefs.detailWidth}
              min={DETAIL_WIDTH.min}
              max={DETAIL_WIDTH.max}
              defaultWidth={DETAIL_WIDTH.default}
              onResize={(detailWidth) => update({ detailWidth })}
            />
          )}

          <div className="toasts" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} className={`toast toast-${t.kind}`}>
                {t.text}
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
