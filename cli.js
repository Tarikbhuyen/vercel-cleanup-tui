#!/usr/bin/env node
/**
 * vercel-cleanup-tui
 *
 * Interactive terminal cleanup for old Vercel deployments.
 *
 * How it works, and why there is no token or server here:
 *  - The user runs `vercel login` once, in their own terminal.
 *  - This tool only shells out to that same `vercel` CLI on the same
 *    machine (`vercel ls --json`, `vercel remove <url> --yes`).
 *  - No API token is ever asked for, stored, or sent anywhere.
 *  - Nothing is hosted by the author. All data stays on the user's PC.
 *
 * Safety rules (do not weaken these):
 *  1. NEVER run `vercel remove <project-name>`. That deletes the whole
 *     project. Only deployment URLs are ever passed to `vercel remove`.
 *  2. The newest READY production deployment is PROTECTED. It is never
 *     offered in the checkbox list, and if a fresh re-check shows it
 *     changed before deletion, the whole run aborts.
 *  3. Nothing is deleted without a checkbox selection AND a confirm
 *     prompt. `--dry-run` lists what would be deleted and exits.
 *  4. Never parse the `vercel ls` text table. When piped, the table goes
 *     to stderr and a bare URL list goes to stdout, which corrupts
 *     table parsing. Always use `--json` and epoch-millisecond ages.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkbox, confirm, input, select } from '@inquirer/prompts';

export const BATCH_SIZE = 20;
export const PAGE_LIMIT = 100;
export const MAX_PAGES = 50;

const isWindows = process.platform === 'win32';

export function parseArgs(argv) {
  const args = { project: null, scope: null, dryRun: false, demo: false, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--demo') args.demo = true;
    else if (a === '--project' && argv[i + 1]) args.project = argv[++i];
    else if (a.startsWith('--project=')) args.project = a.slice('--project='.length);
    else if (a === '--scope' && argv[i + 1]) args.scope = argv[++i];
    else if (a.startsWith('--scope=')) args.scope = a.slice('--scope='.length);
    else if (!a.startsWith('-') && !args.project) args.project = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

export function printHelp() {
  console.log(`vercel-cleanup-tui — clean up old Vercel deployments, interactively.

Usage:
  vercel-cleanup [project-name] [options]
  npx vercel-cleanup-tui [project-name] [options]

Options:
  --project <name>   Vercel project name (or pass it as the first argument)
  --scope <slug>     Vercel team scope, if you use teams
  --dry-run          List what would be deleted, delete nothing
  --demo             Demo mode: sample data only, no login, nothing deleted.
                     Use it to preview the tool and to take screenshots.
  --help, -h         Show this help
  --version, -v      Show the version

Interaction:
  Arrow keys move, Space ticks/unticks, "a" toggles all, Enter confirms.
  The newest READY production deployment is always protected.

Prerequisites:
  Node.js 20.17+ and the Vercel CLI, already logged in:
    npm install -g vercel
    vercel login
`);
}

function runVercel(args, scope) {
  const fullArgs = scope ? ['--scope', scope, ...args] : args;
  // On Windows the vercel shim is vercel.cmd, so a shell is needed there.
  // Everywhere else, no shell: arguments are passed exactly, no injection.
  const result = spawnSync('vercel', fullArgs, {
    encoding: 'utf8',
    shell: isWindows,
    timeout: 180000,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('Vercel CLI not found. Install it first: npm install -g vercel');
    }
    throw result.error;
  }
  return result;
}

export function parseListOutput(stdout) {
  const text = (stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.deployments)) return parsed.deployments;
  throw new Error('Unexpected vercel ls --json shape: expected an array or { deployments: [...] }');
}

function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Vercel returns epoch milliseconds. If a future CLI ever returns
  // seconds, convert so ages are never off by 1000x.
  return n < 1e12 ? n * 1000 : n;
}

export function normalizeDeployment(raw, project) {
  const createdMs = toMs(raw.createdAt ?? raw.created);
  const state = String(raw.state || raw.readyState || '').toUpperCase();
  return {
    url: raw.url,
    name: raw.name || project,
    state,
    target: raw.target || '',
    createdMs,
    branch: raw.meta?.githubCommitRef || raw.meta?.gitBranch || '',
    sha: raw.meta?.githubCommitSha ? String(raw.meta.githubCommitSha).slice(0, 7) : '',
  };
}

export function ageHours(deployment, now = Date.now()) {
  if (deployment.createdMs == null) return null;
  return (now - deployment.createdMs) / 3600000;
}

export function ageLabel(deployment, now = Date.now()) {
  const h = ageHours(deployment, now);
  if (h == null) return 'unknown age';
  if (h < 1) return `${Math.max(0, Math.floor(h * 60))}m`;
  if (h < 24) return `${Math.floor(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function envLabel(deployment) {
  if (deployment.target === 'production') return 'Production';
  return 'Preview';
}

export function findCurrentProduction(deployments) {
  const productions = deployments
    .filter((d) => d.target === 'production' && d.state === 'READY' && d.createdMs != null)
    .sort((a, b) => b.createdMs - a.createdMs);
  return productions[0] || null;
}

export function applyFilter(deployments, filter, customDays = null, now = Date.now()) {
  return deployments.filter((d) => {
    const h = ageHours(d, now);
    switch (filter) {
      case 'all': return true;
      case 'older7': return h != null && h > 24 * 7;
      case 'older30': return h != null && h > 24 * 30;
      case 'preview': return d.target !== 'production';
      case 'failed': return ['ERROR', 'CANCELED', 'CANCELLED', 'BLOCKED'].includes(d.state);
      case 'custom': return h != null && customDays != null && h > 24 * customDays;
      default: return true;
    }
  });
}

export function countByState(deployments) {
  const out = {};
  for (const d of deployments) out[d.state || 'UNKNOWN'] = (out[d.state || 'UNKNOWN'] || 0) + 1;
  return out;
}

export function listDeployments(project, scope) {
  const all = [];
  const seen = new Set();
  let next = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const args = ['ls', project, '--json', '--limit', String(PAGE_LIMIT)];
    if (next != null) args.push('--next', String(next));
    const result = runVercel(args, scope);
    if (result.status !== 0) {
      throw new Error(`vercel ls failed:\n${(result.stderr || result.stdout || '').trim()}`);
    }
    const raw = parseListOutput(result.stdout);
    const batch = raw.map((d) => normalizeDeployment(d, project)).filter((d) => d.url);
    let added = 0;
    for (const d of batch) {
      if (!seen.has(d.url)) { seen.add(d.url); all.push(d); added += 1; }
    }
    if (batch.length < PAGE_LIMIT || added === 0) break;
    const last = batch[batch.length - 1];
    if (last.createdMs == null || last.createdMs === next) break;
    next = last.createdMs;
  }
  return all.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
}

function formatRow(d) {
  const bits = [d.url, envLabel(d), d.state || 'UNKNOWN', ageLabel(d)];
  if (d.branch) bits.push(d.branch);
  if (d.sha) bits.push(d.sha);
  return bits.join('  •  ');
}

export function demoDeployments(project, now = Date.now()) {
  const DAY = 24 * 3600000;
  const HOUR = 3600000;
  const raw = [
    { url: 'demo-app-9f2k1.vercel.app', state: 'READY', target: 'production', createdAt: now - 2 * HOUR, meta: { githubCommitRef: 'main' } },
    { url: 'demo-app-8d4m2.vercel.app', state: 'READY', target: 'production', createdAt: now - 12 * DAY, meta: { githubCommitRef: 'main' } },
    { url: 'demo-app-7c3n9.vercel.app', state: 'READY', target: '', createdAt: now - 3 * DAY, meta: { githubCommitRef: 'feature/pricing' } },
    { url: 'demo-app-6b8p4.vercel.app', state: 'READY', target: '', createdAt: now - 9 * DAY, meta: { githubCommitRef: 'feature/pricing' } },
    { url: 'demo-app-5a1q7.vercel.app', state: 'READY', target: '', createdAt: now - 18 * DAY, meta: { githubCommitRef: 'fix/header' } },
    { url: 'demo-app-4z6w3.vercel.app', state: 'ERROR', target: '', createdAt: now - 5 * DAY, meta: { githubCommitRef: 'fix/header' } },
    { url: 'demo-app-3x9v5.vercel.app', state: 'CANCELED', target: '', createdAt: now - 32 * DAY, meta: { githubCommitRef: 'main' } },
    { url: 'demo-app-2k7t8.vercel.app', state: 'READY', target: 'production', createdAt: now - 45 * DAY, meta: { githubCommitRef: 'main' } },
  ];
  return raw.map((d) => normalizeDeployment(d, project));
}

function printSummary(deployments) {
  console.log(`\n${deployments.length} deployment(s) selected.`);
  console.log(`By state: ${JSON.stringify(countByState(deployments))}`);
  for (const d of deployments) console.log(`  - ${formatRow(d)}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (args.help) { printHelp(); return; }
  if (args.version) {
    const { readFileSync } = await import('node:fs');
    try {
      const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
      console.log(pkg.version);
    } catch { console.log('0.1.0'); }
    return;
  }
  if (!process.stdin.isTTY) {
    console.error('This tool is interactive. Run it in a terminal, not piped input.');
    process.exitCode = 2;
    return;
  }

  const project = args.project || await input({
    message: 'Vercel project name:',
    validate: (v) => (v.trim() ? true : 'Project name is required'),
  });
  const projectName = project.trim();

  let all;
  if (args.demo) {
    console.log('\nDEMO MODE: sample data only. No Vercel login needed, nothing will be deleted.');
    all = demoDeployments(projectName);
  } else {
    // Preflight: the Vercel CLI itself holds the login. No token is asked here.
    const whoami = runVercel(['whoami'], args.scope);
    if (whoami.status !== 0) {
      console.error('Vercel CLI is not logged in. Run `vercel login` first, then run this tool again.');
      process.exitCode = 1;
      return;
    }
    console.log(`Logged in as: ${(whoami.stdout || '').trim().split('\n')[0]}`);
    console.log(`\nFetching deployments for "${projectName}" (this may page through --next)...`);
    all = listDeployments(projectName, args.scope);
  }
  if (all.length === 0) {
    console.log('No deployments found for this project.');
    return;
  }
  const protectedDeployment = findCurrentProduction(all);
  if (protectedDeployment) {
    console.log(`Protected (newest READY production, never deletable here): ${protectedDeployment.url}`);
  } else {
    console.log('Warning: no READY production deployment found. Nothing is auto-protected — check before you delete.');
  }
  const deletable = protectedDeployment
    ? all.filter((d) => d.url !== protectedDeployment.url)
    : all;
  console.log(`Found ${all.length} deployment(s), ${deletable.length} deletable after the production guard.`);

  const filter = await select({
    message: 'Which deployments do you want to choose from?',
    choices: [
      { name: 'All (except current production)', value: 'all' },
      { name: 'Older than 7 days', value: 'older7' },
      { name: 'Older than 30 days', value: 'older30' },
      { name: 'Preview only', value: 'preview' },
      { name: 'Failed / canceled only (ERROR, CANCELED, BLOCKED)', value: 'failed' },
      { name: 'Custom age in days…', value: 'custom' },
    ],
  });

  let customDays = null;
  if (filter === 'custom') {
    const raw = await input({
      message: 'Delete deployments older than how many days?',
      validate: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? true : 'Enter a number greater than 0';
      },
    });
    customDays = Number(raw);
  }

  // Oldest first: the cleanup list reads in deletion order.
  const candidates = applyFilter(deletable, filter, customDays).sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0));
  if (candidates.length === 0) {
    console.log('Nothing matches that filter. Nothing deleted.');
    return;
  }
  console.log(`\n${candidates.length} candidate(s). Arrow keys move, Space ticks, "a" toggles all, Enter confirms the selection.`);

  const selectedUrls = await checkbox({
    message: 'Select deployments to delete:',
    pageSize: 15,
    choices: candidates.map((d) => ({ name: formatRow(d), value: d.url, checked: false })),
  });
  if (selectedUrls.length === 0) {
    console.log('Nothing selected. Nothing deleted.');
    return;
  }
  const selected = candidates.filter((d) => selectedUrls.includes(d.url));
  printSummary(selected);

  if (args.dryRun) {
    console.log('\n--dry-run: nothing deleted.');
    return;
  }

  const ok = await confirm({
    message: `Delete ${selected.length} deployment(s) from "${projectName}"? This cannot be undone.`,
    default: false,
  });
  if (!ok) {
    console.log('Cancelled. Nothing deleted.');
    return;
  }

  if (args.demo) {
    console.log(`\nDEMO: would delete ${selected.length} deployment(s). Nothing was deleted (demo mode).`);
    return;
  }

  // Fresh re-check guard: abort if the protected deployment changed,
  // and drop any selected URL that no longer exists.
  console.log('\nRe-checking before deletion…');
  const fresh = listDeployments(projectName, args.scope);
  const freshProtected = findCurrentProduction(fresh);
  if (protectedDeployment && freshProtected && freshProtected.url !== protectedDeployment.url) {
    console.error(`ABORTED: current production changed (${protectedDeployment.url} -> ${freshProtected.url}). Nothing deleted. Re-run the tool.`);
    process.exitCode = 1;
    return;
  }
  const freshUrls = new Set(fresh.map((d) => d.url));
  const stillThere = selected.filter((d) => freshUrls.has(d.url));
  const gone = selected.filter((d) => !freshUrls.has(d.url));
  if (gone.length > 0) console.log(`Skipping ${gone.length} already-gone deployment(s).`);
  if (stillThere.length === 0) {
    console.log('Nothing left to delete. Nothing deleted.');
    return;
  }

  let succeeded = 0;
  const failed = [];
  for (let i = 0; i < stillThere.length; i += BATCH_SIZE) {
    const batch = stillThere.slice(i, i + BATCH_SIZE);
    const urls = batch.map((d) => d.url);
    console.log(`\nDeleting batch ${Math.floor(i / BATCH_SIZE) + 1} (${urls.length} deployment(s))…`);
    // NOTE: only deployment URLs go here. Never the project name.
    const result = runVercel(['remove', ...urls, '--yes'], args.scope);
    if (result.status === 0) {
      succeeded += urls.length;
      console.log(`Removed ${urls.length}.`);
    } else {
      // A batch can hang or fail after deleting some server-side
      // (seen in the wild). Do not re-run blindly: re-list to verify.
      failed.push(...urls);
      console.error(`Batch failed (exit ${result.status}). Output:\n${(result.stderr || result.stdout || '').trim()}`);
      console.error('Re-run this tool to list what remains before retrying — do not assume the whole batch failed.');
    }
  }

  console.log(`\nDone. Deleted: ${succeeded}, failed: ${failed.length}.`);
  if (failed.length > 0) {
    console.log('Failed URLs:');
    for (const u of failed) console.log(`  - ${u}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    if (err && (err.name === 'ExitPromptError' || err.code === 'ERR_USE_AFTER_CLOSE')) {
      console.log('\nCancelled. Nothing deleted.');
      return;
    }
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}
