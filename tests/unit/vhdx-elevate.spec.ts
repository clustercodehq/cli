import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  elevateCompact,
  elevationFiles,
  ELEVATION_DECLINED_EXIT,
  ELEVATION_UNAVAILABLE_EXIT,
  type ElevationDeps,
} from '../../src/lib/vhdx-compact.js';
import type { ProcessResult } from '../../src/lib/run-process.js';

const DIR = 'C:\\Users\\Zoë\\AppData\\Local\\Temp\\clustercode-compact-x';
const FILES = elevationFiles(DIR);
const DISKPART_PATH = 'C:\\Users\\Zoë\\.local\\share\\containers\\podman\\machine\\wsl\\wsldist\\dev\\ext4.vhdx';

const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

interface FakeElevation {
  /** Files the "elevated side" leaves behind once the launcher returns. */
  leaves?: Record<string, Buffer>;
  /** Files that appear only after this many polls. */
  laterAfterPolls?: { polls: number; files: Record<string, Buffer> };
  launched?: Partial<ProcessResult>;
  launchThrows?: boolean;
}

function fakeDeps(opts: FakeElevation = {}) {
  const files = new Map<string, Buffer>();
  const log: string[] = [];
  const launches: Array<{ args: string[]; timeoutMs: number }> = [];
  let t = 0;
  let polls = 0;
  const deps: ElevationDeps = {
    makeTempDir: () => (log.push('mkdtemp'), DIR),
    writeFile: (path, data) => {
      log.push(`write ${path}`);
      files.set(path, data);
    },
    readFile: (path) => files.get(path) ?? null,
    removeDir: (path) => {
      log.push(`rm ${path}`);
      for (const key of [...files.keys()]) if (key.startsWith(path)) files.delete(key);
    },
    launch: async (args, timeoutMs) => {
      launches.push({ args, timeoutMs });
      log.push('launch');
      if (opts.launchThrows) throw new Error('spawn failed');
      for (const [path, data] of Object.entries(opts.leaves ?? {})) files.set(path, data);
      return { code: 0, stdout: '', output: '', timedOut: false, ...opts.launched };
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      polls++;
      if (opts.laterAfterPolls && polls === opts.laterAfterPolls.polls) {
        for (const [path, data] of Object.entries(opts.laterAfterPolls.files)) files.set(path, data);
      }
    },
  };
  return { deps, files, log, launches };
}

const ran = (rc: string, compactLog = 'DiskPart successfully compacted the virtual disk file.') => ({
  [FILES.started]: Buffer.from('started\r\n'),
  [FILES.compactLog]: utf16(compactLog),
  [FILES.done]: Buffer.from(`${rc}\r\n`),
});

const TIMING = { timeoutMs: 60_000, pollMs: 2_000 };

