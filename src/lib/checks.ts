import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { parse } from 'node:path';
import {
  readCredentials,
  readWorkerConfig,
  getOrchestratorUrl,
  getWorkerBinaryDir,
  getClusterCodeDir,
} from './config.js';
import { readInstalled } from './worker-binary.js';
import { augmentPathWithKnownEngineDirs, resolveExecutable } from './env-path.js';
import { checkRuntimeMemory, probeRuntime } from './runtime-memory.js';
import { checkHostMemory } from './host-memory.js';

export { checkRuntimeMemory, checkHostMemory };

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
  /**
   * Set by the container-runtime check when an engine is present on disk. Lets
   * callers distinguish "nothing installed" from "installed but not started",
   * which need different remediation.
   */
  engine?: { name: string; version: string };
}

function bytesToGB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

/**
 * Decode console output that may be UTF-16LE.
 *
 * Several Windows built-ins — wsl.exe among them — write UTF-16LE regardless of
 * the code page. Decoding that as utf-8 yields NUL-interleaved text ("W\0S\0L\0"),
 * which silently defeats every regex applied to it. Sniff the encoding instead of
 * assuming utf-8.
 */
export function decodeConsoleOutput(buf: Buffer): string {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    // Latin-script text encoded as UTF-16LE has a NUL in every odd byte position.
    let sampled = 0;
    let nulAtOddIndex = 0;
    for (let i = 1; i < Math.min(buf.length, 64); i += 2) {
      sampled++;
      if (buf[i] === 0) nulAtOddIndex++;
    }
    if (sampled > 0 && nulAtOddIndex / sampled > 0.8) return buf.toString('utf16le');
  }
  return buf.toString('utf-8');
}

function execSilent(cmd: string): string | null {
  try {
    // No `encoding` option, so this returns a Buffer we can decode ourselves.
    return decodeConsoleOutput(execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] })).trim();
  } catch {
    return null;
  }
}

/**
 * Run a probe, keeping whatever it wrote to stderr on failure.
 *
 * `execSilent` throws the reason away, which is fine for "is this installed"
 * but not for `docker info`: a daemon that is down and a daemon the current
 * user is not permitted to reach both fail, and they need opposite advice.
 */
