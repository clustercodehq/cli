import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { POWERSHELL_PROBE_TIMEOUT_MS, windowsDriveFreeBytes } from '../../src/lib/checks.js';

describe('windowsDriveFreeBytes', () => {
  it('asks PowerShell for the drive with a bounded timeout', () => {
    const calls: Array<[string, number | undefined]> = [];
    const free = windowsDriveFreeBytes('c', (cmd, timeoutMs) => {
      calls.push([cmd, timeoutMs]);
      return '73657212928\r\n';
    });
    assert.equal(free, 73657212928);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /Get-PSDrive C\b/);
    // A wedged shell must not hang doctor, or the compact between stopping and starting the machine.
    assert.equal(calls[0][1], POWERSHELL_PROBE_TIMEOUT_MS);
    assert.ok(POWERSHELL_PROBE_TIMEOUT_MS > 0 && POWERSHELL_PROBE_TIMEOUT_MS <= 15_000);
  });

  it('returns null when the probe times out or fails', () => {
    assert.equal(windowsDriveFreeBytes('C', () => null), null);
    assert.equal(windowsDriveFreeBytes('C', () => 'not a number'), null);
  });

  it('never runs anything for an invalid drive letter', () => {
    let ran = false;
    const run = () => ((ran = true), '1');
    assert.equal(windowsDriveFreeBytes('C:', run), null);
    assert.equal(windowsDriveFreeBytes('1', run), null);
    assert.equal(ran, false);
  });
});
