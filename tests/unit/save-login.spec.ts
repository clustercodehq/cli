import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveLogin, readCredentials, readWorkerConfig, readAppConfig } from '../../src/lib/config.js';

/**
 * worker.json binds a workerId and a tenantId to the account that registered
 * them, and logging in rewrites credentials.json only. Log in as someone else
 * and the worker connects with the new API key but the previous account's
 * tenantId/workerId — a pair the orchestrator rejects with a permanent HTTP 403,
 * which the CLI never noticed because tenant setup short-circuits as soon as
 * worker.json names a tenant. saveLogin is the one place that can see the
 * account change, so it is the one place that can invalidate the binding.
 */

let tempHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

const configDir = () => join(tempHome, '.clustercode');
const workerConfigPath = () => join(configDir(), 'worker.json');

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clustercode-save-login-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(tempHome, { recursive: true, force: true });
});

function seed(files: { credentials?: string; worker?: boolean; appConfig?: boolean }): void {
  mkdirSync(configDir(), { recursive: true });
  if (files.credentials !== undefined) {
    writeFileSync(
      join(configDir(), 'credentials.json'),
      JSON.stringify({ apiKey: 'csk_old', email: files.credentials, createdAt: '2026-01-01T00:00:00.000Z' }),
    );
  }
  if (files.worker) {
    writeFileSync(
      workerConfigPath(),
      JSON.stringify({
        workerId: 'previous-worker-id',
        tenantId: 'previous-tenant-id',
        tenantName: 'Previous Org',
        orchestratorUrl: 'wss://console.example.test/ws/worker',
      }),
    );
  }
  if (files.appConfig) {
    writeFileSync(join(configDir(), 'config.json'), JSON.stringify({ WORKER_NAME: 'my-laptop' }));
  }
}

const login = (email: string) =>
  saveLogin({ apiKey: 'csk_new', email, createdAt: '2026-08-02T00:00:00.000Z' });

describe('saveLogin', () => {
  it('drops the worker registration when a different account logs in', () => {
    seed({ credentials: 'old@test.io', worker: true });

    const { switchedAccount } = login('new@test.io');

    assert.equal(switchedAccount, true);
    assert.equal(existsSync(workerConfigPath()), false);
    assert.equal(readCredentials()?.email, 'new@test.io');
  });

  it('keeps the worker registration when the same account logs in again', () => {
    seed({ credentials: 'same@test.io', worker: true });

    const { switchedAccount } = login('same@test.io');

    assert.equal(switchedAccount, false);
    assert.equal(readWorkerConfig()?.workerId, 'previous-worker-id');
    assert.equal(readCredentials()?.apiKey, 'csk_new', 'the refreshed key should still be stored');
  });

  it('treats the same address as the same account regardless of case or padding', () => {
    seed({ credentials: 'Sam@Test.io', worker: true });

    const { switchedAccount } = saveLogin({
      apiKey: 'csk_new',
      email: '  sam@test.io ',
      createdAt: '2026-08-02T00:00:00.000Z',
    });

    assert.equal(switchedAccount, false);
    assert.ok(existsSync(workerConfigPath()), 'a re-login must not re-register the machine');
  });

  it('has nothing to switch away from on a first login', () => {
    const { switchedAccount } = login('first@test.io');

    assert.equal(switchedAccount, false);
    assert.equal(readCredentials()?.email, 'first@test.io');
  });

  it('survives an account switch with no worker registration on disk', () => {
    seed({ credentials: 'old@test.io' });

    assert.doesNotThrow(() => login('new@test.io'));
    assert.equal(readCredentials()?.email, 'new@test.io');
  });

  it('drops a registration it cannot attribute to an account', () => {
    // Credentials are read back as unvalidated JSON. A record with no usable
    // email cannot vouch for the registration sitting next to it, and this runs
    // on the path a user takes to recover from exactly that kind of mess.
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), 'credentials.json'), JSON.stringify({ apiKey: 'csk_old' }));
    seed({ worker: true });

    const { switchedAccount } = login('new@test.io');

    assert.equal(switchedAccount, true);
    assert.equal(existsSync(workerConfigPath()), false);
  });

  it('leaves machine-level settings alone — they are not account-bound', () => {
    seed({ credentials: 'old@test.io', worker: true, appConfig: true });

    login('new@test.io');

    assert.equal(readAppConfig().WORKER_NAME, 'my-laptop');
  });
});