function execProbe(cmd: string): { ok: boolean; stderr: string } {
  try {
    execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (err) {
    const e = err as { stderr?: Buffer | string };
    const raw = e.stderr;
    const stderr = raw === undefined ? '' : typeof raw === 'string' ? raw : decodeConsoleOutput(raw);
    return { ok: false, stderr };
  }
}

/**
 * Did this fail because the user is not in the `docker` group?
 *
 * A fresh Linux Docker install adds the user to that group, but group
 * membership is only read at login, so `docker info` in the very session that
 * ran the install is refused. Without this distinction the wizard reports
 * "found but not running" and sends the user to `systemctl start docker` —
 * which is already running — so they follow that advice forever and never
 * learn that a re-login is the actual fix.
 */
export function isSocketPermissionError(stderr: string): boolean {
  return /permission denied/i.test(stderr) && /docker\.sock|dial unix|connect/i.test(stderr);
}

/** Detail text for an engine that is running but unreachable by this user. */
/**
 * The phrase both "running, but you cannot reach it" details share, and the one
 * `checkRuntimeMemory` matches on to tell a denied engine from a stopped one.
 *
 * A function rather than a `const` because checks.ts and runtime-memory.ts
 * import each other: whichever module the process enters first leaves the
 * other's top-level bindings in the temporal dead zone, and a `const` read
 * across that cycle throws. Function declarations are hoisted, so this one is
 * callable from either entry order.
 */
export function socketDeniedPhrase(): string {
  return 'not permitted for this user';
}

export const DOCKER_GROUP_PENDING =
  `${socketDeniedPhrase()} — log out and back in to pick up the \`docker\` group`;

/**
 * The same symptom on any other engine.
 *
 * Only Docker's install puts the user in a group, so only Docker's failure is
 * cured by logging out. Rootless Podman has no `docker` group to join: a denied
 * socket there means something else entirely (a rootful socket, a stale
 * CONTAINER_HOST), and sending that user to `newgrp docker` is advice for a
 * different product.
 */
export const SOCKET_NOT_PERMITTED = `running, but its socket is ${socketDeniedPhrase()}`;

export function checkAuth(): CheckResult {
  const creds = readCredentials();
  if (!creds) {
    return { name: 'auth', status: 'fail', detail: 'Not logged in' };
  }
  return { name: 'auth', status: 'pass', detail: `Logged in as ${creds.email}` };
}

export function checkWorkerRegistration(): CheckResult {
  const worker = readWorkerConfig();
  if (!worker) {
    // Status only, no remediation: onboarding prints the fix for each remaining
    // failure, and embedding "run clustercode worker" here made onboard tell the
    // user to run a different command while it was already fixing this.
    return { name: 'worker', status: 'fail', detail: 'Worker not configured' };
  }
  return {
    name: 'worker',
    status: 'pass',
    detail: `Registered (${worker.tenantName})`,
  };
}

export function checkWorkerBinary(): CheckResult {
  const installed = readInstalled(getWorkerBinaryDir());
  if (!installed) {
    return {
      name: 'worker-binary',
      status: 'warn',
      detail: 'Worker binary not downloaded yet (fetched on first run)',
    };
  }
  return { name: 'worker-binary', status: 'pass', detail: `Worker binary ${installed.version}` };
}

export async function checkOrchestratorConnectivity(): Promise<CheckResult> {
  const url = getOrchestratorUrl();
  const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws\/worker$/, '');
  const healthUrl = `${httpUrl}/api/health`;

  try {
    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS ?? '5000', 10);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const host = new URL(httpUrl).host;
      return { name: 'orchestrator', status: 'pass', detail: `Reachable (${host})` };
    }
    return { name: 'orchestrator', status: 'fail', detail: `Health check returned ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { name: 'orchestrator', status: 'fail', detail: `Cannot reach orchestrator: ${message}` };
  }
}

interface DetectedEngine {
  name: string;
  path: string;
  version: string;
}

/** Every engine present on this machine, in preference order (Podman first). */
function detectContainerEngines(): DetectedEngine[] {
  // An engine installed after this shell started is absent from the inherited
  // PATH, which would otherwise make every doctor run report "not found" for an
  // engine that is sitting on disk. Cheap filesystem probe, memoized.
  augmentPathWithKnownEngineDirs();

  const found: DetectedEngine[] = [];
  for (const engine of ['podman', 'docker']) {
    const version = execSilent(`${engine} --version`);
    if (version) {
      const path = resolveExecutable(engine) ?? engine;
      const versionMatch = version.match(/(\d+\.\d+\.\d+)/);
      found.push({ name: engine, path, version: versionMatch?.[1] ?? version });
    }
  }
  return found;
}

/**
 * Render the WSL check's detail line.
 *
 * The version can legitimately be unparseable — localized output, or a build that
 * omits the line. When that happens, say "available" rather than gluing the "v"
 * prefix onto a placeholder, which is what produced "WSL2 vdetected".
 */
export function formatWslDetail(versionOutput: string | null): string {
  // `wsl --version` reports four components (e.g. 2.3.26.0), so match one-or-more
  // dotted parts rather than exactly three and truncating the last one.
  const versionMatch = versionOutput?.match(/WSL.*?:\s*(\d+(?:\.\d+)+)/i);
  return versionMatch ? `WSL2 v${versionMatch[1]}` : 'WSL2 available';
}

export function checkWsl(): CheckResult | null {
  // Only relevant on Windows
  if (process.platform !== 'win32') return null;

  const wslOutput = execSilent('wsl --status');
  if (wslOutput) {
    return { name: 'wsl', status: 'pass', detail: formatWslDetail(execSilent('wsl --version')) };
  }

  // wsl --status failed — check if wsl.exe exists at all
  const wslExists = execSilent('where wsl');
  if (!wslExists) {
    return { name: 'wsl', status: 'fail', detail: 'WSL2 not installed (required for Podman on Windows)' };
  }

  // wsl exists but no distro installed
  const distros = execSilent('wsl --list --quiet');
  if (!distros || distros.trim() === '') {
    return { name: 'wsl', status: 'fail', detail: 'WSL2 installed but no Linux distro configured' };
  }

  return { name: 'wsl', status: 'pass', detail: 'WSL2 available' };
}

function isPodmanMachineRunning(): boolean {
  const output = execSilent('podman machine list --format "{{.Running}}"');
  if (!output) return false;
  // Each line is a machine's running status; check if any is "true"
  return output.split(/\r?\n/).some((line) => line.trim().toLowerCase() === 'true');
}

/** Is this specific engine actually able to run containers right now? */
function evaluateEngine(engine: DetectedEngine): CheckResult {
  // Deliberately excludes the resolved filesystem path: CheckResult is serialized
  // verbatim into `doctor --json`, and a per-user install path embeds the local
  // username. Callers that need the path resolve it themselves.
  const engineInfo = { name: engine.name, version: engine.version };
  const label = `${engine.name} v${engine.version}`;

  // For Podman on macOS/Windows, check machine status directly since `podman info`
  // can exit non-zero even when a machine is running (socket connection issues).
  const needsMachine = engine.name === 'podman' && (process.platform === 'darwin' || process.platform === 'win32');
  if (needsMachine) {
    return isPodmanMachineRunning()
      ? { name: 'container-runtime', status: 'pass', detail: label, engine: engineInfo }
      : {
          name: 'container-runtime',
          status: 'fail',
          // Status only — onboarding prints the start commands as this check's remediation.
          detail: `${label} found but not running`,
          engine: engineInfo,
        };
  }

  const probe = execProbe(`${engine.name} info`);
  if (probe.ok) {
    return { name: 'container-runtime', status: 'pass', detail: label, engine: engineInfo };
  }

  return {
    name: 'container-runtime',
    status: 'fail',
    detail: !isSocketPermissionError(probe.stderr)
      ? `${label} found but not running`
      : engine.name === 'docker'
        ? `${label} is running, but ${DOCKER_GROUP_PENDING}`
        : `${label} is ${SOCKET_NOT_PERMITTED}`,
    engine: engineInfo,
  };
}

export function checkContainerRuntime(): CheckResult {
  const engines = detectContainerEngines();
  if (engines.length === 0) {
    return { name: 'container-runtime', status: 'fail', detail: 'Podman or Docker not found' };
  }

  // Report a WORKING engine if any exists, rather than the first one installed.
  // Podman installed with its machine stopped alongside a running Docker used to
  // report a failure and — once `worker` gained a runtime preflight — refuse to
  // start, even though the machine had a perfectly usable engine.
  const results = engines.map(evaluateEngine);
  return results.find((r) => r.status === 'pass') ?? results[0];
}

/** Container images and the worker binary land under ~/.clustercode, so measure the volume that holds it — not always C:. */
function diskCheckTarget(): string {
  const dir = getClusterCodeDir();
  // The directory may not exist before the first login; fall back to its parent.
  return existsSync(dir) ? dir : homedir();
}

const MIN_DISK_GB = 20;

/** Grade a free-space reading. Exported for tests. */
export function evaluateDisk(freeBytes: number, location: string): CheckResult {
  const freeGB = freeBytes / 1024 / 1024 / 1024;
  const detail = `Disk: ${freeGB.toFixed(1)}GB free on ${location}`;
  if (freeGB < MIN_DISK_GB) {
    return { name: 'disk', status: 'warn', detail: `${detail} (${MIN_DISK_GB}GB+ recommended for container images)` };
  }
  return { name: 'disk', status: 'pass', detail };
}

/**
 * Parse the data line of `df -Pk <path>` output into available bytes and the
 * mount point. Anchors on the three numeric block fields plus the capacity
 * percentage rather than splitting on whitespace at fixed indexes: a device
 * name containing spaces (e.g. macOS's "map auto_home") shifts every
 * whitespace-split field, and a mount point containing spaces would otherwise
 * be truncated at its first word. Exported for tests.
 */
export function parseDfLine(line: string): { availBytes: number; mount: string } | null {
  const match = line.match(/\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/);
  if (!match) return null;
  return { availBytes: parseInt(match[3], 10) * 1024, mount: match[4].trim() };
}

export function checkDiskSpace(): CheckResult {
  const target = diskCheckTarget();

  if (process.platform === 'win32') {
    // Get-PSDrive takes a drive letter, so a UNC home directory can't be measured.
    const driveLetter = parse(target).root.match(/^([A-Za-z]):/)?.[1];
    if (!driveLetter) {
      return { name: 'disk', status: 'warn', detail: `Could not determine free space for ${target}` };
    }
    // PowerShell rather than WMIC, which is deprecated on newer Windows.
    const output = execSilent(
      `powershell -NoProfile -Command "(Get-PSDrive ${driveLetter.toUpperCase()}).Free"`,
    );
    const freeBytes = output ? parseInt(output.trim(), 10) : NaN;
    if (!isNaN(freeBytes)) {
      return evaluateDisk(freeBytes, `${driveLetter.toUpperCase()}:`);
    }
  } else if (!target.includes("'")) {
    // Single quotes so the shell treats the path literally — inside double
    // quotes, `$(...)`, backticks, and `$var` in a home directory path would be
    // expanded (and executed) by /bin/sh. A path containing a single quote
    // (excluded above) falls through to the "could not determine" warning.
    // -P forces single-line output, so a long device name cannot wrap the line.
    const output = execSilent(`df -Pk '${target}' | tail -1`);
    const parsed = output ? parseDfLine(output) : null;
    if (parsed) {
      return evaluateDisk(parsed.availBytes, parsed.mount);
    }
  }

  return { name: 'disk', status: 'warn', detail: `Could not determine free space for ${target}` };
}

const MIN_TOTAL_MEMORY_GB = 8;

/**
 * Grade installed RAM. Deliberately reports *total*, not free: os.freemem()
 * excludes reclaimable cache, so it swings wildly and made a 4GB machine pass
 * while a well-provisioned one under load looked unhealthy. Exported for tests.
 */
export function evaluateMemory(totalBytes: number): CheckResult {
  if (totalBytes / 1024 / 1024 / 1024 < MIN_TOTAL_MEMORY_GB) {
    return {
      name: 'memory',
      status: 'warn',
      detail: `RAM: ${bytesToGB(totalBytes)}GB total (${MIN_TOTAL_MEMORY_GB}GB+ recommended)`,
    };
  }
  return { name: 'memory', status: 'pass', detail: `RAM: ${bytesToGB(totalBytes)}GB total` };
}

export function checkMemory(): CheckResult {
  return evaluateMemory(totalmem());
}

export async function runAllChecks(): Promise<CheckResult[]> {
  const orchestratorCheck = await checkOrchestratorConnectivity();
  const wslCheck = checkWsl();

  const results: CheckResult[] = [
    checkAuth(),
    checkWorkerRegistration(),
    checkWorkerBinary(),
    orchestratorCheck,
  ];

  // WSL2 check only on Windows (before container runtime, since it's a prerequisite)
  if (wslCheck) {
    results.push(wslCheck);
  }

  const containerRuntime = checkContainerRuntime();
  // One round of probing for both memory checks: each is a process spawn, and
  // they are slow enough on Windows to matter to a command run this often.
  const runtimeProbe = probeRuntime(containerRuntime);

  results.push(
    containerRuntime,
    checkRuntimeMemory(containerRuntime, runtimeProbe),
    // Immediately after it, deliberately: one line says what the runtime was
    // promised and the next says what the host actually has left. Whether the
    // reserve between them is real is the whole question.
    checkHostMemory(containerRuntime, runtimeProbe),
    checkDiskSpace(),
    checkMemory(),
  );

  return results;
}
