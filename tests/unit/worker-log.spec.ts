import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatWorkerLogLine } from '../../src/lib/worker-log.js';

// Assertions are made on the de-colored text so they hold whether or not the
// test environment supports ANSI (picocolors auto-detects).
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const fmt = (line: string) => stripAnsi(formatWorkerLogLine(line));

describe('formatWorkerLogLine', () => {
  it('formats an INFO record as time ● msg with key=value fields', () => {
    const out = fmt(
      '{"time":"2026-07-06T14:08:26.496343-04:00","level":"INFO","msg":"worker agent starting","version":"1.0.0-alpha.5"}',
    );
    assert.match(out, /^\d{2}:\d{2}:\d{2}  ●  worker agent starting  version=1\.0\.0-alpha\.5$/);
  });

  it('renders a record with no extra fields as just time + symbol + msg', () => {
    const out = fmt('{"time":"2026-07-06T14:08:27.25287-04:00","level":"INFO","msg":"websocket connected"}');
    assert.match(out, /^\d{2}:\d{2}:\d{2}  ●  websocket connected$/);
  });

  it('uses ▲ for WARN and ✖ for ERROR', () => {
    assert.match(
      fmt('{"time":"2026-07-06T14:09:03Z","level":"WARN","msg":"engine unreachable","engine":"podman"}'),
      /▲ {2}engine unreachable {2}engine=podman$/,
    );
    assert.match(
      fmt('{"time":"2026-07-06T14:09:20Z","level":"ERROR","msg":"container list failed","error":"connection refused"}'),
      /✖ {2}container list failed {2}error=connection refused$/,
    );
  });

  it('uses · for DEBUG and tolerates lowercase levels', () => {
    assert.match(fmt('{"time":"2026-07-06T14:09:20Z","level":"debug","msg":"probe tick"}'), /· {2}probe tick$/);
  });

  it('serializes non-string field values as JSON', () => {
    const out = fmt('{"time":"2026-07-06T14:08:26Z","level":"INFO","msg":"startup configuration","cpus":14,"windowsImages":false}');
    assert.match(out, /cpus=14 windowsImages=false$/);
  });

  it('passes non-JSON lines through verbatim (panics, raw prints)', () => {
    const panic = 'panic: runtime error: invalid memory address';
    assert.equal(formatWorkerLogLine(panic), panic);
  });

  it('passes JSON that is not a slog record through verbatim', () => {
    const notSlog = '{"foo":"bar"}';
    assert.equal(formatWorkerLogLine(notSlog), notSlog);
    const noLevel = '{"msg":"hello"}';
    assert.equal(formatWorkerLogLine(noLevel), noLevel);
  });

  it('shows --:--:-- for a missing or unparseable time', () => {
    assert.match(fmt('{"level":"INFO","msg":"no time"}'), /^--:--:--  ●  no time$/);
    assert.match(fmt('{"time":"not-a-date","level":"INFO","msg":"bad time"}'), /^--:--:--  ●  bad time$/);
  });
});
