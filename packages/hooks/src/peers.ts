import { execFileSync } from 'node:child_process';
import { DEFAULT_PORT, readConfig, writeConfig, type Paths, type PeerEntry } from './paths.js';

const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
/** `host` ou `usuario@host`; nunca começa com "-" (seria lido pelo ssh como opção). */
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/;

export function isLoopbackUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function listPeers(paths: Paths): PeerEntry[] {
  const raw = readConfig(paths).peers;
  return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string') : [];
}

export interface AddPeerInput {
  name: string;
  ssh?: string;
  url?: string;
  remotePort?: number;
}

export interface AddPeerResult {
  ok: boolean;
  detail: string;
  peer?: PeerEntry;
}

/** Cadastra (ou substitui) uma máquina. O servidor relê o config.json e conecta sozinho. */
export function addPeer(paths: Paths, input: AddPeerInput): AddPeerResult {
  const name = input.name.trim();
  if (!PEER_NAME.test(name)) return { ok: false, detail: 'nome inválido: use letras, números, espaço, ponto, hífen ou sublinhado (até 40)' };
  if (input.ssh && input.url) return { ok: false, detail: 'informe o destino SSH ou --url, não os dois' };
  let peer: PeerEntry;
  if (input.url) {
    if (!isLoopbackUrl(input.url)) return { ok: false, detail: '--url precisa ser um endereço local (http://127.0.0.1:<porta>) de um túnel até a outra máquina' };
    peer = { name, url: input.url.replace(/\/+$/, '') };
  } else if (input.ssh) {
    if (!SSH_TARGET.test(input.ssh)) return { ok: false, detail: 'destino SSH inválido: use host ou usuario@host' };
    const remotePort = input.remotePort && input.remotePort > 0 && input.remotePort < 65536 ? Math.floor(input.remotePort) : DEFAULT_PORT;
    peer = { name, ssh: input.ssh, remotePort };
  } else {
    return { ok: false, detail: 'informe o destino SSH (host ou usuario@host) ou --url' };
  }
  const config = readConfig(paths);
  writeConfig(paths, { ...config, peers: [...listPeers(paths).filter((p) => p.name !== name), peer] });
  return { ok: true, detail: describePeer(peer), peer };
}

export function removePeer(paths: Paths, name: string): boolean {
  const peers = listPeers(paths);
  const rest = peers.filter((p) => p.name !== name.trim());
  if (rest.length === peers.length) return false;
  writeConfig(paths, { ...readConfig(paths), peers: rest });
  return true;
}

export function describePeer(peer: PeerEntry): string {
  if (peer.ssh) return `túnel SSH até ${peer.ssh}, porta ${peer.remotePort ?? DEFAULT_PORT}`;
  return `túnel próprio em ${peer.url ?? '?'}`;
}

export interface SshCheck {
  ok: boolean;
  detail: string;
}

/**
 * Confere, antes de cadastrar, se dá para entrar por SSH sem senha e se o
 * agent-office responde na outra máquina. Só leitura: um `curl` no /api/health de lá.
 */
export function checkSshPeer(target: string, remotePort: number): SshCheck {
  try {
    const out = execFileSync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', target, `curl -s -m 4 http://127.0.0.1:${remotePort}/api/health`],
      { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const health = JSON.parse(out) as { name?: string; version?: string };
      if (health.name === 'agent-office') return { ok: true, detail: `agent-office ${health.version ?? ''} respondendo na outra máquina`.replace('  ', ' ') };
    } catch {
      /* resposta vazia ou que não é do agent-office */
    }
    return { ok: false, detail: `o SSH funciona, mas o agent-office não respondeu na porta ${remotePort} de lá (instale e rode "agent-office start" naquela máquina)` };
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const reason = String(e.stderr ?? '').trim().split('\n').pop() || e.message || 'falha';
    return { ok: false, detail: `o SSH sem senha falhou: ${reason.slice(0, 160)}` };
  }
}
