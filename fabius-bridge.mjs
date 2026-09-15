#!/usr/bin/env node
// Fabius bridge — one person's HQ bot. Born as Fabius Bigsby (Andrew's); the same file now
// runs any per-person Fabius (Augustus for Dan, and the next ones) — only the config differs.
//
// One process, zero dependencies. Polls the person's Ops channel on hq.fabai.us as the
// bot user, hands each new human message to Claude (the `claude` CLI must be installed
// and signed in), and posts the answer back into the channel as the bot.
//
// Config lives OUTSIDE the repo — the API key must never be committed. See SETUP.md.
//   default          ~/.bigsby/config.json            (Andrew's install, unchanged)
//   FABIUS_HOME=dir  <dir>/config.json                (every later bot; set in its plist)
// Optional config keys botName, person, identity turn this into a different Fabius.
//
//   node bigsby.mjs           poll forever
//   node bigsby.mjs --once    one poll cycle (for testing)

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Bumped by release.sh. Every running bridge compares this against the release feed's manifest.
const VERSION = '2026.09.14.2';
const SELF = fileURLToPath(import.meta.url);
if (process.argv.includes('--version')) { console.log(VERSION); process.exit(0); }

const DIR = process.env.FABIUS_HOME || join(homedir(), '.bigsby');
let CONFIG;
try {
  CONFIG = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
} catch (e) {
  // Never let a parser error print here: V8 embeds a slice of the file, and the file holds the key.
  console.error(`config unreadable at ${join(DIR, 'config.json')} (${e.code || 'bad JSON'})`);
  process.exit(1);
}
const STATE_PATH = join(DIR, 'state.json');
const LOG_PATH = join(DIR, 'bridge.log');

const {
  hq = 'https://hq.fabai.us',
  apiKey,
  channelId,
  botPartnerId,
  pollSeconds = 30,
  claudeCmd = 'claude',
  botName = 'Fabius Bigsby',
  person = 'Andrew Mendez',
  // Pull control (2026-09-14, Malik: "fix it to where we have pull control"). The operator pushes
  // a release to the feed; every bridge follows on its own within updateHours. No partner ever
  // runs a git pull again. autoUpdate:false in config.json opts one install out.
  updateUrl = 'https://raw.githubusercontent.com/FabAiAgency/fabius-bridge-releases/main',
  autoUpdate = true,
  updateHours = 6,
} = CONFIG;

if (!apiKey || !channelId || !botPartnerId) {
  console.error('config.json needs apiKey, channelId, botPartnerId — see SETUP.md');
  process.exit(1);
}

const log = (line) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try { appendFileSync(LOG_PATH, stamped + '\n'); } catch {}
};

