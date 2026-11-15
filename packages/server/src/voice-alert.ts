import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { needsDecision } from './schema.js';
import type { SessionStore } from './state.js';

/** `voice` fala o texto; `siren` e `beep` tocam um som gerado por código. */
export type AlertSound = 'voice' | 'siren' | 'beep';
export const ALERT_SOUNDS: readonly AlertSound[] = ['voice', 'siren', 'beep'];

export interface VoiceAlertSettings {
  enabled: boolean;
  /** O que tocar. Ausente = `voice`. */
  sound?: AlertSound;
  /** O que falar (normalmente o seu nome) quando `sound` é `voice`. */
  text: string;
  /** Intervalo entre repetições, em segundos. */
  everySec: number;
  /** Espera antes do primeiro chamado (evita falar em aprovações instantâneas). */
  delaySec: number;
  /** Voz do sistema (ex.: "Luciana" no macOS). Vazio = voz padrão. */
  voice?: string;
}

export const DEFAULT_VOICE_ALERT: VoiceAlertSettings = {
  enabled: false,
  text: '',
  everySec: 8,
  delaySec: 3,
};

export type Speak = (text: string, voice?: string) => Promise<void>;
/** Toca o alerta uma vez (injetável nos testes). */
export type PlayAlert = (settings: VoiceAlertSettings) => Promise<void>;

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err) => resolve(!err));
  });
}

/** Limpa o texto falado: uma linha curta, sem caracteres de controle. */
export function cleanSpeech(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Fala pelo sintetizador de voz do sistema operacional (sempre local). */
export const systemSpeak: Speak = async (text, voice) => {
  const phrase = cleanSpeech(text);
  if (!phrase) return;
  if (process.platform === 'darwin') {
    await run('say', [...(voice ? ['-v', voice] : []), phrase]);
  } else if (process.platform === 'win32') {
    const quoted = phrase.replace(/'/g, "''");
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${quoted}')`,
    ]);
  } else if (!(await run('spd-say', ['-w', phrase]))) {
    await run('espeak', [phrase]);
  }
};

/** Arquivo WAV de um som do alerta (packages/server/assets/sounds). */
export function soundFile(sound: Exclude<AlertSound, 'voice'>): string {
  return fileURLToPath(new URL(`../assets/sounds/${sound}.wav`, import.meta.url));
}

/** Toca um WAV pelo tocador do sistema operacional, no volume atual. */
export async function playFile(file: string): Promise<void> {
  if (process.platform === 'darwin') {
    await run('afplay', [file]);
  } else if (process.platform === 'win32') {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
    ]);
  } else if (!(await run('paplay', [file]))) {
    await run('aplay', ['-q', file]);
  }
}

/** true quando há o que tocar: um som, ou um texto para falar. */
export function alertReady(settings: VoiceAlertSettings): boolean {
  if (!settings.enabled) return false;
  return (settings.sound ?? 'voice') !== 'voice' || cleanSpeech(settings.text).length > 0;
}

export const systemAlert: PlayAlert = async (settings) => {
  const sound = settings.sound ?? 'voice';
  if (sound === 'voice') await systemSpeak(settings.text, settings.voice || undefined);
  else await playFile(soundFile(sound));
};

/**
 * Alerta sonoro: enquanto alguma sessão estiver parada esperando uma decisão
 * do usuário (permissão ou pergunta), toca a sirene (ou fala o texto
 * configurado) e repete até a decisão ser tomada.
 */
export class VoiceAlert {
  private timer: NodeJS.Timeout | null = null;
  private speaking = false;
  private lastSpokeAt = 0;

  constructor(
    private readonly store: SessionStore,
    private readonly settings: () => VoiceAlertSettings,
    private readonly play: PlayAlert = systemAlert,
    private readonly now: () => number = Date.now,
  ) {}

  start(intervalMs = 1000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sessões que estão esperando uma decisão há pelo menos `delaySec`. */
  pending(settings: VoiceAlertSettings = this.settings()): number {
    const cutoff = this.now() - settings.delaySec * 1000;
    let n = 0;
    for (const s of this.store.list()) {
      if (needsDecision(s) && s.statusSince <= cutoff) n++;
    }
    return n;
  }

  status(): { enabled: boolean; pending: number } {
    const settings = this.settings();
    const enabled = alertReady(settings);
    return { enabled, pending: enabled ? this.pending(settings) : 0 };
  }

  /** Um passo do alerta. Retorna true se tocou. */
  async tick(): Promise<boolean> {
    if (this.speaking) return false;
    const settings = this.settings();
    if (!alertReady(settings)) return false;
    if (this.pending(settings) === 0) {
      // Decisão tomada: o próximo pedido volta a chamar na hora.
      this.lastSpokeAt = 0;
      return false;
    }
    if (this.now() - this.lastSpokeAt < Math.max(2, settings.everySec) * 1000) return false;
    this.speaking = true;
    this.lastSpokeAt = this.now();
    try {
      await this.play(settings);
    } catch {
      /* sem áudio: tenta de novo na próxima repetição */
    } finally {
      this.speaking = false;
    }
    return true;
  }
}
