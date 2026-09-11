import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMachineList,
  parseMachineEntries,
  describeMachineChoice,
  wslDistroCandidates,
  parseLxssJson,
  parseDfUsed,
  parseExt4Overhead,
  describeMeasuredReading,
  parseGuestUsage,
  vhdxPathFor,
  driveLetterOf,
  MACHINE_LIST_FORMAT,
  GUEST_USAGE_SCRIPT,
  machineSshArgs,
  discoverPodmanVhdx,
  measureGuestUsed,
  readVhdx,
} from '../../src/lib/vhdx.js';
import { POWERSHELL_PROBE_TIMEOUT_MS } from '../../src/lib/checks.js';

describe('parseMachineList', () => {
  it('strips the default marker podman appends to the name', () => {
    const m = parseMachineList('podman-machine-default*|wsl|true|true\n');
    assert.deepEqual(m, { name: 'podman-machine-default', vmType: 'wsl', running: true, isDefault: true });
  });

  it('prefers the default machine over the first one listed', () => {
    const m = parseMachineList('first|wsl|false|false\r\nsecond*|wsl|true|true\r\n');
    assert.equal(m?.name, 'second');
  });

  it('falls back to the first machine when none is marked default', () => {
    const m = parseMachineList('alpha|wsl|false|false\nbeta|hyperv|true|false\n');
    assert.equal(m?.name, 'alpha');
    assert.equal(m?.running, false);
  });

  it('lists every machine, for saying which one was chosen', () => {
    assert.deepEqual(
      parseMachineEntries('first|wsl|false|false\r\nsecond*|wsl|true|true\r\nNAME VM TYPE\r\n').map((m) => m.name),
      ['first', 'second'],
    );
  });

  it('returns null for empty or unparseable output', () => {
    assert.equal(parseMachineList(''), null);
    assert.equal(parseMachineList('\r\n'), null);
    assert.equal(parseMachineList('NAME VM TYPE'), null);
  });

  it('asks podman for exactly the fields it parses', () => {
    assert.equal(MACHINE_LIST_FORMAT, '{{.Name}}|{{.VMType}}|{{.Running}}|{{.Default}}');
  });
});

describe('wslDistroCandidates', () => {
  it('tries the machine name and the podman-prefixed name', () => {
    assert.deepEqual(wslDistroCandidates('dev'), ['dev', 'podman-dev']);
  });

  it('keeps the exact machine name first, even when it is already prefixed', () => {
    assert.deepEqual(wslDistroCandidates('podman-machine-default'), [
      'podman-machine-default',
      'podman-podman-machine-default',
    ]);
  });
});

const PODMAN_BASE = 'C:\\Users\\someone\\.local\\share\\containers\\podman\\machine\\wsl\\wsldist\\podman-machine-default';

