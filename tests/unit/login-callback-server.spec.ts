import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginWithBrowser, type BrowserLoginOptions } from '../../src/commands/login.js';

/**
 * The browser-callback server is where `clustercode login` finishes, and its
 * failure modes are invisible from the outside: the login succeeds, prints
 * "Logged in as ...", and then the command sits there until the user gives up
 * and hits Ctrl+C.
 *
 *   1. A browser leaves sockets open on the callback origin — a speculative
 *      preconnect that never sends a request, plus the keep-alive connection
 *      that carried the callback. server.close() stops the listener but does not
 *      touch either, and each one keeps the event loop alive.
 *   2. The timeout used to be armed after `await openUrl(...)`. A callback that
 *      landed first cleared a timer that did not exist yet, and the timer was
 *      then armed against an already-finished login — holding the process for
 *      the full timeout and then reporting failure for a login that succeeded.
 *
 * Every test is bounded: a regression here hangs rather than throws, and an
 * unbounded hang in CI reads as "stuck" instead of "broken".
 */

const TEST_TIMEOUT_MS = 15_000;

let tempHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalPortalUrl: string | undefined;
const openSockets: net.Socket[] = [];

const credentialsPath = () => join(tempHome, '.clustercode', 'credentials.json');
const workerConfigPath = () => join(tempHome, '.clustercode', 'worker.json');

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clustercode-login-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalPortalUrl = process.env.PORTAL_URL;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.PORTAL_URL = 'http://127.0.0.1:19998';
});

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalPortalUrl === undefined) delete process.env.PORTAL_URL;
  else process.env.PORTAL_URL = originalPortalUrl;
  rmSync(tempHome, { recursive: true, force: true });
});

function seedCredentials(email: string): void {
  mkdirSync(join(tempHome, '.clustercode'), { recursive: true });
  writeFileSync(
    credentialsPath(),
    JSON.stringify({ apiKey: 'csk_old_token', email, createdAt: new Date().toISOString() }),
  );
}

function seedWorkerConfig(): void {
  mkdirSync(join(tempHome, '.clustercode'), { recursive: true });
  writeFileSync(
    workerConfigPath(),
    JSON.stringify({
      workerId: 'worker-from-the-previous-account',
      tenantId: 'tenant-from-the-previous-account',
      tenantName: 'Previous Org',
      orchestratorUrl: 'wss://console.example.test/ws/worker',
    }),
  );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => { /* teardown races are expected on these sockets */ });
  openSockets.push(socket);
  await once(socket, 'connect');
  return socket;
}

/** Read from `socket` until `marker` arrives, so we see the whole response body. */
function readUntil(socket: net.Socket, marker: string, timeoutMs = 5_000): Promise<string> {
  let received = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`never received ${JSON.stringify(marker)} (got ${received.length} bytes)`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.toString('utf-8');
      if (received.includes(marker)) {
        cleanup();
        resolve(received);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`socket closed before ${JSON.stringify(marker)} (got ${received.length} bytes)`));
    };
    socket.on('data', onData);
    socket.on('close', onClose);
  });
}

