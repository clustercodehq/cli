import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMachineList,
  wslDistroCandidates,
  parseLxssJson,
  parseDfUsed,
  vhdxPathFor,
  driveLetterOf,
  MACHINE_LIST_FORMAT,
  GUEST_USAGE_SCRIPT,
  machineSshArgs,
  discoverPodmanVhdx,
} from '../../src/lib/vhdx.js';

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

  it('measures usage with df in bytes on the root filesystem', () => {
    assert.equal(GUEST_USAGE_SCRIPT, 'df -B1 --output=used /');
  });
});

describe('discoverPodmanVhdx', () => {
  const lxss = JSON.stringify([
    { DistributionName: 'Ubuntu', BasePath: 'C:\\x' },
    { DistributionName: 'podman-machine-default', BasePath: PODMAN_BASE },
  ]);

  function deps(machineList: string | Error, lxssOut: string | Error = lxss, size: number | null = 1) {
    const calls: string[][] = [];
    return {
      calls,
      deps: {
        exec: (file: string, args: string[]) => {
          calls.push([file, ...args]);
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
      },
    });
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
});