async function odoo(model, method, body) {
  const resp = await fetch(`${hq}/json/2/${model}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${model}/${method} HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

const loadState = () => {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
};
const saveState = (s) => writeFileSync(STATE_PATH, JSON.stringify(s));

const stripHtml = (html) =>
  (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .trim();

const escapeHtml = (t) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Plain text -> simple paragraphs so it renders like a human message in Discuss.
const toHtml = (text) =>
  text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');

const IDENTITY = CONFIG.identity ||
  `You are ${botName}, the AI operations partner for ${person} at Fab Ai. ` +
  `You are talking in a group chat with ${person.split(' ')[0]} (and sometimes Malik). Answer the ` +
  'newest message directly, briefly, and concretely. No preamble, no signatures. ' +
  'If a request needs something you cannot do from a chat reply, say exactly what ' +
  'you would need.';

// Anything posted in the channel reaches this prompt, so Claude runs with tools
// off: chat in, text out, nothing else. Without these flags it inherits the
// operator's own Claude Code permissions and any channel member can reach the
// shell on the machine running the bridge.
//
// Deliberately an allowlist, not a denylist. An empty --allowedTools denies
// anything not named, so a capability the operator adds later (an MCP
// connector for mail, calendar, books) is excluded by default instead of
// needing to be remembered and blocked. --strict-mcp-config with no
// --mcp-config loads no MCP servers at all, so connectors never reach this
// invocation even when they are configured for the operator's own Claude.
// --allowedTools '' only withholds pre-approval; tools that never prompt (Read, Glob, Grep)
// stay reachable, so a channel member could ask the bot to print its own config.json. --tools ''
// removes the tool set itself (Claude Code 2.1+). Detected once from --help so an older CLI on a
// partner's machine keeps working with the narrower fence instead of failing every reply.
let TOOLS_OFF = [];
try {
  const help = execFileSync(claudeCmd, ['--help'], { encoding: 'utf8', timeout: 15_000 });
  if (/--tools\b/.test(help)) TOOLS_OFF = ['--tools', ''];
} catch {}

function askClaude(prompt) {
  return new Promise((resolve) => {
    execFile(
      claudeCmd,
      [
        '-p', `${IDENTITY}\n\n---\n${prompt}`,
        '--output-format', 'text',
        '--permission-mode', 'manual',
        '--allowedTools', '',
        ...TOOLS_OFF,
        '--strict-mcp-config',
      ],
      // stdin closed: the CLI otherwise waits three seconds for piped input on every reply.
      { timeout: 180_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      (err, stdout, stderr) => {
        if (err) {
          // err.message carries the whole command line, identity and the person's message;
          // log the code and stderr only.
          log(`claude error: ${err.code || err.signal || 'failed'} ${String(stderr || '').slice(0, 200)}`);
          resolve(null);
        } else resolve(stdout.trim());
      },
    );
  });
}

async function postReply(html) {
  await odoo('discuss.channel', 'message_post', {
    ids: [channelId],
    body: html,
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_comment',
    body_is_html: true,
  });
}

async function newestMessageId() {
  const rows = await odoo('mail.message', 'search_read', {
    domain: [['model', '=', 'discuss.channel'], ['res_id', '=', channelId]],
    fields: ['id'],
    order: 'id desc',
    limit: 1,
  });
  return rows.length ? rows[0].id : 0;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

// Fetch the feed's manifest; if it names a newer version, stage every file, verify each sha256,
// syntax-check the scripts, then swap them in and return true so the caller exits and launchd
// restarts the new code. Any failure leaves the running install untouched. config.json is never
// part of a release.
async function selfUpdate() {
  if (!autoUpdate) return false;
  let manifest;
  try { manifest = JSON.parse(await fetchText(`${updateUrl}/manifest.json`)); }
  catch (e) { log(`update check skipped: ${String(e.message).slice(0, 100)}`); return false; }
  if (!manifest?.version || manifest.version === VERSION || !manifest.files) return false;

  const staged = [];
  for (const [name, hash] of Object.entries(manifest.files)) {
    let body;
    try { body = await fetchText(`${updateUrl}/${name}`); }
    catch (e) { log(`update aborted: ${name}: ${String(e.message).slice(0, 80)}`); return false; }
    if (sha256(body) !== hash) { log(`update aborted: ${name} hash mismatch`); return false; }
    // The bridge file replaces THIS file whatever it is named locally; helpers land beside it and
    // in the config dir when a copy already lives there.
    const targets = name === 'fabius-bridge.mjs'
      ? [SELF]
      : [join(dirname(SELF), name), join(DIR, name)].filter((t, i) => i === 0 || existsSync(t));
    for (const target of targets) staged.push({ name, target, body });
  }
  // Staged copies keep the real extension (x.new.mjs, not x.mjs.new): node --check reads a .new
  // file as CommonJS and rejects every import line, which failed the first live test.
  const tmpFor = (target) => target.replace(/(\.[a-z]+)$/, '.new$1');
  const tmps = [];
  try {
    for (const f of staged) {
      const tmp = tmpFor(f.target);
      writeFileSync(tmp, f.body);
      tmps.push(tmp);
      if (/\.(mjs|cjs|js)$/.test(f.target)) execFileSync(process.execPath, ['--check', tmp], { stdio: 'ignore' });
    }
    for (const f of staged) renameSync(tmpFor(f.target), f.target);
  } catch (e) {
    for (const t of tmps) { try { unlinkSync(t); } catch {} }
    log(`update aborted: ${String(e.message).slice(0, 100)}`);
    return false;
  }
  log(`updated ${VERSION} -> ${manifest.version} (${staged.length} file(s)); restarting`);
  return true;
}

async function cycle(state) {
  // First run: start at the current tip so an old backlog is never replayed.
  if (!state.lastSeenId) {
    state.lastSeenId = await newestMessageId();
    saveState(state);
    log(`initialized cursor at message ${state.lastSeenId}`);
    return;
  }

  const rows = await odoo('mail.message', 'search_read', {
    domain: [
      ['model', '=', 'discuss.channel'],
      ['res_id', '=', channelId],
      ['id', '>', state.lastSeenId],
      ['message_type', '=', 'comment'],
    ],
    fields: ['id', 'author_id', 'body'],
    order: 'id asc',
    limit: 10,
  });

  for (const m of rows) {
    // Always advance past the message first: a crash mid-reply must never
    // cause the same message to be answered twice on restart.
    state.lastSeenId = m.id;
    saveState(state);

    const authorPartner = Array.isArray(m.author_id) ? m.author_id[0] : null;
    if (authorPartner === botPartnerId) continue; // never answer yourself

    const text = stripHtml(m.body);
    if (!text) continue;

    log(`msg ${m.id} from partner ${authorPartner} (${text.length} chars)`);
    const answer = await askClaude(text);
    if (!answer) {
      await postReply('<p>Hit a snag answering that one — check the bridge log on my machine.</p>');
      continue;
    }
    await postReply(toHtml(answer));
    log(`answered msg ${m.id} (${answer.length} chars)`);
  }
}

const once = process.argv.includes('--once');
if (process.argv.includes('--update')) {
  const changed = await selfUpdate();
  console.log(changed ? 'updated' : `current (${VERSION})`);
  process.exit(0);
}
const state = loadState();

log(`${botName} bridge ${VERSION} up — channel ${channelId}, polling every ${pollSeconds}s${once ? ' (single cycle)' : ''}`);

// --once is the installer's proving pass: keep it deterministic, no update there.
if (!once && await selfUpdate()) process.exit(0);
let lastUpdateCheck = Date.now();

for (;;) {
  try {
    await cycle(state);
  } catch (e) {
    log(`cycle error: ${String(e).slice(0, 300)}`);
  }
  if (once) break;
  if (Date.now() - lastUpdateCheck > updateHours * 3_600_000) {
    lastUpdateCheck = Date.now();
    if (await selfUpdate()) process.exit(0);
  }
  await new Promise((r) => setTimeout(r, pollSeconds * 1000));
}
