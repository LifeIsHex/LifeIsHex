#!/usr/bin/env node
// Redraws the profile cards in assets/ from live GitHub data.
// No dependencies. Needs Node 20+ (built-in fetch).
//
//   node scripts/generate.mjs
//
// Environment:
//   GH_LOGIN      profile to draw (default: the repository owner, else LifeIsHex)
//   GITHUB_TOKEN  optional; raises API limits and enables the GraphQL calendar
//   DATA_CACHE    optional path; reuse fetched data from this file if it exists,
//                 otherwise fetch and save it there (handy while changing the design)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGIN = process.env.GH_LOGIN || process.env.GITHUB_REPOSITORY_OWNER || 'LifeIsHex';
const TOKEN = process.env.GITHUB_TOKEN || '';

// ---------------------------------------------------------------- content

const GREETING = "Hi, I'm Mahdi";
const TAGLINE = 'I build web applications in PHP and native Windows tools in Delphi.';
const CHIPS = ['PHP', 'CodeIgniter', 'Laravel', 'MySQL', 'Docker', 'Delphi', 'Win32 API'];
// 16 bytes per row, so the two spaces after the full stop end the first row
const DUMP_TEXT = "Hi, I'm Mahdi.  Life is hex.";
const DUMP_HIGHLIGHT = 'Mahdi';

// ---------------------------------------------------------------- data

const UA = { 'User-Agent': `${LOGIN}-profile-cards` };

async function rest(path) {
  const headers = { ...UA, Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...UA, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors || res.status)}`);
  return body.data;
}

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

// Calendar of the last year plus the total of every year, through the API.
async function contributionsFromGraphql() {
  const first = await graphql(
    `query($login: String!) {
       user(login: $login) {
         contributionsCollection {
           contributionYears
           contributionCalendar {
             totalContributions
             weeks { contributionDays { date contributionCount contributionLevel } }
           }
         }
       }
     }`,
    { login: LOGIN },
  );
  const col = first.user.contributionsCollection;
  const days = col.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount, level: LEVELS[d.contributionLevel] ?? 0 }));

  const years = col.contributionYears;
  const fields = years
    .map(
      (y) =>
        `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") { contributionCalendar { totalContributions } }`,
    )
    .join('\n');
  const all = await graphql(`query($login: String!) { user(login: $login) { ${fields} } }`, { login: LOGIN });
  const allTime = years.reduce((sum, y) => sum + all.user[`y${y}`].contributionCalendar.totalContributions, 0);

  return { days, lastYear: col.contributionCalendar.totalContributions, allTime };
}

