/**
 * SshConnectionManager - Manages SSH connection lifecycle.
 *
 * Auth strategy for `sshConfig` mode:
 * 1. Resolve host via OpenSSH `ssh -G` (honors Host blocks, Match, Include,
 *    IdentityAgent, IdentityFile, default keys).
 * 2. Build a list of auth candidates: agent → IdentityFile entries → default
 *    keys.
 * 3. Try each candidate in its own ssh2 connection. Auth failure on one
 *    candidate moves to the next (matching how OpenSSH behaves). Network
 *    errors abort the chain immediately.
 *
 * Two safety nets:
 * - `tryKeyboard: false` on every attempt so the server can't trap us in
 *   keyboard-interactive prompts that the GUI can't answer.
 * - A single 20s outer timeout wraps the entire chain (including SFTP open),
 *   so the spinner never hangs forever.
 */

import { createLogger } from '@shared/utils/logger';
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Client, type SFTPWrapper } from 'ssh2';

import { LocalFileSystemProvider } from './LocalFileSystemProvider';
import { SshConfigParser } from './SshConfigParser';
import { SshFileSystemProvider } from './SshFileSystemProvider';
import { type ResolvedSshHost, SshHostResolver } from './SshHostResolver';

import type { FileSystemProvider } from './FileSystemProvider';
import type { SshAuthMethod, SshConfigHostEntry } from '@shared/types';

const logger = createLogger('Infrastructure:SshConnectionManager');

// =============================================================================
// Types
// =============================================================================

export type SshConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type { SshAuthMethod };

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
}

export interface SshConnectionStatus {
  state: SshConnectionState;
  host: string | null;
  error: string | null;
  remoteProjectsPath: string | null;
}

interface AuthAttempt {
  source: string;
  outcome: 'used' | 'skipped' | 'failed';
  reason?: string;
}

type AuthCandidate =
  | { kind: 'agent'; socket: string; label: string }
  | { kind: 'privateKey'; data: string; label: string }
  | { kind: 'password'; password: string; label: string };

interface ResolvedTarget {
  host: string;
  port: number;
  username: string;
  resolved: ResolvedSshHost | null;
  matchedAlias?: string;
}

const CONNECT_TIMEOUT_MS = 25_000;
// ssh2 readyTimeout covers TCP + handshake + auth. Leave headroom under our
// outer timeout so the outer fires last (cleaner error + diagnostics).
const SSH2_READY_TIMEOUT_MS = 22_000;
// Quick reachability probe before handing off to ssh2. Long enough for slow
// VPN tunnels but short enough that failure surfaces in seconds, not 25.
const TCP_PROBE_TIMEOUT_MS = 5_000;
// SFTP subsystem open. Should complete in <1s on a healthy server; anything
// past 8s means the server isn't going to answer (sshd_config missing
// `Subsystem sftp`, restricted shell, etc.) — fail loud rather than burn the
// whole connect budget.
const SFTP_OPEN_TIMEOUT_MS = 8_000;

// =============================================================================
// Connection Manager
// =============================================================================

export class SshConnectionManager extends EventEmitter {
  private client: Client | null = null;
  private provider: FileSystemProvider;
  private localProvider: LocalFileSystemProvider;
  private configParser: SshConfigParser;
  private hostResolver: SshHostResolver;
  private state: SshConnectionState = 'disconnected';
  private connectedHost: string | null = null;
  private lastError: string | null = null;
  private remoteProjectsPath: string | null = null;

  constructor() {
    super();
    this.localProvider = new LocalFileSystemProvider();
    this.provider = this.localProvider;
    this.configParser = new SshConfigParser();
    this.hostResolver = new SshHostResolver();
  }

  getProvider(): FileSystemProvider {
    return this.provider;
  }

  getStatus(): SshConnectionStatus {
    return {
      state: this.state,
      host: this.connectedHost,
      error: this.lastError,
      remoteProjectsPath: this.remoteProjectsPath,
    };
  }

  getRemoteProjectsPath(): string | null {
    return this.remoteProjectsPath;
  }

  isRemote(): boolean {
    return this.state === 'connected' && this.provider.type === 'ssh';
  }

  async getConfigHosts(): Promise<SshConfigHostEntry[]> {
    return this.configParser.getHosts();
  }

  async resolveHostConfig(alias: string): Promise<SshConfigHostEntry | null> {
    return this.configParser.resolveHost(alias);
  }

