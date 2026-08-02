import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * The bug this guards is "the command never comes back": authentication
 * succeeds, the browser shows the success page, "Logged in as ..." is printed —
 * and then `clustercode login` sits there until the user hits Ctrl+C. Only a
 * whole-process test can catch that, because every individual step reports
 * success; what leaks is the handles the command leaves behind.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..', '..', '..');

/** Generous next to a healthy exit (milliseconds), far under the 3-minute hang. */
const EXIT_BUDGET_MS = 15_000;

let tempHome: string;
const openSockets: net.Socket[] = [];
let cli: ChildProcessWithoutNullStreams | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clustercode-login-e2e-'));
});

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  if (cli && cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
  cli = undefined;
  rmSync(tempHome, { recursive: true, force: true });
});

function startLogin(): ChildProcessWithoutNullStreams {
  const env = { ...process.env };
  env.HOME = tempHome;
  env.USERPROFILE = tempHome;
  env.NO_COLOR = '1';
  env.PORTAL_URL = 'http://127.0.0.1:19998';
  env.ORCHESTRATOR_URL = 'http://127.0.0.1:19999';
  // Print the URL instead of launching a real browser — this test is the browser.
  env.CLUSTERCODE_NO_OPEN_BROWSER = '1';
  // Defeat isHeadless(), which would otherwise divert a Linux CI run to the
  // paste-a-token path and never start the callback server at all.
  delete env.SSH_TTY;
  delete env.SSH_CONNECTION;
  env.DISPLAY = ':0';

  return spawn(
    process.execPath,
    ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), 'login'],
    { cwd: cliRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
}

/** Wait for the login URL the CLI prints, and pull the callback address out of it. */
function readCallbackUrl(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Promise<URL> {
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no login URL printed within ${timeoutMs}ms. Output so far:\n${output}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf-8');
      const match = output.match(/redirect_url=([^&\s]+)/);
      if (match) {
        cleanup();
        resolve(new URL(decodeURIComponent(match[1])));
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`CLI exited (code ${code}) before printing a login URL. Output:\n${output}`));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

async function connect(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => { /* teardown races are expected on these sockets */ });
  openSockets.push(socket);
  await once(socket, 'connect');
  return socket;
}

/** Deliver the callback the way a browser does: keep-alive, plus a preconnect. */
async function deliverCallback(callbackUrl: URL, params: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(params)) callbackUrl.searchParams.set(key, value);
  const port = Number(callbackUrl.port);

  await connect(port); // speculative connection: opened, never written to
  const socket = await connect(port);
  socket.write(
    `GET ${callbackUrl.pathname}${callbackUrl.search} HTTP/1.1\r\n` +
      'Host: 127.0.0.1\r\n' +
      'Connection: keep-alive\r\n\r\n',
  );
  await once(socket, 'data');
}

describe('clustercode login (browser flow, end to end)', () => {
  it('exits once the browser callback lands', { timeout: 90_000 }, async () => {
    cli = startLogin();
    const exited = once(cli, 'exit');

    const callbackUrl = await readCallbackUrl(cli);
    await deliverCallback(callbackUrl, { api_key: 'csk_e2e_token', email: 'e2e@test.io' });

    const outcome = await Promise.race([
      exited.then(([code]) => ({ exited: true, code: code as number | null })),
      new Promise<{ exited: false }>((resolve) =>
        setTimeout(() => resolve({ exited: false }), EXIT_BUDGET_MS),
      ),
    ]);

    assert.ok(
      outcome.exited,
      `login did not exit within ${EXIT_BUDGET_MS}ms of a successful callback — the sockets ` +
      'the browser left open, or a stray timeout, are still holding the process',
    );
    assert.equal((outcome as { code: number | null }).code, 0);

    const creds = JSON.parse(readFileSync(join(tempHome, '.clustercode', 'credentials.json'), 'utf-8'));
    assert.equal(creds.email, 'e2e@test.io');
    assert.equal(creds.apiKey, 'csk_e2e_token');
    assert.equal(existsSync(join(tempHome, '.clustercode', 'worker.json')), false);
  });
});
