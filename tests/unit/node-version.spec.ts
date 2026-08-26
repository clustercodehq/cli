import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  MINIMUM_NODE_VERSION,
  meetsMinimumNode,
  unsupportedNodeMessage,
} from '../../src/lib/node-version.js';

describe('meetsMinimumNode', () => {
  // The floor was established by running the built CLI on each of these:
  // 20.11.1 fails to link, 20.12.0 runs. The boundary is exact, not padded.
  const cases: Array<[string, boolean]> = [
    ['18.20.8', false],
    ['20.11.1', false],
    ['20.11.99', false],
    ['20.12.0', true],
    ['20.12.1', true],
    ['20.13.0', true],
    ['21.0.0', true],
    ['22.0.0', true],
    ['25.8.2', true],
  ];

  for (const [version, expected] of cases) {
    test(`${version} ${expected ? 'meets' : 'does not meet'} ${MINIMUM_NODE_VERSION}`, () => {
      assert.equal(meetsMinimumNode(version, MINIMUM_NODE_VERSION), expected);
    });
  }

  test('compares minor numerically, not lexically', () => {
    // '9' > '12' as strings — the bug this guards against.
    assert.equal(meetsMinimumNode('20.9.0', '20.12.0'), false);
    assert.equal(meetsMinimumNode('20.120.0', '20.12.0'), true);
  });

  test('tolerates a leading v on either side', () => {
    assert.equal(meetsMinimumNode('v20.12.0', 'v20.12.0'), true);
    assert.equal(meetsMinimumNode('v18.0.0', '20.12.0'), false);
  });

  test('treats a prerelease suffix as its numeric prefix', () => {
    assert.equal(meetsMinimumNode('20.12.0-nightly20240101', '20.12.0'), true);
    assert.equal(meetsMinimumNode('20.11.0-nightly', '20.12.0'), false);
  });

  test('treats missing parts as zero rather than NaN', () => {
    assert.equal(meetsMinimumNode('21', '20.12.0'), true);
    assert.equal(meetsMinimumNode('20', '20.12.0'), false);
  });

  test('the current process satisfies the floor it declares', () => {
    assert.ok(meetsMinimumNode(process.versions.node, MINIMUM_NODE_VERSION));
  });
});

describe('unsupportedNodeMessage', () => {
  test('names both the requirement and what is actually running', () => {
    const message = unsupportedNodeMessage('18.20.8');
    assert.match(message, /20\.12\.0/);
    assert.match(message, /18\.20\.8/);
  });
});

describe('the declared floor and the enforced floor', () => {
  // Two places state the requirement: `engines.node`, which npm reads at
  // install time, and MINIMUM_NODE_VERSION, which the CLI enforces at startup.
  // They are only useful if they agree.
  test('package.json engines.node matches MINIMUM_NODE_VERSION', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { engines?: { node?: string } };
    assert.equal(pkg.engines?.node, `>=${MINIMUM_NODE_VERSION}`);
  });
});