  async connect(config: SshConnectionConfig): Promise<void> {
    if (this.client) {
      this.disconnect();
    }

    this.setState('connecting');
    this.connectedHost = config.host;

    let chainResult: { client: Client; sftp: SFTPWrapper } | null = null;
    try {
      chainResult = await this.connectChain(config);

      const { client, sftp } = chainResult;
      this.client = client;
      this.provider = new SshFileSystemProvider(sftp);

      // Attach listeners before any await: an 'error' emitted while we wait
      // on the remote path lookup would otherwise be unhandled and crash main.
      client.on('end', () => {
        logger.info('SSH connection ended');
        this.handleDisconnect();
      });
      client.on('close', () => {
        logger.info('SSH connection closed');
        this.handleDisconnect();
      });
      client.on('error', (err) => {
        logger.error('SSH connection error:', err);
        this.lastError = err.message;
        this.setState('error');
      });

      this.remoteProjectsPath = await this.resolveRemoteProjectsPath(config.username);

      this.setState('connected');
      logger.info(`SSH connected to ${config.host}:${config.port}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`SSH connection failed: ${message}`);
      this.lastError = message;
      this.setState('error');
      // If the chain returned a client but we failed afterwards, dispose it.
      if (chainResult) {
        try {
          chainResult.client.end();
        } catch {
          /* ignore */
        }
      }
      this.cleanup();
      throw err instanceof Error ? err : new Error(message);
    }
  }

  async testConnection(config: SshConnectionConfig): Promise<{ success: boolean; error?: string }> {
    try {
      const { client } = await this.connectChain(config);
      client.end();
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  disconnect(): void {
    this.cleanup();
    this.provider = this.localProvider;
    this.connectedHost = null;
    this.lastError = null;
    this.remoteProjectsPath = null;
    this.setState('disconnected');
    logger.info('Switched to local mode');
  }

  dispose(): void {
    this.cleanup();
    this.localProvider.dispose();
    this.removeAllListeners();
  }

  // ===========================================================================
  // Private: connection chain
  // ===========================================================================

  private async connectChain(
    config: SshConnectionConfig
  ): Promise<{ client: Client; sftp: SFTPWrapper }> {
    const timings = new Timings();
    const attempts: AuthAttempt[] = [];
    let inFlightClient: Client | null = null;

    const work = async (): Promise<{ client: Client; sftp: SFTPWrapper }> => {
      timings.start('resolve');
      const target = await this.resolveTarget(config);
      timings.end('resolve');

      if (target.matchedAlias) {
        attempts.push({
          source: `matched ssh_config alias "${target.matchedAlias}"`,
          outcome: 'used',
        });
      }

      timings.start('buildCandidates');
      const candidates = await this.buildAuthCandidates(config, target.resolved, attempts);
      timings.end('buildCandidates');

      if (candidates.length === 0) {
        throw this.enrichAuthError(
          new Error('No usable authentication method found.'),
          attempts,
          timings
        );
      }

      // TCP reachability probe — fails fast and surfaces "Electron can't see
      // this host" before we burn 22s on ssh2's readyTimeout. The most common
      // cause when terminal `ssh` works but this app doesn't is a per-app VPN
      // (Cisco AnyConnect, GlobalProtect, Cloudflare WARP, some MDM clients)
      // that routes whitelisted bundle IDs only.
      timings.start(`tcp probe ${target.host}:${target.port}`);
      const probe = await probeTcp(target.host, target.port, TCP_PROBE_TIMEOUT_MS);
      timings.end(`tcp probe ${target.host}:${target.port}`);
      attempts.push({
        source: `TCP probe ${target.host}:${target.port}`,
        outcome: probe.ok ? 'used' : 'failed',
        reason: probe.reason,
      });

      if (!probe.ok) {
        throw this.enrichAuthError(
          new Error(
            `Cannot reach ${target.host}:${target.port} from this app (${probe.reason ?? 'unknown'}).\n` +
              `If \`ssh ${config.host}\` works in your terminal, the host is reachable from your ` +
              'shell but not from this Electron process. The most common cause is a per-app VPN ' +
              '(some corporate VPN clients route only whitelisted apps through the tunnel) — ' +
              "add this app to your VPN client's allowed-apps list, or switch the VPN to full-tunnel mode."
          ),
          attempts,
          timings
        );
      }

      // Single TCP/SSH session — ssh2's authHandler walks our candidate list,
      // trying each method as the previous fails. Same behavior as OpenSSH;
      // avoids the cumulative TCP+handshake cost of one connection per key.
      const client = new Client();
      inFlightClient = client;
      const queue = [...candidates];
      let lastTried: AuthCandidate | null = null;