// Same numbers read from the public profile page, used when there is no token.
async function contributionsPage(query = '') {
  const res = await fetch(`https://github.com/users/${LOGIN}/contributions${query}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (!res.ok) throw new Error(`contributions page: HTTP ${res.status}`);
  const html = await res.text();
  const byId = new Map();
  for (const m of html.matchAll(/<td[^>]*data-date="([\d-]+)"[^>]*id="([^"]+)"[^>]*data-level="(\d)"/g)) {
    byId.set(m[2], { date: m[1], count: 0, level: Number(m[3]) });
  }
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>\s*(\d+|No) contribution/g)) {
    const day = byId.get(m[1]);
    if (day) day.count = m[2] === 'No' ? 0 : Number(m[2]);
  }
  const days = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) throw new Error('contributions page: no days found');
  return days;
}

async function contributionsFromPage(createdYear) {
  const days = await contributionsPage();
  let allTime = 0;
  for (let y = createdYear; y <= new Date().getUTCFullYear(); y++) {
    const year = await contributionsPage(`?from=${y}-01-01&to=${y}-12-31`);
    allTime += year.filter((d) => d.date.startsWith(String(y))).reduce((s, d) => s + d.count, 0);
  }
  return { days, lastYear: days.reduce((s, d) => s + d.count, 0), allTime };
}

async function fetchData() {
  const user = await rest(`/users/${LOGIN}`);
  const repos = await rest(`/users/${LOGIN}/repos?per_page=100&type=owner`);
  const own = repos.filter((r) => !r.fork);
  let downloads = 0;
  for (const repo of own) {
    const releases = await rest(`/repos/${LOGIN}/${repo.name}/releases?per_page=100`);
    for (const rel of releases) for (const a of rel.assets) downloads += a.download_count;
  }
  const createdYear = new Date(user.created_at).getUTCFullYear();

  let contributions;
  if (TOKEN) {
    try {
      contributions = await contributionsFromGraphql();
    } catch (err) {
      console.warn(`GraphQL calendar failed, reading the profile page instead: ${err.message}`);
    }
  }
  contributions ??= await contributionsFromPage(createdYear);

  return {
    login: LOGIN,
    createdYear,
    publicRepos: user.public_repos,
    stars: own.reduce((s, r) => s + r.stargazers_count, 0),
    downloads,
    ...contributions,
  };
}

function summarise(data) {
  const days = data.days;
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return {
    ...data,
    activeDays: days.filter((d) => d.count > 0).length,
    longestStreak: longest,
    yearsOnGitHub: new Date().getUTCFullYear() - data.createdYear,
  };
}

// ---------------------------------------------------------------- drawing

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;

const THEMES = {
  dark: {
    panel: '#10161d',
    bar: '#161e27',
    tile: '#161e27',
    border: '#2b3643',
    text: '#e6edf3',
    soft: '#a3b0bd',
    muted: '#6e7b89',
    accent: '#f2b632',
    accentSoft: 'rgba(242,182,50,0.14)',
    chip: '#1c2632',
    heat: ['#1a232e', '#5c3f0b', '#946410', '#d0911a', '#f8cd53'],
  },
  light: {
    panel: '#ffffff',
    bar: '#f6f8fa',
    tile: '#f6f8fa',
    border: '#d0d7de',
    text: '#1f2328',
    soft: '#57606a',
    muted: '#8b949e',
    accent: '#9a6700',
    accentSoft: 'rgba(191,135,0,0.14)',
    chip: '#eef1f4',
    heat: ['#eceff2', '#f9dc8c', '#eeb230', '#c27d0a', '#7d4e00'],
  },
};

const W = 840;
const PAD = 26;
const BAR_H = 38;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => n.toLocaleString('en-US');
const r2 = (n) => Math.round(n * 100) / 100;

// Pointy-top hexagon centred on (cx, cy) with circumradius r.
function hexPath(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    pts.push(`${r2(cx + r * Math.cos(a))},${r2(cy + r * Math.sin(a))}`);
  }
  return `M${pts.join('L')}Z`;
}

// Shared frame: a rounded panel with a title bar that names the "file".
function panel(t, height, file, right, body, title) {
  const clip = `clip-${file.replace(/\W/g, '')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<defs><clipPath id="${clip}"><rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="12"/></clipPath></defs>
<g clip-path="url(#${clip})">
<rect width="${W}" height="${height}" fill="${t.panel}"/>
<rect width="${W}" height="${BAR_H}" fill="${t.bar}"/>
<path d="M0 ${BAR_H + 0.5}H${W}" stroke="${t.border}"/>
</g>
<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="12" fill="none" stroke="${t.border}"/>
<path d="${hexPath(PAD + 5, BAR_H / 2, 7)}" fill="${t.accent}"/>
<text x="${PAD + 20}" y="${BAR_H / 2 + 4.5}" font-family="${MONO}" font-size="13" fill="${t.soft}">${esc(file)}</text>
<text x="${W - PAD}" y="${BAR_H / 2 + 4.5}" font-family="${MONO}" font-size="12" fill="${t.muted}" text-anchor="end">${esc(right)}</text>
${body}
</svg>
`;
}

function header(t) {
  const H = 272;
  let body = '';

  // faint honeycomb in the top-right corner
  const R = 22;
  const hw = Math.sqrt(3) * R;
  const cells = [
    [0, 0, 0.5], [1, 0, 0.32], [2, 0, 0.18], [3, 0, 0.08],
    [0.5, 1, 0.3], [1.5, 1, 0.16], [2.5, 1, 0.07],
    [0, 2, 0.12], [1, 2, 0.06],
  ];
  for (const [col, row, o] of cells) {
    const cx = W - PAD - R - col * hw;
    const cy = BAR_H + 34 + row * R * 1.5;
    body += `<path d="${hexPath(cx, cy, R - 2)}" fill="none" stroke="${t.accent}" stroke-opacity="${o}" stroke-width="1.5"/>\n`;
  }

  // mark, greeting, tagline
  const markX = PAD + 34;
  const markY = BAR_H + 62;
  body += `<path d="${hexPath(markX, markY, 34)}" fill="${t.accentSoft}" stroke="${t.accent}" stroke-width="2"/>
<text x="${markX}" y="${markY + 8}" font-family="${MONO}" font-size="22" font-weight="700" fill="${t.accent}" text-anchor="middle">0x</text>
<text x="${PAD + 88}" y="${BAR_H + 62}" font-family="${SANS}" font-size="38" font-weight="700" fill="${t.text}">${esc(GREETING)}</text>
<text x="${PAD + 89}" y="${BAR_H + 90}" font-family="${SANS}" font-size="15.5" fill="${t.soft}">${esc(TAGLINE)}</text>
`;

  // chips
  let x = PAD;
  const chipY = BAR_H + 122;
  for (const label of CHIPS) {
    const w = Math.round(label.length * 7.3 + 24);
    body += `<rect x="${x}" y="${chipY}" width="${w}" height="26" rx="13" fill="${t.chip}" stroke="${t.border}"/>
<text x="${x + w / 2}" y="${chipY + 17}" font-family="${MONO}" font-size="12" fill="${t.text}" text-anchor="middle">${esc(label)}</text>
`;
    x += w + 8;
  }

  // hex dump of DUMP_TEXT
  const bytes = [...Buffer.from(DUMP_TEXT, 'ascii')];
  const hiStart = DUMP_TEXT.indexOf(DUMP_HIGHLIGHT);
  const hiEnd = hiStart + DUMP_HIGHLIGHT.length;
  const dumpY = BAR_H + 186;
  body += `<path d="M${PAD} ${dumpY - 22}H${W - PAD}" stroke="${t.border}" stroke-dasharray="2 4"/>\n`;
  for (let row = 0; row * 16 < bytes.length; row++) {
    const slice = bytes.slice(row * 16, row * 16 + 16);
    const y = dumpY + row * 22;
    let hexCol = '';
    let ascii = '';
    slice.forEach((b, i) => {
      const hi = row * 16 + i >= hiStart && row * 16 + i < hiEnd;
      const fill = hi ? t.accent : t.soft;
      const weight = hi ? ' font-weight="700"' : '';
      hexCol += `<tspan fill="${fill}"${weight}>${b.toString(16).toUpperCase().padStart(2, '0')}</tspan>${i === 7 ? '  ' : ' '}`;
      ascii += `<tspan fill="${hi ? t.accent : t.text}"${weight}>${esc(String.fromCharCode(b))}</tspan>`;
    });
    const offset = (row * 16).toString(16).toUpperCase().padStart(8, '0');
    body += `<text x="${PAD}" y="${y}" font-family="${MONO}" font-size="13.5" fill="${t.muted}" xml:space="preserve">${offset}</text>
<text x="${PAD + 92}" y="${y}" font-family="${MONO}" font-size="13.5" xml:space="preserve">${hexCol}</text>
<text x="${PAD + 520}" y="${y}" font-family="${MONO}" font-size="13.5" fill="${t.muted}" xml:space="preserve">|${ascii}|</text>
`;
  }

  return panel(t, H, 'mahdi.hex', 'LifeIsHex', body, `${GREETING}. ${TAGLINE}`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];


// colours for the listing and for the digits drawn on each heat level
const SYNTAX = {
  dark: { reg: '#79c0ff', flow: '#7ee787', bp: '#f85149', onHeat: ['#6e7b89', '#f1dfb4', '#fff3d1', '#1c1300', '#1c1300'] },
  light: { reg: '#0550ae', flow: '#116329', bp: '#cf222e', onHeat: ['#8b949e', '#3d2a00', '#2b1d00', '#1f1300', '#ffffff'] },
};

const le32 = (n) => [0, 8, 16, 24].map((s) => ((n >>> s) & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(' ');
const imm = (n) => `0x${n.toString(16).toUpperCase()}`;

// The numbers as a disassembly listing: each one is loaded into a register,
// with real x64 encodings, addresses and jump offsets.
function cpu(t, d, today, name) {
  const sx = SYNTAX[name];
  const base = 0x140001000;
  const movs = [
    ['eax', 'B8', d.lastYear, 'contributions, last year', num(d.lastYear)],
    ['ebx', 'BB', d.activeDays, 'active days, last year', num(d.activeDays)],
    ['ecx', 'B9', d.longestStreak, 'longest streak, last year', `${num(d.longestStreak)} days`],
    ['edx', 'BA', d.allTime, `contributions since ${d.createdYear}`, num(d.allTime)],
    ['esi', 'BE', d.publicRepos, 'public repositories', num(d.publicRepos)],
    ['edi', 'BF', d.stars, 'stars earned', num(d.stars)],
    ['r8d', '41 B8', d.downloads, 'release downloads', num(d.downloads)],
    ['r9d', '41 B9', d.yearsOnGitHub, `on GitHub since ${d.createdYear}`, `${num(d.yearsOnGitHub)} years`],
  ];
  // [bytes, mnemonic, operands as [text, kind] parts, comment label, comment value]
  const lines = [
    ['55', 'push', [['rbp', 'reg']]],
    ['48 8B EC', 'mov', [['rbp', 'reg'], [', '], ['rsp', 'reg']]],
    ...movs.map(([reg, op, value, label, shown]) => [
      `${op} ${le32(value)}`, 'mov', [[reg, 'reg'], [', '], [imm(value), 'imm']], label, shown,
    ]),
  ];
  const size = (l) => l[0].split(' ').length;
  let addr = base;
  const rows = lines.map((l) => { const row = { addr, l }; addr += size(l); return row; });
  const loopTop = rows[2].addr;
  const callAt = addr;
  const callTarget = 0x140002000;
  rows.push({ addr: callAt, current: true, l: [`E8 ${le32(callTarget - (callAt + 5))}`, 'call', [['<github.commit>', 'flow']], 'redrawn nightly', today] });
  const jmpAt = callAt + 5;
  const rel8 = (loopTop - (jmpAt + 2)) & 0xff;
  rows.push({ addr: jmpAt, l: [`EB ${rel8.toString(16).toUpperCase().padStart(2, '0')}`, 'jmp', [['short ', ''], [loopTop.toString(16).toUpperCase(), 'flow']], 'same again tomorrow', ''] });

  const top = BAR_H + 30;
  const lh = 23;
  const X = { gutter: PAD + 6, addr: PAD + 22, bytes: PAD + 108, mn: PAD + 262, ops: PAD + 306, cm: PAD + 446 };
  const text = (x, y, fill, content, extra = '') =>
    `<text x="${x}" y="${y}" font-family="${MONO}" font-size="12.5" fill="${fill}" xml:space="preserve"${extra}>${content}</text>\n`;
  let body = '';
  rows.forEach(({ addr: a, l, current }, i) => {
    const y = top + i * lh;
    const [bytes, mn, ops, label, shown] = l;
    if (current) {
      body += `<rect x="${PAD - 8}" y="${y - 15.5}" width="${W - PAD * 2 + 16}" height="${lh}" rx="5" fill="${t.accentSoft}"/>\n`;
      body += `<path d="M${X.gutter - 5} ${y - 9}l8 5l-8 5z" fill="${t.accent}"/>\n`;
    }
    if (i === 2) body += `<circle cx="${X.gutter}" cy="${y - 4}" r="4.5" fill="${sx.bp}"/>\n`;
    body += text(X.addr, y, t.muted, a.toString(16).toUpperCase());
    body += text(X.bytes, y, t.soft, bytes);
    const flow = mn === 'call' || mn === 'jmp';
    body += text(X.mn, y, flow ? sx.flow : t.text, mn, ' font-weight="700"');
    const colours = { reg: sx.reg, imm: t.accent, flow: sx.flow };
    body += text(X.ops, y, t.text, ops.map(([s, kind]) => `<tspan fill="${colours[kind] || t.text}"${kind === 'imm' ? ' font-weight="700"' : ''}>${esc(s)}</tspan>`).join(''));
    if (label) {
      body += text(X.cm, y, t.muted, `; ${esc(label)}${shown ? ':' : ''}`);
      if (shown) body += `<text x="${W - PAD}" y="${y}" font-family="${MONO}" font-size="12.5" font-weight="700" fill="${t.text}" text-anchor="end">${esc(shown)}</text>\n`;
    }
  });
  const H = top + (rows.length - 1) * lh + 26;
  const title = `GitHub numbers for ${d.login}, written as a disassembly listing: ${movs.map(([, , , label, shown]) => `${shown} ${label}`).join('; ')}.`;
  return panel(t, H, 'CPU: LifeIsHex.exe', 'paused at breakpoint', body, title);
}

// The last 26 weeks as a memory dump: one hex byte per day, weeks as columns.
function dump(t, d, name) {
  const sx = SYNTAX[name];
  const all = [];
  for (const day of d.days) {
    const dow = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || !all.length) all.push([]);
    all[all.length - 1].push({ ...day, dow });
  }
  const weeks = all.slice(-26);
  const labelW = 44;
  const gridX = PAD + labelW;
  const cw = (W - PAD - gridX) / weeks.length;
  const top = BAR_H + 46;
  const rh = 24;
  let body = '';
  const starts = [];
  weeks.forEach((week, col) => {
    const month = Number(week[0].date.slice(5, 7)) - 1;
    if (!starts.length || starts[starts.length - 1].month !== month) starts.push({ month, col });
  });
  starts.forEach(({ month, col }, i) => {
    const next = starts[i + 1]?.col ?? weeks.length + 1;
    if (next - col < 2) return;
    body += `<text x="${r2(gridX + col * cw + 2)}" y="${top - 12}" font-family="${MONO}" font-size="11" fill="${t.soft}">${MONTHS[month]}</text>\n`;
  });
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((n, dow) => {
    body += `<text x="${PAD}" y="${top + dow * rh + 14.5}" font-family="${MONO}" font-size="11.5" fill="${t.muted}">${n}</text>\n`;
  });
  let total = 0;
  weeks.forEach((week, col) => {
    for (const day of week) {
      total += day.count;
      const x = r2(gridX + col * cw);
      const y = top + day.dow * rh;
      const byte = Math.min(day.count, 255).toString(16).toUpperCase().padStart(2, '0');
      body += `<rect x="${x}" y="${y}" width="${r2(cw - 3)}" height="${rh - 4}" rx="4" fill="${t.heat[day.level]}"/>
<text x="${r2(x + (cw - 3) / 2)}" y="${y + 14.5}" font-family="${MONO}" font-size="11.5" fill="${sx.onHeat[day.level]}" text-anchor="middle"${day.level ? ' font-weight="700"' : ''}>${byte}</text>\n`;
    }
  });
  const bottom = top + 7 * rh + 22;
  body += `<text x="${PAD}" y="${bottom}" font-family="${MONO}" font-size="12" fill="${t.soft}">one byte per day: that day's contributions, in hex</text>\n`;
  let lx = W - PAD - 38;
  body += `<text x="${W - PAD}" y="${bottom}" font-family="${MONO}" font-size="12" fill="${t.soft}" text-anchor="end">More</text>\n`;
  for (let level = 4; level >= 0; level--) {
    lx -= 18;
    body += `<rect x="${lx}" y="${bottom - 11}" width="14" height="14" rx="3" fill="${t.heat[level]}"/>\n`;
  }
  body += `<text x="${lx - 8}" y="${bottom}" font-family="${MONO}" font-size="12" fill="${t.soft}" text-anchor="end">Less</text>\n`;
  const H = bottom + 24;
  const title = `${num(total)} contributions in the last 26 weeks, shown as one hex byte per day.`;
  return panel(t, H, 'Dump: contributions', `${num(total)} in the last 26 weeks`, body, title);
}

// ---------------------------------------------------------------- main

async function loadData() {
  const cache = process.env.DATA_CACHE;
  if (cache && existsSync(cache)) return JSON.parse(await readFile(cache, 'utf8'));
  const data = await fetchData();
  if (cache) await writeFile(cache, JSON.stringify(data));
  return data;
}

const data = summarise(await loadData());
const today = new Date().toISOString().slice(0, 10);
await mkdir(join(ROOT, 'assets'), { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(join(ROOT, 'assets', `header-${name}.svg`), header(t));
  await writeFile(join(ROOT, 'assets', `cpu-${name}.svg`), cpu(t, data, today, name));
  await writeFile(join(ROOT, 'assets', `dump-${name}.svg`), dump(t, data, name));
}
console.log(
  `${data.login}: ${data.lastYear} contributions last year, ${data.activeDays} active days, ` +
    `longest streak ${data.longestStreak}, all time ${data.allTime}, ${data.publicRepos} repos, ` +
    `${data.stars} stars, ${data.downloads} downloads`,
);
