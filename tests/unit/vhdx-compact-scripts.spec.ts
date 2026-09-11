import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  diskpartPathScript,
  diskpartScripts,
  elevatedRunnerScript,
  elevationFiles,
  elevationLauncherScript,
  encodePowerShell,
  interpretDiskpart,
  interpretLauncher,
  logTail,
  parseDiskpartPath,
  PATH_NOT_REPRESENTABLE_EXIT,
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

describe('elevationFiles', () => {
  it('keeps every file the elevated side touches in the one temporary folder', () => {
    const f = elevationFiles('C:\\t');
    assert.deepEqual(f, {
      dir: 'C:\\t',
      runScript: 'C:\\t\\run.ps1',
      compactScript: 'C:\\t\\compact.txt',
      detachScript: 'C:\\t\\detach.txt',
      compactLog: 'C:\\t\\compact.log',
      detachLog: 'C:\\t\\detach.log',
      started: 'C:\\t\\started',
      done: 'C:\\t\\done',
    });
  });
});

describe('elevatedRunnerScript', () => {
  const files = elevationFiles('C:\\t');
  const script = elevatedRunnerScript(VHDX, files);

  it('writes both diskpart scripts itself, in the OEM code page diskpart reads', () => {
    const { compact, detach } = diskpartScripts(VHDX);
    const lines = (text: string) => text.trim().split(/\r\n/).map(psQuote).join(',');
    assert.ok(
      script.includes(`${lines(detach)} | Out-File -LiteralPath 'C:\\t\\detach.txt' -Encoding OEM -ErrorAction Stop`),
      script,
    );
    assert.ok(
      script.includes(`${lines(compact)} | Out-File -LiteralPath 'C:\\t\\compact.txt' -Encoding OEM -ErrorAction Stop`),
      script,
    );
  });

  it('keeps a non-ASCII path intact in the script, for PowerShell to convert', () => {
    const path = 'C:\\Users\\Zoë 漢字\\wsl\\ext4.vhdx';
    assert.ok(elevatedRunnerScript(path, files).includes(`'select vdisk file="${path}"'`));
  });

  it('marks that it started before anything else, and that it finished last', () => {
    const tryAt = script.indexOf('try {');
    const startedAt = script.indexOf("Set-Content -LiteralPath 'C:\\t\\started'");
    const writeAt = script.indexOf('Out-File');
    const doneAt = script.indexOf("Set-Content -LiteralPath 'C:\\t\\done' -Value $rc");
    const exitAt = script.lastIndexOf('exit $rc');
    assert.ok(tryAt >= 0 && startedAt > tryAt && writeAt > startedAt, script);
    assert.ok(doneAt > script.indexOf('finally {') && exitAt > doneAt, script);
  });

  it('runs the compact inside try and the detach inside finally, each with its own log', () => {
    const compactAt = script.indexOf("diskpart /s (ShortOf 'C:\\t\\compact.txt') *> 'C:\\t\\compact.log'");
    const finallyAt = script.indexOf('finally {');
    const detachAt = script.indexOf("diskpart /s (ShortOf 'C:\\t\\detach.txt') *> 'C:\\t\\detach.log'");
    assert.ok(compactAt > script.indexOf('try {'), script);
    assert.ok(finallyAt > compactAt, script);
    assert.ok(detachAt > finallyAt, script);
    // Only once the detach script exists: a failure before writing it has nothing to detach.
    assert.match(script, /if \(Test-Path -LiteralPath 'C:\\t\\detach\.txt'\) \{ diskpart/);
  });

  it('exits with the compact exit code, defaulting to failure and never reading a missing code as success', () => {
    assert.match(script, /^\$rc = 1/);
    assert.match(script, /if \(\$null -eq \$LASTEXITCODE\) \{ 1 \} else \{ \$LASTEXITCODE \}/);
    assert.match(script, /catch \{\r\n\s+\$rc = 1/);
    assert.match(script, /exit \$rc\s*$/);
  });

  it('records why the script failed in the compact log', () => {
    assert.ok(script.includes("Out-File -LiteralPath 'C:\\t\\compact.log' -Append -Encoding Unicode"), script);
  });
});

describe('diskpartPathScript', () => {
  const script = diskpartPathScript(VHDX);

  it('checks the path against the system OEM code page', () => {
    assert.ok(script.includes("'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage' -Name OEMCP"), script);
    assert.match(script, /GetEncoding\(\$cp\)/);
    // A round trip catches both unmappable characters and best-fit substitutions.
    assert.match(script, /GetString\(\$enc\.GetBytes\(\$s\)\) -ceq \$s/);
  });

  it('falls back to the short 8.3 path, and gives up with a distinct exit code', () => {
    assert.ok(script.includes(`GetFile(${psQuote(VHDX)}).ShortPath`), script);
    assert.ok(script.includes(`exit ${PATH_NOT_REPRESENTABLE_EXIT}`), script);
  });

  it('prints the chosen path as base64 UTF-16LE, immune to the console code page', () => {
    assert.match(script, /\[Convert\]::ToBase64String\(\[System\.Text\.Encoding\]::Unicode\.GetBytes\(\$path\)\)/);
  });
});

describe('parseDiskpartPath', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf16le').toString('base64');

  it('decodes the chosen path, non-ASCII included', () => {
    assert.deepEqual(parseDiskpartPath(0, `${b64('C:\\USERS\\ZOË~1\\ext4.vhdx')}\r\n`), {
      ok: true,
      path: 'C:\\USERS\\ZOË~1\\ext4.vhdx',
    });
  });

  it('reports a path diskpart cannot read', () => {
    assert.deepEqual(parseDiskpartPath(PATH_NOT_REPRESENTABLE_EXIT, ''), { ok: false, reason: 'not-representable' });
  });

  it('reports anything else as a failed check, never as a usable path', () => {
    assert.deepEqual(parseDiskpartPath(1, b64('C:\\x')), { ok: false, reason: 'check-failed' });
    assert.deepEqual(parseDiskpartPath(null, ''), { ok: false, reason: 'check-failed' });
    assert.deepEqual(parseDiskpartPath(0, ''), { ok: false, reason: 'check-failed' });
    assert.deepEqual(parseDiskpartPath(0, 'not base64!'), { ok: false, reason: 'check-failed' });
    assert.deepEqual(parseDiskpartPath(0, b64('C:\\bad"path')), { ok: false, reason: 'check-failed' });
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

describe('interpretLauncher', () => {
  it('reads 1223 as a declined UAC prompt', () => {
    assert.deepEqual(interpretLauncher(1223, ''), { kind: 'declined' });
  });

  it('reads the unavailable code as no way to elevate', () => {
    assert.deepEqual(interpretLauncher(ELEVATION_UNAVAILABLE_EXIT, ''), { kind: 'unavailable' });
  });

  it('reads anything else, success included, as a failure: the elevated script never ran', () => {
    for (const code of [0, 1, null]) {
      const r = interpretLauncher(code, 'Start-Process : This command cannot be run.');
      assert.equal(r.kind, 'failed', String(code));
      assert.ok(r.kind === 'failed' && /cannot be run/.test(r.logTail));
    }
  });
});

describe('interpretDiskpart', () => {
  it('reads 0 as success', () => {
    assert.deepEqual(interpretDiskpart(0, 'DiskPart successfully compacted the virtual disk file.'), { kind: 'ok' });
  });

  it('reads an exit code of 0 as a failure when the log shows a diskpart error', () => {
    // diskpart does not reliably turn a failed scripted command into a non-zero exit code.
    const logs = [
      'DiskPart has encountered an error: The process cannot access the file because it is being used by another process.',
      'Virtual Disk Service error:\r\nThe virtual disk is already attached.',
      'The system cannot find the file specified.',
    ];
    for (const log of logs) {
      const r = interpretDiskpart(0, `Microsoft DiskPart version 10.0\r\n\r\n${log}\r\n`);
      assert.ok(r.kind === 'failed' && r.exitCode === 0, log);
      assert.ok(r.kind === 'failed' && r.logTail.includes(log.split('\r\n').at(-1)!), log);
    }
  });

  it('reads anything else as a failure carrying the end of the log', () => {
    const log = 'line1\r\nDiskPart has encountered an error: The process cannot access the file.\r\n';
    const r = interpretDiskpart(5, log);
    assert.ok(r.kind === 'failed' && r.exitCode === 5);
    assert.ok(r.kind === 'failed' && /cannot access the file/.test(r.logTail));
    assert.equal(interpretDiskpart(null, '').kind, 'failed');
  });
});

/**
 * Windows only, and read-only: PowerShell's own parser checks each generated
 * script without running it.
 */
describe('generated PowerShell', { skip: process.platform !== 'win32' }, () => {
  it('parses without errors', () => {
    const files = elevationFiles("C:\\Users\\Zoë O'Brien\\AppData\\Local\\Temp\\cc-x");
    const scripts = {
      runner: elevatedRunnerScript("C:\\Users\\Zoë O'Brien\\wsl\\ext4.vhdx", files),
      launcher: elevationLauncherScript(files.runScript),
      probe: releaseProbeScript(VHDX),
      path: diskpartPathScript('C:\\Users\\漢字\\ext4.vhdx'),
    };
    const check = Object.entries(scripts)
      .map(
        ([name, text]) =>
          `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePowerShell(text)}')), [ref]$null, [ref]$e); ` +
          `if ($e.Count) { '${name}: ' + ($e | ForEach-Object { $_.Message }) -join '; ' }`,
      )
      .join('\r\n');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(check)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    }).toString('utf8');
    assert.equal(out.trim(), '');
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
