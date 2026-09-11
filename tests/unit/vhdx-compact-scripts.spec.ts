import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  diskpartScripts,
  elevatedRunnerScript,
  elevationLauncherScript,
  encodePowerShell,
  interpretElevation,
  logTail,
  psQuote,
  releaseProbeScript,
  compactPlanSteps,
  FSTRIM_SCRIPT,
  ELEVATION_DECLINED_EXIT,
  ELEVATION_UNAVAILABLE_EXIT,
} from '../../src/lib/vhdx-compact.js';
import { machineSshArgs } from '../../src/lib/vhdx.js';

const VHDX = 'C:\\Users\\some one\\.local\\share\\containers\\podman\\machine\\wsl\\wsldist\\dev\\ext4.vhdx';
const TARGET = { machine: 'dev', distro: 'podman-dev', vhdxPath: VHDX, running: true };

describe('diskpartScripts', () => {
  it('attaches read-only, compacts, then detaches — in that order', () => {
    const { compact } = diskpartScripts(VHDX);
    const lines = compact.trim().split(/\r\n/);
    assert.deepEqual(lines, [
      `select vdisk file="${VHDX}"`,
      'attach vdisk readonly',
      'compact vdisk',
      'detach vdisk',
    ]);
  });

  it('has a separate detach-only script for the guaranteed cleanup', () => {
    const { detach } = diskpartScripts(VHDX);
    assert.deepEqual(detach.trim().split(/\r\n/), [`select vdisk file="${VHDX}"`, 'detach vdisk']);
  });

  it('never makes the disk sparse or touches anything but this vdisk', () => {
    const { compact, detach } = diskpartScripts(VHDX);
    for (const script of [compact, detach]) {
      assert.doesNotMatch(script, /sparse|clean|format|delete|create/i);
    }
  });

  it('refuses a path diskpart cannot quote', () => {
    assert.throws(() => diskpartScripts('C:\\bad"path\\ext4.vhdx'));
  });
});

describe('psQuote', () => {
  it('single-quotes so $ and backticks stay literal, doubling embedded quotes', () => {
    assert.equal(psQuote("C:\\a'b\\$x`y"), "'C:\\a''b\\$x`y'");
  });
});

describe('elevatedRunnerScript', () => {
  const paths = { compactScript: 'C:\\t\\compact.txt', detachScript: 'C:\\t\\detach.txt', log: 'C:\\t\\log.txt' };
  const script = elevatedRunnerScript(paths);

  it('runs the compact inside try and the detach inside finally', () => {
    const tryAt = script.indexOf('try {');
    const compactAt = script.indexOf("diskpart /s 'C:\\t\\compact.txt'");
    const finallyAt = script.indexOf('finally {');
    const detachAt = script.indexOf("diskpart /s 'C:\\t\\detach.txt'");
    assert.ok(tryAt >= 0 && compactAt > tryAt, script);
    assert.ok(finallyAt > compactAt, script);
    assert.ok(detachAt > finallyAt, script);
  });

  it('exits with the compact exit code, defaulting to failure', () => {
    assert.match(script, /\$rc = 1/);
    assert.match(script, /\$rc = \$LASTEXITCODE/);
    assert.match(script, /exit \$rc\s*$/);
  });

  it('appends all output to the log', () => {
    assert.equal(script.split("*>> 'C:\\t\\log.txt'").length - 1, 2);
  });
});

describe('elevationLauncherScript', () => {
  const script = elevationLauncherScript('C:\\Users\\some one\\AppData\\Local\\Temp\\cc-x\\run.ps1');

  it('asks for elevation once and waits for the elevated script', () => {
    assert.match(script, /Start-Process powershell/);
    assert.match(script, /-Verb RunAs/);
    assert.match(script, /-Wait/);
    assert.match(script, /exit \$p\.ExitCode/);
  });

  it('keeps a path with spaces as one -File argument', () => {
    assert.ok(script.includes(`'"C:\\Users\\some one\\AppData\\Local\\Temp\\cc-x\\run.ps1"'`), script);
  });

  it('maps a declined prompt and an unavailable elevation to distinct exit codes', () => {
    assert.ok(script.includes(`exit ${ELEVATION_DECLINED_EXIT}`));
    assert.ok(script.includes(`exit ${ELEVATION_UNAVAILABLE_EXIT}`));
  });
});

describe('encodePowerShell', () => {
  it('base64-encodes UTF-16LE, as -EncodedCommand expects', () => {
    assert.equal(Buffer.from(encodePowerShell('exit 0'), 'base64').toString('utf16le'), 'exit 0');
  });
});

describe('releaseProbeScript', () => {
  it('opens the file exclusively and disposes it, exiting 0 only on success', () => {
    const script = releaseProbeScript(VHDX);
    assert.ok(script.includes(`[System.IO.File]::Open(${psQuote(VHDX)}, 'Open', 'ReadWrite', 'None').Dispose()`));
    assert.match(script, /exit 0/);
    assert.match(script, /catch \{ exit 1 \}/);
  });
});

describe('interpretElevation', () => {
  it('reads 0 as success', () => {
    assert.deepEqual(interpretElevation(0, ''), { kind: 'ok' });
  });

  it('reads 1223 as a declined UAC prompt', () => {
    assert.deepEqual(interpretElevation(1223, ''), { kind: 'declined' });
  });

  it('reads the unavailable code as no way to elevate', () => {
    assert.deepEqual(interpretElevation(ELEVATION_UNAVAILABLE_EXIT, ''), { kind: 'unavailable' });
  });

  it('reads anything else as a failure carrying the end of the log', () => {
    const log = 'line1\r\nDiskPart has encountered an error: The process cannot access the file.\r\n';
    const r = interpretElevation(5, log);
    assert.equal(r.kind, 'failed');
    assert.ok(r.kind === 'failed' && r.exitCode === 5);
    assert.ok(r.kind === 'failed' && /cannot access the file/.test(r.logTail));
  });

  it('treats a launcher that never ran as a failure', () => {
    assert.equal(interpretElevation(null, '').kind, 'failed');
  });
});

describe('logTail', () => {
  it('keeps the last non-blank lines', () => {
    assert.equal(logTail('a\n\nb\r\nc\n\n', 2), 'b\nc');
  });
});

describe('compactPlanSteps', () => {
  const steps = compactPlanSteps(TARGET);

  it('trims, stops, terminates, waits, compacts, then starts — in that order', () => {
    const order = [/fstrim/, /podman machine stop dev/, /wsl --terminate podman-dev/, /release/, /diskpart/, /podman machine start dev/];
    let last = -1;
    for (const pattern of order) {
      const at = steps.findIndex((s) => pattern.test(s));
      assert.ok(at > last, `${pattern} out of order in ${JSON.stringify(steps)}`);
      last = at;
    }
  });

  it('never proposes wsl --shutdown or a sparse disk', () => {
    for (const step of steps) {
      assert.doesNotMatch(step, /--shutdown|sparse/);
    }
  });

  it('never puts the disk path in a step', () => {
    for (const step of steps) assert.ok(!step.includes('\\'), step);
  });
});

describe('FSTRIM_SCRIPT', () => {
  it('runs non-interactively as root, as one in-machine command string', () => {
    assert.equal(FSTRIM_SCRIPT, 'sudo -n fstrim -av');
    const args = machineSshArgs('dev', FSTRIM_SCRIPT);
    // podman space-joins the trailing argv for the guest shell to re-parse.
    assert.equal(args.length, 4);
    assert.equal(args.slice(3).join(' '), FSTRIM_SCRIPT);
  });
});
