import { execFileSync } from 'node:child_process';
import { readConfig, writeConfig, type Paths, type VoiceAlertConfig } from './paths.js';

export interface AlertOptions {
  text?: string;
  voice?: string;
  everySec?: number;
  delaySec?: number;
}

export function currentAlert(paths: Paths): VoiceAlertConfig {
  const v = readConfig(paths).voiceAlert;
  return {
    enabled: v?.enabled === true,
    text: typeof v?.text === 'string' ? v.text : '',
    ...(v?.everySec ? { everySec: v.everySec } : {}),
    ...(v?.delaySec !== undefined ? { delaySec: v.delaySec } : {}),
    ...(v?.voice ? { voice: v.voice } : {}),
  };
}

/** Liga (ou ajusta) o alerta por voz no config.json. O servidor relê o arquivo sozinho. */
export function enableAlert(paths: Paths, opts: AlertOptions): { ok: boolean; detail: string; alert?: VoiceAlertConfig } {
  const config = readConfig(paths);
  const prev = currentAlert(paths);
  const text = (opts.text ?? prev.text).trim();
  if (!text) return { ok: false, detail: 'informe o que falar, por exemplo: agent-office alert on "Seu nome"' };
  const alert: VoiceAlertConfig = {
    enabled: true,
    text,
    everySec: opts.everySec && opts.everySec >= 2 ? opts.everySec : (prev.everySec ?? 8),
    delaySec: opts.delaySec !== undefined && opts.delaySec >= 0 ? opts.delaySec : (prev.delaySec ?? 3),
    ...((opts.voice ?? prev.voice) ? { voice: opts.voice ?? prev.voice } : {}),
  };
  writeConfig(paths, { ...config, voiceAlert: alert });
  return { ok: true, detail: describeAlert(alert), alert };
}

export function disableAlert(paths: Paths): void {
  const config = readConfig(paths);
  writeConfig(paths, { ...config, voiceAlert: { ...currentAlert(paths), enabled: false } });
}

export function describeAlert(a: VoiceAlertConfig): string {
  if (!a.enabled) return 'desligado';
  return `fala "${a.text}" a cada ${a.everySec ?? 8}s${a.voice ? ` (voz ${a.voice})` : ''} enquanto houver decisão pendente`;
}

/** Fala uma vez agora, para conferir volume e voz. */
export function speakOnce(text: string, voice?: string): boolean {
  const phrase = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!phrase) return false;
  try {
    if (process.platform === 'darwin') {
      execFileSync('say', [...(voice ? ['-v', voice] : []), phrase], { stdio: 'ignore', timeout: 15_000 });
    } else if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${phrase.replace(/'/g, "''")}')`],
        { stdio: 'ignore', timeout: 15_000 },
      );
    } else {
      try {
        execFileSync('spd-say', ['-w', phrase], { stdio: 'ignore', timeout: 15_000 });
      } catch {
        execFileSync('espeak', [phrase], { stdio: 'ignore', timeout: 15_000 });
      }
    }
    return true;
  } catch {
    return false;
  }
}
