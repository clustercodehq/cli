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
    const out = fmt('{"time":"2026-07-06T14:08:26Z","level":"INFO","msg":"probe","cpus":14,"windowsImages":false}');
    assert.match(out, /cpus=14 windowsImages=false$/);
  });

  it('expands records with >2 fields into an aligned tree block', () => {
    const out = fmt(
      '{"time":"2026-07-06T14:32:03Z","level":"INFO","msg":"startup configuration","configDir":"/Users/javier/.clustercode","mode":"byom","engines":"podman","cpus":14}',
    );
    const lines = out.split('\n');
    assert.equal(lines.length, 5); // head + 4 field branches
    assert.match(lines[0], /● {2}startup configuration$/); // no inline fields on the head
    assert.match(lines[1], /^ {14}├─ configDir {2}\/Users\/javier\/\.clustercode$/);
    assert.match(lines[2], /^ {14}├─ mode {7}byom$/); // key padded to 'configDir' width (9)
    assert.match(lines[4], /^ {14}└─ cpus {7}14$/); // last branch uses └─
  });

  it('keeps records with exactly 2 fields inline (no tree)', () => {
    const out = fmt('{"time":"2026-07-06T14:32:03Z","level":"INFO","msg":"two fields","a":"1","b":"2"}');
    assert.equal(out.includes('\n'), false);
    assert.match(out, /two fields {2}a=1 b=2$/);
  });

  it('expands a WARN record too, keeping the yellow head symbol line intact', () => {
    const out = fmt(
      '{"time":"2026-07-06T14:33:11Z","level":"WARN","msg":"engine unreachable","engine":"podman","detail":"exit status 125","action":"re-resolving connection"}',
    );
    const lines = out.split('\n');
    assert.match(lines[0], /▲ {2}engine unreachable$/);
    assert.match(lines[3], /^ {14}└─ action {2}re-resolving connection$/);
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
