import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCloudWatcher, claudeResultText, parseClaudeCloudList, type ClaudeCloudSettings } from '../src/claude-cloud.js';
import { needsDecision, type SessionState } from '../src/schema.js';
import { SessionStore } from '../src/state.js';
import { hashString } from '../src/util.js';
import { VoiceAlert } from '../src/voice-alert.js';

const T0 = 1_700_000_000_000;

/** Saída de `claude -p "/list-agents" --output-format json` com as linhas dadas. */
function output(rows: string[], extra = ''): string {
  const result = `Other Claude sessions (${rows.length}):\n${rows.join('\n')}${extra}`;
  return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result })}\nClient.listTools() called but server does not advertise tools capability - returning empty list\n`;
}
const cloud = (status: string, title: string): string => `  [${status}]  ·  ${title}  ·  cloud`;
const local = '  [busy]  ·  Sessão local  ·  /Users/x/repo  ·  started 2h ago';
const idOf = (title: string, n = 1): string => `cloud-${hashString(title).toString(36)}${n > 1 ? `-${n}` : ''}`;

describe('listagem do Claude em nuvem', () => {
  it('extrai o texto do resultado, mesmo com linhas de aviso em volta', () => {
    expect(claudeResultText(output([local]))).toContain('Other Claude sessions (1):');
    expect(() => claudeResultText('aviso solto\n')).toThrow('saída inesperada');
    expect(() => claudeResultText(JSON.stringify({ type: 'result', is_error: true, result: 'x' }))).toThrow('devolveu um erro');
  });

  it('fica só com as sessões em nuvem e traduz o estado', () => {
    const text = claudeResultText(
      output([
        local,
        cloud('running', 'Favoritar relatórios salvos'),
        cloud('idle', 'PR 559 correções e CI'),
        cloud('waiting on a human', 'Migrar · autenticação'),
        cloud('unknown', 'Estado que a CLI não informou'),
        '  [running]  ·  Em outra máquina  ·  Remote Control',
        cloud('running', '(untitled)'),
      ]),
    );
    expect(parseClaudeCloudList(text)).toEqual([
      { id: hashString('Favoritar relatórios salvos').toString(36), state: 'running', url: 'https://claude.ai/code', title: 'Favoritar relatórios salvos' },
      { id: hashString('PR 559 correções e CI').toString(36), state: 'done', url: 'https://claude.ai/code', title: 'PR 559 correções e CI' },
      { id: hashString('Migrar · autenticação').toString(36), state: 'waiting', url: 'https://claude.ai/code', title: 'Migrar · autenticação' },
      { id: hashString('').toString(36), state: 'running', url: 'https://claude.ai/code' },
    ]);
  });

  it('títulos repetidos ganham sufixo; falha da lista vira erro', () => {
    const ids = parseClaudeCloudList([cloud('running', 'Mesma'), cloud('idle', 'Mesma')].join('\n')).map((s) => s.id);
    expect(ids).toEqual([hashString('Mesma').toString(36), `${hashString('Mesma').toString(36)}-2`]);
    expect(parseClaudeCloudList('No subagents or other Claude sessions.')).toEqual([]);
    expect(() =>
      parseClaudeCloudList('(cloud session list could not be fetched just now — cloud sessions are missing from this listing; try /list-agents again shortly)'),
    ).toThrow('não pôde ser consultada');
  });
});

describe('ClaudeCloudWatcher', () => {
  let store: SessionStore;
  let now: number;
  let settings: ClaudeCloudSettings;
  let rows: string[];
  let watcher: ClaudeCloudWatcher;

  const get = (title: string, n = 1): SessionState | undefined => store.get(`claude:${idOf(title, n)}`);
  const poll = async (advanceMs = 60_000): Promise<boolean> => {
    now += advanceMs;
    return watcher.tick();
  };

  beforeEach(() => {
    store = new SessionStore();
    now = T0;
    settings = { enabled: true, bin: '/fake/claude', everySec: 60 };
    rows = [];
    watcher = new ClaudeCloudWatcher(store, () => settings, async () => output(rows), () => now);
  });
  afterEach(() => store.dispose());

  it('mostra quem está rodando; ociosas antigas ficam de fora até voltarem a rodar', async () => {
    rows = [local, cloud('running', 'Favoritar relatórios'), cloud('idle', 'PR 559')];
    await watcher.tick();
    expect(get('Favoritar relatórios')).toMatchObject({
      agent: 'claude',
      status: 'working',
      remote: true,
      alive: true,
      entrypoint: 'Claude Cloud',
      project: 'Claude Cloud',
      title: 'Favoritar relatórios',
      url: 'https://claude.ai/code',
    });
    expect(get('PR 559')).toBeUndefined();
    expect(store.size).toBe(1);
    expect(watcher.status()).toMatchObject({ enabled: true, running: 1, error: null });

    // intervalo mínimo de 30 s, mesmo que a configuração peça menos
    settings = { ...settings, everySec: 5 };
    expect(await poll(20_000)).toBe(false);

    rows = [cloud('idle', 'Favoritar relatórios'), cloud('running', 'PR 559')];
    await poll();
    expect(get('Favoritar relatórios')).toMatchObject({ status: 'done', alive: false });
    expect(get('PR 559')).toMatchObject({ status: 'working', alive: true });

    // sessão apagada na nuvem sai do escritório
    rows = [cloud('running', 'PR 559')];
    await poll();
    expect(get('Favoritar relatórios')?.status).toBe('ended');
  });

  it('passar a esperar um humano dispara o alerta; quem já esperava aparece sem alerta', async () => {
    const played: string[] = [];
    const alert = new VoiceAlert(
      store,
      () => ({ enabled: true, sound: 'beep', text: '', everySec: 15, delaySec: 3 }),
      async (s) => {
        played.push(s.sound ?? 'voice');
      },
      () => now,
    );

    rows = [cloud('running', 'Nova'), cloud('waiting on a human', 'Antiga')];
    await watcher.tick();
    expect(get('Antiga')).toMatchObject({ status: 'waiting_input', attentionReason: 'already_waiting', alive: true });
    expect(needsDecision(get('Antiga')!)).toBe(false);
    now += 10_000;
    expect(await alert.tick()).toBe(false);

    rows = [cloud('waiting on a human', 'Nova'), cloud('waiting on a human', 'Antiga')];
    await poll(50_000);
    expect(get('Nova')).toMatchObject({ status: 'waiting_input', attentionReason: 'requires_action' });
    expect(needsDecision(get('Nova')!)).toBe(true);
    now += 4000;
    expect(await alert.tick()).toBe(true);
    expect(played).toEqual(['beep']);

    // respondida na nuvem: volta a rodar e o alerta para
    rows = [cloud('running', 'Nova'), cloud('waiting on a human', 'Antiga')];
    await poll();
    expect(get('Nova')).toMatchObject({ status: 'working', counts: { prompts: 1 } });
    now += 30_000;
    expect(await alert.tick()).toBe(false);

    // uma sessão que espera não expira por inatividade
    store.tick(now + 2 * 60 * 60_000);
    expect(get('Antiga')?.status).toBe('waiting_input');
  });

  it('falha na consulta mantém as sessões e registra o erro', async () => {
    rows = [cloud('running', 'Nova')];
    await watcher.tick();
    watcher = new ClaudeCloudWatcher(store, () => settings, async () => { throw new Error('Not logged in'); }, () => now);
    await poll();
    expect(watcher.status()).toMatchObject({ enabled: true, error: 'Not logged in' });
    expect(get('Nova')?.status).toBe('working');
  });
});
