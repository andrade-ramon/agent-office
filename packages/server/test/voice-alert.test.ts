import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { voiceAlertReader } from '../src/config.js';
import { needsDecision, type EventType, type NormalizedEvent } from '../src/schema.js';
import { SessionStore } from '../src/state.js';
import { cleanSpeech, VoiceAlert, type VoiceAlertSettings } from '../src/voice-alert.js';

const T0 = 1_700_000_000_000;

describe('alerta por voz', () => {
  let store: SessionStore;
  let now: number;
  let spoken: string[];
  let settings: VoiceAlertSettings;
  let alert: VoiceAlert;

  const ev = (event: EventType, ts: number, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    agent: 'claude',
    sessionId: 's1',
    cwd: '/repo/loja',
    project: 'loja',
    event,
    toolCategory: 'other',
    ts,
    source: 'hook',
    ...extra,
  });

  beforeEach(() => {
    store = new SessionStore();
    now = T0;
    spoken = [];
    settings = { enabled: true, text: 'Ramon', everySec: 8, delaySec: 3, voice: 'Luciana' };
    alert = new VoiceAlert(
      store,
      () => settings,
      async (text, voice) => {
        spoken.push(`${text}|${voice ?? ''}`);
      },
      () => now,
    );
  });
  afterEach(() => store.dispose());

  it('chama o usuário e repete até a decisão ser tomada', async () => {
    store.apply(ev('prompt', T0));
    store.apply(ev('tool_start', T0 + 100, { toolName: 'Bash', toolCategory: 'bash', meta: { toolUseId: 't1' } }));
    expect(await alert.tick()).toBe(false); // ninguém esperando

    store.apply(ev('permission_wait', T0 + 1000, { toolName: 'Bash', toolCategory: 'bash' }));
    now = T0 + 2000;
    expect(await alert.tick()).toBe(false); // ainda dentro da espera inicial (3 s)
    now = T0 + 4100;
    expect(await alert.tick()).toBe(true);
    expect(spoken).toEqual(['Ramon|Luciana']);

    now = T0 + 8000;
    expect(await alert.tick()).toBe(false); // repete só a cada 8 s
    now = T0 + 12_200;
    expect(await alert.tick()).toBe(true);
    now = T0 + 20_300;
    expect(await alert.tick()).toBe(true);
    expect(spoken).toHaveLength(3);
    expect(alert.status()).toEqual({ enabled: true, pending: 1 });

    // decisão tomada: a ferramenta termina e o agente segue
    store.apply(ev('tool_end', T0 + 21_000, { meta: { toolUseId: 't1' } }));
    now = T0 + 40_000;
    expect(await alert.tick()).toBe(false);
    expect(spoken).toHaveLength(3);
    expect(alert.status().pending).toBe(0);

    // um novo pedido volta a chamar assim que passa a espera inicial
    store.apply(ev('permission_wait', T0 + 41_000));
    now = T0 + 44_100;
    expect(await alert.tick()).toBe(true);
  });

  it('pergunta do agente conta; turno ocioso no prompt não', async () => {
    store.apply(ev('stop', T0));
    store.apply(ev('waiting_input', T0 + 60_000, { meta: { reason: 'idle_prompt' } }));
    expect(store.get('claude:s1')).toMatchObject({ status: 'waiting_input', attentionReason: 'idle_prompt' });
    now = T0 + 120_000;
    expect(await alert.tick()).toBe(false);

    store.apply(ev('prompt', T0 + 130_000));
    expect(store.get('claude:s1')?.attentionReason).toBeUndefined();
    store.apply(ev('waiting_input', T0 + 131_000, { meta: { reason: 'elicitation_dialog' } }));
    now = T0 + 135_000;
    expect(await alert.tick()).toBe(true);

    expect(needsDecision({ status: 'permission_wait' })).toBe(true);
    expect(needsDecision({ status: 'waiting_input' })).toBe(true);
    expect(needsDecision({ status: 'waiting_input', attentionReason: 'idle_prompt' })).toBe(false);
    expect(needsDecision({ status: 'done' })).toBe(false);
  });

  it('desligado ou sem texto não fala; não sobrepõe duas falas', async () => {
    store.apply(ev('permission_wait', T0));
    now = T0 + 10_000;
    settings = { ...settings, enabled: false };
    expect(await alert.tick()).toBe(false);
    expect(alert.status()).toEqual({ enabled: false, pending: 0 });
    settings = { ...settings, enabled: true, text: '   ' };
    expect(await alert.tick()).toBe(false);

    settings = { ...settings, text: 'Ramon' };
    let release: () => void = () => undefined;
    const slow = new VoiceAlert(
      store,
      () => settings,
      () => new Promise<void>((r) => (release = r)),
      () => now,
    );
    const first = slow.tick();
    now += 30_000;
    expect(await slow.tick()).toBe(false); // a primeira fala ainda não terminou
    release();
    expect(await first).toBe(true);
  });

  it('limpa o texto falado', () => {
    expect(cleanSpeech('  Ramon\n\tvem cá  ')).toBe('Ramon vem cá');
    expect(cleanSpeech('x'.repeat(200))).toHaveLength(80);
    expect(cleanSpeech('\u0000\u0007')).toBe('');
  });
});

describe('voiceAlertReader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ao-voice-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lê a seção voiceAlert e relê quando o arquivo muda', async () => {
    const read = voiceAlertReader(dir);
    expect(read()).toMatchObject({ enabled: false, text: '' });

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 4747, voiceAlert: { enabled: true, text: 'Ramon', everySec: 5, voice: 'Luciana' } }));
    expect(read()).toEqual({ enabled: true, text: 'Ramon', everySec: 5, delaySec: 3, voice: 'Luciana' });

    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 4747, voiceAlert: { enabled: false, text: 'Ramon' } }));
    expect(read()).toMatchObject({ enabled: false, text: 'Ramon', everySec: 8 });

    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(join(dir, 'config.json'), '{ lixo');
    expect(read().enabled).toBe(false);
  });
});