describe('parseLxssJson', () => {
  it('finds the distro in an array of registrations', () => {
    const json = JSON.stringify([
      { DistributionName: 'docker-desktop-data', BasePath: 'C:\\Users\\someone\\AppData\\Local\\Docker\\wsl\\data' },
      { DistributionName: 'podman-machine-default', BasePath: PODMAN_BASE },
      { DistributionName: 'Ubuntu-24.04', BasePath: 'C:\\Users\\someone\\AppData\\Local\\wsl\\{guid}' },
    ]);
    assert.deepEqual(parseLxssJson(json, ['podman-machine-default']), {
      distro: 'podman-machine-default',
      basePath: PODMAN_BASE,
    });
  });

  it('accepts the single object ConvertTo-Json emits for one registration', () => {
    const json = JSON.stringify({ DistributionName: 'podman-dev', BasePath: 'D:\\wsl\\dev' });
    assert.deepEqual(parseLxssJson(json, ['dev', 'podman-dev']), { distro: 'podman-dev', basePath: 'D:\\wsl\\dev' });
  });

  it('strips the \\\\?\\ long-path prefix', () => {
    const json = JSON.stringify({ DistributionName: 'dev', BasePath: '\\\\?\\D:\\wsl\\dev' });
    assert.equal(parseLxssJson(json, ['dev'])?.basePath, 'D:\\wsl\\dev');
  });

  it('prefers the earlier candidate when both are registered', () => {
    const json = JSON.stringify([
      { DistributionName: 'podman-dev', BasePath: 'D:\\b' },
      { DistributionName: 'dev', BasePath: 'D:\\a' },
    ]);
    assert.equal(parseLxssJson(json, ['dev', 'podman-dev'])?.basePath, 'D:\\a');
  });

  it('matches distro names case-insensitively, as WSL does', () => {
    const json = JSON.stringify({ DistributionName: 'Podman-Dev', BasePath: 'D:\\a' });
    assert.equal(parseLxssJson(json, ['podman-dev'])?.distro, 'Podman-Dev');
  });

  it('returns null when nothing matches or the output is not JSON', () => {
    assert.equal(parseLxssJson(JSON.stringify({ DistributionName: 'Ubuntu', BasePath: 'C:\\x' }), ['dev']), null);
    assert.equal(parseLxssJson('', ['dev']), null);
    assert.equal(parseLxssJson('not json', ['dev']), null);
    assert.equal(parseLxssJson(JSON.stringify({ DistributionName: 'dev' }), ['dev']), null);
  });
});

describe('parseDfUsed', () => {
  it('reads the used bytes below the header', () => {
    assert.equal(parseDfUsed('         Used\n31124340736\n'), 31124340736);
  });

  it('reads a bare number', () => {
    assert.equal(parseDfUsed('31124340736\r\n'), 31124340736);
  });

  it('returns null when there is no number', () => {
    assert.equal(parseDfUsed(''), null);
    assert.equal(parseDfUsed('df: /: No such file or directory'), null);
  });
});

/** A 1024-byte ext4 superblock as `od -An -v -t u1` prints it, with the given fields set. */
function superblock(fields: { u16?: Record<number, number>; u32?: Record<number, number>; u8?: Record<number, number> }): string {
  const b = new Array<number>(1024).fill(0);
  for (const [o, v] of Object.entries(fields.u8 ?? {})) b[Number(o)] = v;
  for (const [o, v] of Object.entries(fields.u16 ?? {})) {
    b[Number(o)] = v & 0xff;
    b[Number(o) + 1] = (v >>> 8) & 0xff;
  }
  for (const [o, v] of Object.entries(fields.u32 ?? {})) {
    for (let i = 0; i < 4; i++) b[Number(o) + i] = Math.floor(v / 256 ** i) % 256;
  }
  const rows: string[] = [];
  for (let i = 0; i < 1024; i += 16) rows.push(' ' + b.slice(i, i + 16).map((n) => String(n).padStart(3)).join(' '));
  return rows.join('\n') + '\n';
}

const GIB = 1024 ** 3;

/** The values read from a 1 TiB WSL machine disk: 1 GiB journal, 602,878 inodes in use, 256-byte inodes. */
const HOST_SUPERBLOCK = {
  u32: { 0x00: 67_108_864, 0x10: 67_108_864 - 602_878, 0x4c: 1, 0x5c: 0x103c, 0xe0: 8, 0x148: 0, 0x14c: GIB },
  u16: { 0x38: 0xef53, 0x58: 256 },
  u8: { 0xfd: 1 },
};