      timings.start(`tcp+handshake ${target.host}:${target.port}`);
      try {
        await new Promise<void>((resolve, reject) => {
          const onReady = (): void => {
            if (lastTried) {
              attempts.push({ source: lastTried.label, outcome: 'used' });
            }
            client.removeListener('error', onError);
            resolve();
          };
          const onError = (err: Error): void => {
            client.removeListener('ready', onReady);
            reject(err);
          };
          client.once('ready', onReady);
          client.once('error', onError);

          client.connect({
            host: target.host,
            port: target.port,
            username: target.username,
            readyTimeout: SSH2_READY_TIMEOUT_MS,
            tryKeyboard: false,
            authHandler: (_methodsLeft, partialSuccess, callback) => {
              if (lastTried && !partialSuccess) {
                attempts.push({
                  source: lastTried.label,
                  outcome: 'failed',
                  reason: 'rejected by server',
                });
              }
              const next = queue.shift();
              if (!next) {
                // ssh2 accepts `false` at runtime to abort auth, but the typed
                // signature doesn't expose it. Double-cast through `unknown`.
                (callback as unknown as (v: false) => void)(false);
                return;
              }
              lastTried = next;
              switch (next.kind) {
                case 'agent':
                  callback({ type: 'agent', username: target.username, agent: next.socket });
                  return;
                case 'privateKey':
                  callback({ type: 'publickey', username: target.username, key: next.data });
                  return;
                case 'password':
                  callback({
                    type: 'password',
                    username: target.username,
                    password: next.password,
                  });
                  return;
              }
            },
          });
        });
        timings.end(`tcp+handshake ${target.host}:${target.port}`);

        timings.start('open sftp');
        const sftp = await this.openSftp(client);
        timings.end('open sftp');
        inFlightClient = null;
        return { client, sftp };
      } catch (err) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
        inFlightClient = null;
        const error = err instanceof Error ? err : new Error(String(err));
        throw this.enrichAuthError(error, attempts, timings);
      }
    };

    // Outer hard timeout. Lives inside connectChain so it can pull the
    // attempts/timings already collected and append them to the error —
    // otherwise a timeout surfaces a bare "host unreachable" with no
    // diagnostic about which step actually stalled.
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (inFlightClient) {
          try {
            inFlightClient.end();
          } catch {
            /* ignore */
          }
        }
        reject(
          this.enrichAuthError(
            new Error(
              `SSH connection timed out after ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s. ` +
                'The host may be unreachable, or the server is not responding.'
            ),
            attempts,
            timings
          )
        );
      }, CONNECT_TIMEOUT_MS);
    });

    try {
      return await Promise.race([work(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Resolves the target host. Runs `ssh -G <input>` first; if that returned
   * nothing useful AND the input matches a `HostName` from `~/.ssh/config`,
   * re-resolves using the matching alias so we inherit its directives.
   */
  private async resolveTarget(config: SshConnectionConfig): Promise<ResolvedTarget> {
    let resolved = await this.hostResolver.resolve(config.host);
    let matchedAlias: string | undefined;

    const hasInheritedConfig =
      resolved !== null &&
      ((resolved.identityFiles.length > 0 && !looksLikeOnlyDefaultKeys(resolved.identityFiles)) ||
        Boolean(resolved.identityAgent) ||
        Boolean(resolved.user) ||
        Boolean(resolved.hostname && resolved.hostname !== config.host));

    if (!hasInheritedConfig) {
      const alias = await this.findAliasByHostname(config.host);
      if (alias) {
        const fromAlias = await this.hostResolver.resolve(alias);
        if (fromAlias) {
          resolved = fromAlias;
          matchedAlias = alias;
        }
      }
    }

    return {
      host: resolved?.hostname ?? config.host,
      port: resolved?.port ?? config.port,
      username: config.username || resolved?.user || os.userInfo().username,
      resolved,
      matchedAlias,
    };
  }

  private async findAliasByHostname(hostname: string): Promise<string | null> {
    try {
      const hosts = await this.configParser.getHosts();
      for (const h of hosts) {
        if (h.hostName && h.hostName === hostname) return h.alias;
      }
    } catch {
      /* ignore — best-effort */
    }
    return null;
  }

  private openSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            'SFTP subsystem did not open within ' +
              `${SFTP_OPEN_TIMEOUT_MS / 1000}s. ` +
              'Authentication succeeded but the server is not exposing SFTP. ' +
              "Most common cause: the server's sshd_config is missing a " +
              '`Subsystem sftp …` line, or the account is in a restricted shell ' +
              '/ ChrootDirectory that blocks the SFTP subsystem. ' +
              'Verify with `sftp ' +
              (this.connectedHost ?? '<host>') +
              '` from your terminal — if that also hangs, fix the server config.'
          )
        );
      }, SFTP_OPEN_TIMEOUT_MS);

      client.sftp((err, channel) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }
        resolve(channel);
      });
    });
  }

  // ===========================================================================
  // Private: candidate building
  // ===========================================================================

  private async buildAuthCandidates(
    config: SshConnectionConfig,
    resolved: ResolvedSshHost | null,
    attempts: AuthAttempt[]
  ): Promise<AuthCandidate[]> {
    if (config.authMethod === 'password') {
      return [{ kind: 'password', password: config.password ?? '', label: 'password' }];
    }

    const candidates: AuthCandidate[] = [];
    const usedKeyPaths = new Set<string>();

    // An explicitly configured key is the user's stated intent, so it goes first.
    if (config.privateKeyPath?.trim()) {
      const keyPath = expandHome(config.privateKeyPath.trim());
      const loaded = await tryLoadKey(keyPath);
      if (loaded.kind === 'ok') {
        candidates.push({ kind: 'privateKey', data: loaded.data, label: `configured ${keyPath}` });
      } else {
        logger.warn(`Configured private key ${keyPath} skipped: ${loaded.reason}`);
        attempts.push({
          source: `configured ${keyPath}`,
          outcome: 'skipped',
          reason: loaded.reason,
        });
      }
      usedKeyPaths.add(keyPath);
    }

    // Agents — every accessible agent gets its own candidate. Many users have
    // both a system ssh-agent AND a 1Password agent, with the right key on
    // only one. Walking each in turn (within the same TCP/SSH session via
    // authHandler) is what `ssh` would do.
    for (const agentCandidate of await this.discoverAgentCandidates(resolved, attempts)) {
      candidates.push(agentCandidate);
    }

    // IdentityFile entries from ssh -G
    for (const keyPath of resolved?.identityFiles ?? []) {
      const loaded = await tryLoadKey(keyPath);
      if (loaded.kind === 'ok') {
        candidates.push({ kind: 'privateKey', data: loaded.data, label: keyPath });
        usedKeyPaths.add(keyPath);
      } else {
        attempts.push({ source: keyPath, outcome: 'skipped', reason: loaded.reason });
      }
    }

    // Default keys (only if not already covered by IdentityFile)
    const defaultKeys = [
      path.join(os.homedir(), '.ssh', 'id_ed25519'),
      path.join(os.homedir(), '.ssh', 'id_rsa'),
      path.join(os.homedir(), '.ssh', 'id_ecdsa'),
    ];
    for (const keyPath of defaultKeys) {
      if (usedKeyPaths.has(keyPath)) continue;
      const loaded = await tryLoadKey(keyPath);
      if (loaded.kind === 'ok') {
        candidates.push({ kind: 'privateKey', data: loaded.data, label: keyPath });
      }
      // Skip noisy diagnostics for missing default keys.
    }

    return candidates;
  }

  /**
   * Enumerates every accessible SSH agent socket.
   *
   * Order: IdentityAgent (from `ssh -G`) first, then SSH_AUTH_SOCK env, then
   * launchctl-published SSH_AUTH_SOCK (macOS GUI apps don't inherit shell
   * env), then 1Password's well-known sockets, then a few platform fallbacks.
   * De-duplicated by canonical path.
   */
  private async discoverAgentCandidates(
    resolved: ResolvedSshHost | null,
    attempts: AuthAttempt[]
  ): Promise<AuthCandidate[]> {
    const seen = new Set<string>();
    const out: AuthCandidate[] = [];

    const tryAdd = async (socket: string, label: string): Promise<void> => {
      if (seen.has(socket)) return;
      if (await pathExists(socket)) {
        seen.add(socket);
        out.push({ kind: 'agent', socket, label });
      }
    };

    if (resolved?.identityAgent) {
      const socket = resolved.identityAgent;
      if (await pathExists(socket)) {
        seen.add(socket);
        out.push({ kind: 'agent', socket, label: `IdentityAgent ${socket}` });
      } else {
        attempts.push({
          source: `IdentityAgent ${socket}`,
          outcome: 'skipped',
          reason: 'socket not accessible',
        });
      }
    }

    if (process.env.SSH_AUTH_SOCK) {
      await tryAdd(process.env.SSH_AUTH_SOCK, `SSH_AUTH_SOCK ${process.env.SSH_AUTH_SOCK}`);
    }

    // 1Password is checked BEFORE launchctl because launchctl typically
    // resolves to the empty system ssh-agent for users who actually keep
    // their keys in 1Password — querying the system agent first wastes a
    // round-trip on a guaranteed miss.
    const onePasswordPaths = [
      path.join(
        os.homedir(),
        'Library',
        'Group Containers',
        '2BUA8C4S2C.com.1password',
        't',
        'agent.sock'
      ),
      path.join(
        os.homedir(),
        'Library',
        'Group Containers',
        '2BUA8C4S2C.com.1password',
        'agent.sock'
      ),
      path.join(os.homedir(), '.1password', 'agent.sock'),
    ];
    for (const p of onePasswordPaths) {
      await tryAdd(p, `1Password agent ${p}`);
    }

    if (process.platform === 'darwin') {
      const launchSock = await getLaunchctlSshAuthSock();
      if (launchSock) {
        await tryAdd(launchSock, `launchctl agent ${launchSock}`);
      }
    }

    await tryAdd(path.join(os.homedir(), '.ssh', 'agent.sock'), 'user agent ~/.ssh/agent.sock');

    if (process.platform === 'linux') {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        await tryAdd(
          `/run/user/${uid}/ssh-agent.socket`,
          `systemd agent /run/user/${uid}/ssh-agent.socket`
        );
        await tryAdd(`/run/user/${uid}/keyring/ssh`, `gnome-keyring /run/user/${uid}/keyring/ssh`);
      }
    }

    if (out.length === 0) {
      attempts.push({
        source: 'ssh-agent',
        outcome: 'skipped',
        reason: 'no SSH_AUTH_SOCK and no known agent socket found',
      });
    }

    return out;
  }

  // ===========================================================================
  // Private: error handling, timeout, remote-path resolution
  // ===========================================================================

  private enrichAuthError(err: Error, attempts: AuthAttempt[], timings?: Timings): Error {
    const sections: string[] = [err.message];

    if (attempts.length > 0) {
      const lines = attempts.map((a) => {
        const detail = a.reason ? ` (${a.reason})` : '';
        return `  • ${a.source} — ${a.outcome}${detail}`;
      });
      sections.push(`Auth chain:\n${lines.join('\n')}`);
    }

    const timingReport = timings?.format();
    if (timingReport) {
      sections.push(`Timing:\n${timingReport}`);
    }

    if (sections.length === 1) return err;

    const enriched = new Error(sections.join('\n\n'));
    enriched.stack = err.stack;
    return enriched;
  }

  private async resolveRemoteProjectsPath(username: string): Promise<string> {
    const remoteHome = await this.resolveRemoteHomeDirectory();
    const candidates = [
      ...(remoteHome ? [path.posix.join(remoteHome, '.claude', 'projects')] : []),
      `/home/${username}/.claude/projects`,
      `/Users/${username}/.claude/projects`,
      `/root/.claude/projects`,
    ];

    for (const candidate of [...new Set(candidates)]) {
      if (await this.provider.exists(candidate)) {
        return candidate;
      }
    }

    if (remoteHome) {
      return path.posix.join(remoteHome, '.claude', 'projects');
    }

    return `/home/${username}/.claude/projects`;
  }

  private async resolveRemoteHomeDirectory(): Promise<string | null> {
    if (!this.client) return null;
    try {
      const home = await this.execRemoteCommand('printf %s "$HOME"');
      const normalized = home.trim();
      return normalized.startsWith('/') ? normalized : null;
    } catch {
      return null;
    }
  }

  private async execRemoteCommand(command: string): Promise<string> {
    const client = this.client;
    if (!client) {
      throw new Error('SSH client is not connected');
    }

    return new Promise<string>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        stream.stderr.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        stream.on('close', (code: number | null) => {
          if (code === 0) {
            resolve(stdout);
            return;
          }
          const exitCode = code === null ? 'unknown' : String(code);
          reject(new Error(stderr.trim() || `Remote command failed with exit code ${exitCode}`));
        });
      });
    });
  }

  private handleDisconnect(): void {
    if (this.state === 'disconnected') return;
    this.provider = this.localProvider;
    this.remoteProjectsPath = null;
    this.setState('disconnected');
  }

  private cleanup(): void {
    if (this.provider.type === 'ssh') {
      this.provider.dispose();
    }
    if (this.client) {
      try {
        this.client.end();
      } catch {
        /* ignore cleanup errors */
      }
      this.client = null;
    }
  }

  private setState(state: SshConnectionState): void {
    this.state = state;
    this.emit('state-change', this.getStatus());
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Records wall-clock duration of named steps, formatted as a diagnostic block. */
class Timings {
  private readonly steps: { name: string; ms: number }[] = [];
  private readonly active = new Map<string, number>();

  start(name: string): void {
    this.active.set(name, Date.now());
  }

  end(name: string): void {
    const t = this.active.get(name);
    if (t === undefined) return;
    this.active.delete(name);
    this.steps.push({ name, ms: Date.now() - t });
  }

  format(): string | null {
    // Include any in-flight step (the one that timed out).
    const all = [...this.steps];
    const now = Date.now();
    for (const [name, start] of this.active) {
      all.push({ name: `${name} (in-flight)`, ms: now - start });
    }
    if (all.length === 0) return null;
    return all.map((s) => `  • ${s.name}: ${s.ms}ms`).join('\n');
  }
}

function getLaunchctlSshAuthSock(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/bin/launchctl', ['getenv', 'SSH_AUTH_SOCK'], (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Raw TCP reachability probe. Distinguishes "Electron process can't reach
 * this host" (per-app VPN, broken routing) from "host rejects auth" — the
 * latter would otherwise present as a long ssh2 timeout with no clue why.
 */
function probeTcp(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ ok: false, reason: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve({ ok: true });
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message });
    });
  });
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