/** Did `socket` get closed within `ms`? Bounded, so a leak fails instead of hanging. */
async function closedWithin(socket: net.Socket, ms: number): Promise<boolean> {
  if (socket.closed) return true;
  const timer = setTimeout(() => { /* resolved by the race below */ }, ms);
  try {
    return await Promise.race([
      once(socket, 'close').then(() => true),
      delay(ms).then(() => false),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface BrowserVisit {
  /** The speculative connection a browser opens and never sends anything on. */
  preconnect: net.Socket;
  /** The raw HTTP response to the callback request. */
  response: string;
}

/** Play the browser: preconnect like a real one, then deliver the callback. */
async function visitCallback(loginUrl: string, params: Record<string, string>): Promise<BrowserVisit> {
  const callbackUrl = new URL(new URL(loginUrl).searchParams.get('redirect_url')!);
  for (const [key, value] of Object.entries(params)) callbackUrl.searchParams.set(key, value);
  const port = Number(callbackUrl.port);

  const preconnect = await connect(port);
  const socket = await connect(port);
  socket.write(
    `GET ${callbackUrl.pathname}${callbackUrl.search} HTTP/1.1\r\n` +
      'Host: 127.0.0.1\r\n' +
      'Connection: keep-alive\r\n\r\n',
  );
  // The page goes out without a Content-Length, so it is chunked: read to the
  // terminating zero-length chunk rather than to the end of the HTML, otherwise
  // a truncated body still looks complete.
  const response = await readUntil(socket, '\r\n0\r\n\r\n');
  return { preconnect, response };
}

/**
 * Run a login against a scripted browser. The visit is captured separately
 * because the login resolves as soon as the callback is handled — before the
 * browser has finished reading the page back.
 */
async function login(
  params: Record<string, string>,
  options: BrowserLoginOptions & { lingerMs?: number } = {},
) {
  const { lingerMs, ...loginOptions } = options;
  let visit!: Promise<BrowserVisit>;
  const result = await loginWithBrowser({
    ...loginOptions,
    openUrl: async (loginUrl) => {
      visit = visitCallback(loginUrl, params);
      await visit;
      // Stand-in for `open` taking its time to resolve after the callback has
      // already landed — the window the stray timer used to be armed in.
      if (lingerMs) await delay(lingerMs);
    },
  });
  return { result, visit: await visit };
}

describe('browser login callback server', () => {
  it('serves the whole success page to the browser', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { result, visit } = await login({ api_key: 'csk_new_token', email: 'new@test.io' });

    assert.equal(result.success, true);
    assert.match(visit.response, /^HTTP\/1\.1 200/);
    assert.match(visit.response, /logged in/i);
    // Tearing the server down must not cut the page off mid-flight.
    assert.ok(visit.response.includes('<!DOCTYPE html>'), 'the success page never started');
    assert.ok(visit.response.includes('</html>'), 'the success page was truncated');
  });

  it('closes the sockets the browser left open, so the command can exit', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { result, visit } = await login({ api_key: 'csk_new_token', email: 'new@test.io' });

    assert.equal(result.success, true);
    assert.ok(
      await closedWithin(visit.preconnect, 3_000),
      'the speculative browser connection was left open; it holds the event loop and the ' +
      'CLI hangs after an otherwise successful login',
    );
  });

  it('does not report a timeout for a login that already succeeded', { timeout: TEST_TIMEOUT_MS }, async () => {
    // Tee rather than swallow: the test runner reports over this same stream.
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;

    try {
      const { result } = await login(
        { api_key: 'csk_new_token', email: 'new@test.io' },
        { timeoutMs: 250, lingerMs: 100 },
      );
      assert.equal(result.success, true);
      // Long enough for a timer armed after the callback landed to fire.
      await delay(600);
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.doesNotMatch(
      captured.join(''),
      /timed out/i,
      'a stray timeout was armed after the login finished: it holds the process open for the ' +
      'full timeout and then reports failure for a login that worked',
    );
  });

  it("drops the previous account's worker registration when a different user logs in", { timeout: TEST_TIMEOUT_MS }, async () => {
    seedCredentials('old@test.io');
    seedWorkerConfig();

    const { result } = await login({ api_key: 'csk_new_token', email: 'new@test.io' });

    assert.equal(result.success, true);
    assert.equal(result.switchedAccount, true);
    assert.equal(
      existsSync(workerConfigPath()),
      false,
      "worker.json still pairs the new credentials with the previous account's tenantId and " +
      'workerId, which the orchestrator rejects with a permanent 403',
    );
    assert.equal(JSON.parse(readFileSync(credentialsPath(), 'utf-8')).email, 'new@test.io');
  });

  it('keeps the worker registration when the same account logs in again', { timeout: TEST_TIMEOUT_MS }, async () => {
    seedCredentials('same@test.io');
    seedWorkerConfig();

    const { result } = await login({ api_key: 'csk_refreshed', email: 'same@test.io' });

    assert.equal(result.success, true);
    assert.equal(result.switchedAccount ?? false, false);
    assert.ok(
      existsSync(workerConfigPath()),
      're-authenticating as the same user must not re-register the machine',
    );
  });
});