describe('parseExt4Overhead', () => {
  it('counts the journal and the inode-table space of inodes in use', () => {
    assert.equal(parseExt4Overhead(superblock(HOST_SUPERBLOCK)), GIB + 602_878 * 256);
  });

  it('counts only inodes in use, so lazily initialised inode tables never inflate it', () => {
    const fewer = { ...HOST_SUPERBLOCK, u32: { ...HOST_SUPERBLOCK.u32, 0x10: 67_108_864 - 10 } };
    assert.equal(parseExt4Overhead(superblock(fewer)), GIB + 10 * 256);
  });

  it('counts no journal when there is none, or when it lives on another device', () => {
    const noJournal = { ...HOST_SUPERBLOCK, u32: { ...HOST_SUPERBLOCK.u32, 0x5c: 0x1038 } };
    assert.equal(parseExt4Overhead(superblock(noJournal)), 602_878 * 256);
    const external = { ...HOST_SUPERBLOCK, u32: { ...HOST_SUPERBLOCK.u32, 0xe0: 0 } };
    assert.equal(parseExt4Overhead(superblock(external)), 602_878 * 256);
  });

  it('is unreadable when the journal size is not recorded in the superblock', () => {
    assert.equal(parseExt4Overhead(superblock({ ...HOST_SUPERBLOCK, u8: { 0xfd: 0 } })), null);
  });

  it('is unreadable for anything but a whole ext4 superblock', () => {
    assert.equal(parseExt4Overhead(''), null);
    // xfs, btrfs, or no sudo: no ext4 magic, or nothing at all.
    assert.equal(parseExt4Overhead(superblock({ ...HOST_SUPERBLOCK, u16: { 0x38: 0x5846, 0x58: 256 } })), null);
    assert.equal(parseExt4Overhead(superblock(HOST_SUPERBLOCK).split('\n').slice(0, 10).join('\n')), null);
    assert.equal(parseExt4Overhead('sudo: a password is required'), null);
  });
});

describe('parseGuestUsage', () => {
  const df = '         Used\n31201665024\n';

  it('adds the filesystem overhead to df\'s used bytes', () => {
    assert.equal(
      parseGuestUsage(`${df}clustercode-superblock\n${superblock(HOST_SUPERBLOCK)}`),
      31_201_665_024 + GIB + 602_878 * 256,
    );
    assert.equal(
      parseGuestUsage(`${df}clustercode-superblock\r\n${superblock(HOST_SUPERBLOCK).replace(/\n/g, '\r\n')}`),
      31_201_665_024 + GIB + 602_878 * 256,
    );
  });

  it('keeps df\'s used bytes unchanged when the overhead cannot be read', () => {
    assert.equal(parseGuestUsage(`${df}clustercode-superblock\n`), 31_201_665_024);
    assert.equal(parseGuestUsage(df), 31_201_665_024);
  });

  it('is null without a df reading, whatever the superblock says', () => {
    assert.equal(parseGuestUsage(`clustercode-superblock\n${superblock(HOST_SUPERBLOCK)}`), null);
  });
});

describe('vhdxPathFor / driveLetterOf', () => {
  it('joins with Windows separators on any OS', () => {
    assert.equal(vhdxPathFor('D:\\wsl\\dev'), 'D:\\wsl\\dev\\ext4.vhdx');
    assert.equal(vhdxPathFor('D:\\wsl\\dev\\'), 'D:\\wsl\\dev\\ext4.vhdx');
  });

  it('extracts the drive letter, or null for a UNC path', () => {
    assert.equal(driveLetterOf('d:\\wsl\\dev\\ext4.vhdx'), 'D');
    assert.equal(driveLetterOf('\\\\server\\share\\ext4.vhdx'), null);
  });
});

/**
 * `podman machine ssh` joins its trailing arguments with spaces and hands the
 * result to the guest's shell, which re-parses it. Quoting inside separate argv
 * tokens does not survive that. Simulate the join to prove every in-machine
 * command is one pre-built string.
 */
describe('machineSshArgs', () => {
  it('passes the whole in-machine command as one argument after the machine name', () => {
    const args = machineSshArgs('dev', GUEST_USAGE_SCRIPT);
    assert.deepEqual(args, ['machine', 'ssh', 'dev', GUEST_USAGE_SCRIPT]);
    assert.equal(args.slice(3).join(' '), GUEST_USAGE_SCRIPT);
  });

  it('measures usage with df in bytes, then reads the ext4 superblock read-only without prompting', () => {
    assert.equal(
      GUEST_USAGE_SCRIPT,
      'df -B1 --output=used /; echo clustercode-superblock; ' +
        'src=$(findmnt -no SOURCE /) && test -b ${src:-/nonexistent} && sudo -n od -An -v -t u1 -j 1024 -N 1024 $src 2>/dev/null; true',
    );
  });
});