type LoadResult = { kind: 'ok'; data: string } | { kind: 'skip'; reason: string };

async function tryLoadKey(keyPath: string): Promise<LoadResult> {
  let data: string;
  try {
    data = await fs.promises.readFile(keyPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'skip', reason: 'not found' };
    return { kind: 'skip', reason: `unreadable (${code ?? 'unknown'})` };
  }

  if (isEncryptedPrivateKey(data)) {
    return {
      kind: 'skip',
      reason: 'encrypted; passphrases not supported, use ssh-agent',
    };
  }

  return { kind: 'ok', data };
}

/**
 * `ssh -G <unknown-host>` always emits the three default IdentityFile paths
 * (~/.ssh/id_rsa, id_dsa, id_ecdsa, id_ed25519, …). When that's all we got,
 * the user's input didn't match a Host block — we should look for an alias
 * whose HostName matches the input before giving up.
 */
function looksLikeOnlyDefaultKeys(identityFiles: string[]): boolean {
  const home = os.homedir();
  const defaults = new Set(
    ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_xmss', 'id_ecdsa_sk', 'id_ed25519_sk'].map(
      (name) => path.join(home, '.ssh', name)
    )
  );
  return identityFiles.every((f) => defaults.has(f));
}

/**
 * Detects passphrase-protected private keys. ssh2 cannot prompt for the
 * passphrase from a GUI process, so we must skip these and surface a clear
 * diagnostic — otherwise the connect hangs or fails opaquely.
 *
 * Covers PEM (`Proc-Type: 4,ENCRYPTED`), PKCS#8 (`BEGIN ENCRYPTED PRIVATE
 * KEY`), and OpenSSH format (cipher field non-`none` in the binary header).
 */
function isEncryptedPrivateKey(content: string): boolean {
  if (content.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----')) return true;
  if (content.includes('Proc-Type: 4,ENCRYPTED')) return true;

  const begin = '-----BEGIN OPENSSH PRIVATE KEY-----';
  const end = '-----END OPENSSH PRIVATE KEY-----';
  const beginIdx = content.indexOf(begin);
  if (beginIdx === -1) return false;
  const endIdx = content.indexOf(end, beginIdx + begin.length);
  if (endIdx === -1) return false;

  const body = content.slice(beginIdx + begin.length, endIdx).replace(/\s/g, '');
  let buf: Buffer;
  try {
    buf = Buffer.from(body, 'base64');
  } catch {
    return false;
  }
  const magic = 'openssh-key-v1\0';
  if (buf.length < magic.length + 4) return false;
  if (buf.subarray(0, magic.length).toString() !== magic) return false;
  const cipherLen = buf.readUInt32BE(magic.length);
  const cipher = buf.subarray(magic.length + 4, magic.length + 4 + cipherLen).toString();
  return cipher !== 'none';
}
