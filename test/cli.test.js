import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseListOutput,
  normalizeDeployment,
  findCurrentProduction,
  demoDeployments,
  applyFilter,
  ageLabel,
  countByState,
  parseArgs,
} from '../cli.js';

const DAY = 24 * 3600000;
const now = Date.now();
const sample = [
  { url: 'new-prod.vercel.app', state: 'READY', target: 'production', createdAt: now - 2 * 3600000, meta: {} },
  { url: 'old-prod.vercel.app', state: 'READY', target: 'production', createdAt: now - 10 * DAY, meta: {} },
  { url: 'old-preview.vercel.app', state: 'READY', target: '', createdAt: now - 20 * DAY, meta: { githubCommitRef: 'main' } },
  { url: 'failed.vercel.app', state: 'ERROR', target: '', createdAt: now - 3 * DAY, meta: {} },
  { url: 'canceled.vercel.app', state: 'CANCELED', target: '', createdAt: now - 40 * DAY, meta: {} },
].map((d) => normalizeDeployment(d, 'demo'));

test('parseListOutput accepts an array and a { deployments } object', () => {
  assert.equal(parseListOutput(JSON.stringify(sample)).length, 5);
  assert.equal(parseListOutput(JSON.stringify({ deployments: sample })).length, 5);
  assert.throws(() => parseListOutput('not json'));
});

test('demo data: newest READY production is protected', () => {
  const demo = demoDeployments('demo-app');
  assert.equal(demo.length, 8);
  assert.equal(findCurrentProduction(demo).url, 'demo-app-9f2k1.vercel.app');
});

test('newest READY production is protected, old productions are not', () => {
  assert.equal(findCurrentProduction(sample).url, 'new-prod.vercel.app');
});

test('filters: older7, preview, failed', () => {
  assert.equal(applyFilter(sample, 'older7', null, now).length, 3);
  assert.equal(applyFilter(sample, 'preview', null, now).length, 3);
  assert.deepEqual(
    applyFilter(sample, 'failed', null, now).map((d) => d.url).sort(),
    ['canceled.vercel.app', 'failed.vercel.app'],
  );
});

test('age labels and state counts', () => {
  assert.equal(ageLabel(sample[0], now), '2h');
  assert.equal(ageLabel(sample[2], now), '20.0d');
  assert.deepEqual(countByState(sample), { READY: 3, ERROR: 1, CANCELED: 1 });
});

test('args: project, scope, dry-run', () => {
  assert.deepEqual(parseArgs(['my-app', '--dry-run', '--scope', 'my-team']), {
    project: 'my-app', scope: 'my-team', dryRun: true, demo: false, help: false, version: false,
  });
  assert.equal(parseArgs(['--demo']).demo, true);
  assert.throws(() => parseArgs(['--nope']));
});