describe('discoverPodmanVhdx', () => {
  const lxss = JSON.stringify([
    { DistributionName: 'Ubuntu', BasePath: 'C:\\x' },
    { DistributionName: 'podman-machine-default', BasePath: PODMAN_BASE },
  ]);

  function deps(machineList: string | Error, lxssOut: string | Error = lxss, size: number | null = 1) {
    const calls: string[][] = [];
    const timeouts: Array<number | undefined> = [];
    return {
      calls,
      timeouts,
      deps: {
        exec: (file: string, args: string[], timeoutMs?: number) => {
          calls.push([file, ...args]);
          timeouts.push(timeoutMs);
          const out = file === 'podman' ? machineList : lxssOut;
          if (out instanceof Error) throw out;
          return out;
        },
        fileSize: () => size,
      },
    };
  }

  it('finds the VHDX of the default WSL machine', () => {
    const { deps: d } = deps('podman-machine-default*|wsl|true|true\n');
    assert.deepEqual(discoverPodmanVhdx(d), {
      ok: true,
      target: {
        machine: 'podman-machine-default',
        distro: 'podman-machine-default',
        vhdxPath: `${PODMAN_BASE}\\ext4.vhdx`,
        running: true,
        isDefault: true,
        machineCount: 1,
      },
    });
  });

  it('records whether the machine is the default, and how many machines there are', () => {
    const chosenDefault = discoverPodmanVhdx(deps('other|wsl|false|false\npodman-machine-default*|wsl|true|true\n').deps);
    assert.ok(chosenDefault.ok);
    assert.equal(chosenDefault.target.isDefault, true);
    assert.equal(chosenDefault.target.machineCount, 2);

    const firstListed = discoverPodmanVhdx(deps('podman-machine-default|wsl|true|false\nother|wsl|false|false\n').deps);
    assert.ok(firstListed.ok);
    assert.equal(firstListed.target.machine, 'podman-machine-default');
    assert.equal(firstListed.target.isDefault, false);
    assert.equal(firstListed.target.machineCount, 2);
  });

  it('reports no machine when podman is missing or lists none', () => {
    assert.deepEqual(discoverPodmanVhdx(deps(new Error('ENOENT')).deps), { ok: false, reason: 'no-machine' });
    assert.deepEqual(discoverPodmanVhdx(deps('').deps), { ok: false, reason: 'no-machine' });
  });

  it('stops at a machine that is not WSL-backed, without reading the registry', () => {
    const { deps: d, calls } = deps('dev*|hyperv|true|true\n');
    assert.deepEqual(discoverPodmanVhdx(d), { ok: false, reason: 'not-wsl' });
    assert.equal(calls.length, 1);
  });

  it('reports a missing WSL registration or VHDX file', () => {
    assert.deepEqual(discoverPodmanVhdx(deps('other*|wsl|true|true\n').deps), { ok: false, reason: 'no-distro' });
    assert.deepEqual(discoverPodmanVhdx(deps('podman-machine-default*|wsl|true|true\n', lxss, null).deps), {
      ok: false,
      reason: 'no-vhdx',
    });
  });

  it('bounds the registry query like the other PowerShell probes', () => {
    const { deps: d, calls, timeouts } = deps('podman-machine-default*|wsl|true|true\n');
    discoverPodmanVhdx(d);
    const registry = calls.findIndex((c) => c[0] === 'powershell');
    assert.ok(registry >= 0);
    assert.equal(timeouts[registry], POWERSHELL_PROBE_TIMEOUT_MS);
  });
});

