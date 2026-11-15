import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALERT_SOUNDS, readConfig, writeConfig, type AlertSound, type Paths, type VoiceAlertConfig } from './paths.js';

export interface AlertOptions {
  sound?: AlertSound;
  text?: string;
  voice?: string;
  everySec?: number;
  delaySec?: number;
}

const SOUND_LABEL: Record<Exclude<AlertSound, 'voice'>, string> = { siren: 'a sirene', beep: 'o bipe' };

export function isAlertSound(value: unknown): value is AlertSound {
  return ALERT_SOUNDS.includes(value as AlertSound);
}

export function currentAlert(paths: Paths): VoiceAlertConfig {
  const v = readConfig(paths).voiceAlert;
  return {
    enabled: v?.enabled === true,
    ...(isAlertSound(v?.sound) && v.sound !== 'voice' ? { sound: v.sound } : {}),
    text: typeof v?.text === 'string' ? v.text : '',
    ...(v?.everySec ? { everySec: v.everySec } : {}),
    ...(v?.delaySec !== undefined ? { delaySec: v.delaySec } : {}),
    ...(v?.voice ? { voice: v.voice } : {}),
  };
}

/** Liga (ou ajusta) o alerta sonoro no config.json. O servidor relê o arquivo sozinho. */
export function enableAlert(paths: Paths, opts: AlertOptions): { ok: boolean; detail: string; alert?: VoiceAlertConfig } {
  const config = readConfig(paths);
  const prev = currentAlert(paths);
  const sound = opts.sound ?? prev.sound ?? 'voice';
  const text = (opts.text ?? prev.text).trim();
  if (sound === 'voice' && !text) {
    return { ok: false, detail: 'informe o que falar (agent-office alert on "Seu nome") ou escolha um som (--sound siren)' };
  }
  const alert: VoiceAlertConfig = {
    enabled: true,
    ...(sound !== 'voice' ? { sound } : {}),
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
  const every = `a cada ${a.everySec ?? 8}s`;
  const what =
    a.sound && a.sound !== 'voice'
      ? `toca ${SOUND_LABEL[a.sound]} ${every}`
      : `fala "${a.text}" ${every}${a.voice ? ` (voz ${a.voice})` : ''}`;
  return `${what} enquanto houver decisão pendente`;
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

/** Toca o som uma vez agora, para conferir o volume. */
export function playOnce(paths: Paths, sound: Exclude<AlertSound, 'voice'>): boolean {
  const file = join(paths.sounds, `${sound}.wav`);
  if (!existsSync(file)) return false;
  try {
    if (process.platform === 'darwin') {
      execFileSync('afplay', [file], { stdio: 'ignore', timeout: 15_000 });
    } else if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`],
        { stdio: 'ignore', timeout: 15_000 },
      );
    } else {
      try {
        execFileSync('paplay', [file], { stdio: 'ignore', timeout: 15_000 });
      } catch {
        execFileSync('aplay', ['-q', file], { stdio: 'ignore', timeout: 15_000 });
      }
    }
    return true;
  } catch {
    return false;
  }
}