describe('elevateCompact', () => {
  it('writes only the runner script, as UTF-8 with a BOM, keeping a non-ASCII path intact', async () => {
    const { deps, log } = fakeDeps({ leaves: ran('0') });
    await elevateCompact(DISKPART_PATH, deps, TIMING);
    const writes = log.filter((l) => l.startsWith('write '));
    // The diskpart scripts are written by the elevated side, in the OEM code page.
    assert.deepEqual(writes, [`write ${FILES.runScript}`]);
  });

  it('runs the runner script it wrote', async () => {
    let script: Buffer | undefined;
    const { deps, launches } = fakeDeps({ leaves: ran('0') });
    const write = deps.writeFile;
    deps.writeFile = (path, data) => {
      script = data;
      write(path, data);
    };
    await elevateCompact(DISKPART_PATH, deps, TIMING);

    assert.ok(script);
    assert.deepEqual([...script.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = script.subarray(3).toString('utf8');
    assert.ok(text.includes(`'select vdisk file="${DISKPART_PATH}"'`), text);
    assert.match(text, /-Encoding OEM/);

    assert.equal(launches.length, 1);
    const { args } = launches[0];
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    const launcher = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.ok(launcher.includes(`'"${FILES.runScript}"'`), launcher);
    assert.match(launcher, /-Verb RunAs/);
    assert.ok(launches[0].timeoutMs > 0 && launches[0].timeoutMs <= TIMING.timeoutMs);
  });

  it('reads success from the elevated side, decoding its UTF-16 log', async () => {
    const { deps } = fakeDeps({ leaves: ran('0') });
    assert.deepEqual(await elevateCompact(DISKPART_PATH, deps, TIMING), { kind: 'ok' });
  });

  it("uses diskpart's exit code, not the launcher's", async () => {
    const { deps } = fakeDeps({
      leaves: ran('5', 'DiskPart has encountered an error: The process cannot access the file.'),
      launched: { code: 0 },
    });
    const r = await elevateCompact(DISKPART_PATH, deps, TIMING);
    assert.ok(r.kind === 'failed' && r.exitCode === 5, JSON.stringify(r));
    assert.ok(r.kind === 'failed' && /cannot access the file/.test(r.logTail));
  });

  it('maps a declined or unavailable prompt when the elevated side never started', async () => {
    const declined = fakeDeps({ launched: { code: ELEVATION_DECLINED_EXIT } });
    assert.deepEqual(await elevateCompact(DISKPART_PATH, declined.deps, TIMING), { kind: 'declined' });
    const unavailable = fakeDeps({ launched: { code: ELEVATION_UNAVAILABLE_EXIT } });
    assert.deepEqual(await elevateCompact(DISKPART_PATH, unavailable.deps, TIMING), { kind: 'unavailable' });
  });

  it("shows the launcher's own error, without PowerShell's CLIXML noise, when nothing started", async () => {
    const { deps } = fakeDeps({
      launched: {
        code: 1,
        output: '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress"/></Objs>\r\nStart-Process : This command cannot be run.\r\n',
      },
    });
    const r = await elevateCompact(DISKPART_PATH, deps, TIMING);
    assert.ok(r.kind === 'failed', JSON.stringify(r));
    assert.ok(r.kind === 'failed' && r.logTail === 'Start-Process : This command cannot be run.', r.kind === 'failed' ? r.logTail : '');
  });

  it('waits for the elevated side when the launcher returns first (for example after Ctrl+C)', async () => {
    const { deps } = fakeDeps({
      leaves: { [FILES.started]: Buffer.from('started') },
      launched: { code: null },
      laterAfterPolls: { polls: 3, files: { [FILES.compactLog]: utf16('DiskPart successfully compacted'), [FILES.done]: Buffer.from('0') } },
    });
    assert.deepEqual(await elevateCompact(DISKPART_PATH, deps, TIMING), { kind: 'ok' });
  });

  it('gives up at the deadline when the elevated side never finishes, saying so', async () => {
    const { deps } = fakeDeps({ leaves: { [FILES.started]: Buffer.from('started') }, launched: { code: null, timedOut: true } });
    const r = await elevateCompact(DISKPART_PATH, deps, TIMING);
    assert.ok(r.kind === 'failed' && r.exitCode === null, JSON.stringify(r));
    assert.ok(r.kind === 'failed' && /did not finish within/.test(r.logTail));
  });

  it('reports a prompt nobody answered in time', async () => {
    const { deps } = fakeDeps({ launched: { code: null, timedOut: true } });
    const r = await elevateCompact(DISKPART_PATH, deps, TIMING);
    assert.ok(r.kind === 'failed' && /approval/.test(r.logTail), JSON.stringify(r));
  });

  it('removes the temporary folder on every path, even when the launch throws', async () => {
    const ok = fakeDeps({ leaves: ran('0') });
    await elevateCompact(DISKPART_PATH, ok.deps, TIMING);
    assert.equal(ok.log.at(-1), `rm ${DIR}`);

    const thrown = fakeDeps({ launchThrows: true });
    const r = await elevateCompact(DISKPART_PATH, thrown.deps, TIMING);
    assert.equal(r.kind, 'failed');
    assert.equal(thrown.log.at(-1), `rm ${DIR}`);
  });

  it('fails cleanly when the temporary folder cannot be created', async () => {
    const { deps, launches } = fakeDeps();
    deps.makeTempDir = () => {
      throw new Error('disk full');
    };
    const r = await elevateCompact(DISKPART_PATH, deps, TIMING);
    assert.ok(r.kind === 'failed' && /disk full/.test(r.logTail));
    assert.equal(launches.length, 0);
  });
});