describe('readVhdx', () => {
  const target = { machine: 'dev', distro: 'podman-dev', vhdxPath: 'D:\\wsl\\dev\\ext4.vhdx', running: true };

  it('reads the size, the usage inside the machine and the drive free space through its deps', () => {
    const execCalls: Array<[string, string[], number | undefined]> = [];
    const drives: string[] = [];
    const reading = readVhdx(target, {
      exec: (file, args, timeoutMs) => (execCalls.push([file, args, timeoutMs]), '     Used\n1000\n'),
      fileSize: () => 5000,
      driveFree: (letter) => (drives.push(letter), 7000),
    });
    assert.deepEqual(reading, { vhdxBytes: 5000, guestUsedBytes: 1000, machineRunning: true, hostFreeBytes: 7000, drive: 'D' });
    assert.deepEqual(drives, ['D']);
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0][0], 'podman');
    // The in-machine probe is bounded too: ssh into a wedged machine must not hang doctor.
    assert.ok(typeof execCalls[0][2] === 'number' && execCalls[0][2] > 0 && execCalls[0][2] <= 30_000);
  });

  it('names the machine in the reading only when there are several', () => {
    const d = { exec: () => 'Used\n1\n', fileSize: () => 5, driveFree: () => 1 };
    assert.equal(readVhdx({ ...target, machineCount: 1 }, d)?.machine, undefined);
    assert.equal(readVhdx({ ...target, machineCount: 2 }, d)?.machine, 'dev');
  });

  it('never asks a stopped machine, and tolerates an unknown free space', () => {
    let execs = 0;
    const reading = readVhdx(
      { ...target, running: false },
      { exec: () => (execs++, ''), fileSize: () => 5000, driveFree: () => null },
    );
    assert.deepEqual(reading, { vhdxBytes: 5000, guestUsedBytes: null, machineRunning: false, hostFreeBytes: null, drive: 'D' });
    assert.equal(execs, 0);
  });

  it('estimates reclaimable space net of filesystem overhead, and never below zero', () => {
    const deps = (hostBytes: number) => ({
      exec: () => `Used\n${29 * GIB}\nclustercode-superblock\n${superblock(HOST_SUPERBLOCK)}`,
      fileSize: () => hostBytes,
      driveFree: () => 100 * GIB,
    });
    const after = readVhdx(target, deps(31.7 * GIB));
    assert.ok(after && after.guestUsedBytes !== null);
    assert.equal(after.guestUsedBytes, 29 * GIB + GIB + 602_878 * 256);
    assert.match(describeMeasuredReading({ ...after, guestUsedBytes: after.guestUsedBytes }), /used inside — ~1\.6 GB reclaimable/);

    // The overhead estimate can exceed what the disk holds: clamp, never negative.
    const tight = readVhdx(target, deps(29.5 * GIB));
    assert.ok(tight && tight.guestUsedBytes !== null);
    assert.match(describeMeasuredReading({ ...tight, guestUsedBytes: tight.guestUsedBytes }), /~0\.0 GB reclaimable/);
  });

  it('measures usage with a bounded ssh probe', () => {
    let seen: number | undefined;
    assert.equal(measureGuestUsed('dev', (_f, _a, t) => ((seen = t), 'Used\n42\n')), 42);
    assert.ok(typeof seen === 'number' && seen <= 30_000);
  });
});

describe('describeMachineChoice', () => {
  const base = { distro: 'podman-dev', vhdxPath: 'D:/x/ext4.vhdx', running: true };

  it('names the only machine plainly', () => {
    assert.equal(describeMachineChoice({ ...base, machine: 'dev', isDefault: true, machineCount: 1 }), 'Podman machine: dev');
    assert.equal(describeMachineChoice({ ...base, machine: 'dev' }), 'Podman machine: dev');
  });

  it('says it is the default when there are several', () => {
    assert.equal(
      describeMachineChoice({ ...base, machine: 'dev', isDefault: true, machineCount: 3 }),
      'Podman machine: dev (the default of 3 machines)',
    );
  });

  it('says it is the first listed when none is the default', () => {
    assert.equal(
      describeMachineChoice({ ...base, machine: 'dev', isDefault: false, machineCount: 2 }),
      'Podman machine: dev (the first of 2 machines; none is set as the default)',
    );
  });
});
