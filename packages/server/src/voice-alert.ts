import { execFile } from 'node:child_process';
import { needsDecision } from './schema.js';
import type { SessionStore } from './state.js';

export interface VoiceAlertSettings {
  enabled: boolean;
  /** O que falar (normalmente o seu nome). */
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

/**
 * Alerta por voz: enquanto alguma sessão estiver parada esperando uma decisão
 * do usuário (permissão ou pergunta), fala o texto configurado e repete até a
 * decisão ser tomada.
 */
export class VoiceAlert {
  private timer: NodeJS.Timeout | null = null;
  private speaking = false;
  private lastSpokeAt = 0;

  constructor(
    private readonly store: SessionStore,
    private readonly settings: () => VoiceAlertSettings,
    private readonly speak: Speak = systemSpeak,
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
    const enabled = settings.enabled && cleanSpeech(settings.text).length > 0;
    return { enabled, pending: enabled ? this.pending(settings) : 0 };
  }

  /** Um passo do alerta. Retorna true se falou. */
  async tick(): Promise<boolean> {
    if (this.speaking) return false;
    const settings = this.settings();
    if (!settings.enabled || !cleanSpeech(settings.text)) return false;
    if (this.pending(settings) === 0) {
      // Decisão tomada: o próximo pedido volta a chamar na hora.
      this.lastSpokeAt = 0;
      return false;
    }
    if (this.now() - this.lastSpokeAt < Math.max(2, settings.everySec) * 1000) return false;
    this.speaking = true;
    this.lastSpokeAt = this.now();
    try {
      await this.speak(settings.text, settings.voice || undefined);
    } catch {
      /* sem áudio/sintetizador: tenta de novo na próxima repetição */
    } finally {
      this.speaking = false;
    }
    return true;
  }
}
