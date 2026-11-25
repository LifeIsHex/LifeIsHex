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
  let best = days[0];
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
    if (d.count > best.count) best = d;
  }
  return {
    ...data,
    activeDays: days.filter((d) => d.count > 0).length,
    longestStreak: longest,
    busiest: best,
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
const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
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

function stats(t, d, today) {
  const tiles = [
    [d.lastYear, num(d.lastYear), 'contributions, last year'],
    [d.activeDays, num(d.activeDays), 'active days, last year'],
    [d.longestStreak, `${num(d.longestStreak)} days`, 'longest streak, last year'],
    [d.allTime, num(d.allTime), `contributions since ${d.createdYear}`],
    [d.publicRepos, num(d.publicRepos), 'public repositories'],
    [d.stars, num(d.stars), 'stars earned'],
    [d.downloads, num(d.downloads), 'release downloads'],
    [d.yearsOnGitHub, `${num(d.yearsOnGitHub)} years`, `on GitHub, since ${d.createdYear}`],
  ];
  const cols = 4;
  const gap = 12;
  const tw = (W - PAD * 2 - gap * (cols - 1)) / cols;
  const th = 84;
  const top = BAR_H + 22;
  let body = '';
  tiles.forEach(([raw, big, label], i) => {
    const x = PAD + (i % cols) * (tw + gap);
    const y = top + Math.floor(i / cols) * (th + gap);
    body += `<rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="10" fill="${t.tile}" stroke="${t.border}"/>
<path d="${hexPath(x + 20, y + 22, 6)}" fill="${t.accent}"/>
<text x="${x + tw - 14}" y="${y + 26}" font-family="${MONO}" font-size="11" fill="${t.muted}" text-anchor="end">${hex(raw)}</text>
<text x="${x + 14}" y="${y + 56}" font-family="${SANS}" font-size="24" font-weight="700" fill="${t.text}">${esc(big)}</text>
<text x="${x + 14}" y="${y + 73}" font-family="${SANS}" font-size="11.5" fill="${t.soft}">${esc(label)}</text>
`;
  });
  const H = top + 2 * th + gap + 22;
  const title = `GitHub numbers for ${d.login}: ${tiles.map(([, big, label]) => `${big} ${label}`).join('; ')}.`;
  return panel(t, H, 'stats.hex', `redrawn nightly · ${today}`, body, title);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function activity(t, d) {
  // weeks run Sunday to Saturday, one column each; odd rows shift half a cell
  const weeks = [];
  for (const day of d.days) {
    const dow = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || !weeks.length) weeks.push([]);
    weeks[weeks.length - 1].push({ ...day, dow });
  }
  const labelW = 34;
  const gridX = PAD + labelW;
  const cw = (W - PAD - gridX) / (weeks.length + 0.5);
  const R = cw / Math.sqrt(3);
  const top = BAR_H + 44;
  const cy = (dow) => top + R + dow * R * 1.5;
  const cx = (col, dow) => gridX + cw / 2 + col * cw + (dow % 2 ? cw / 2 : 0);

  let body = '';
  // a month is labelled at its first column, unless the next label would crowd it
  const starts = [];
  weeks.forEach((week, col) => {
    const month = Number(week[0].date.slice(5, 7)) - 1;
    if (!starts.length || starts[starts.length - 1].month !== month) starts.push({ month, col });
  });
  starts.forEach(({ month, col }, i) => {
    const next = starts[i + 1]?.col ?? weeks.length + 1;
    if (next - col < 3) return;
    body += `<text x="${r2(gridX + col * cw)}" y="${top - 10}" font-family="${MONO}" font-size="11" fill="${t.soft}">${MONTHS[month]}</text>\n`;
  });
  weeks.forEach((week, col) => {
    for (const day of week) {
      body += `<path d="${hexPath(cx(col, day.dow), cy(day.dow), R - 0.9)}" fill="${t.heat[day.level]}"/>\n`;
    }
  });
  for (const [dow, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    body += `<text x="${PAD}" y="${r2(cy(dow) + 4)}" font-family="${MONO}" font-size="11" fill="${t.soft}">${name}</text>\n`;
  }

  const bottom = cy(6) + R + 30;
  const busy = new Date(`${d.busiest.date}T00:00:00Z`);
  const busyLabel = `${busy.getUTCDate()} ${MONTHS[busy.getUTCMonth()]} ${busy.getUTCFullYear()}`;
  body += `<text x="${PAD}" y="${r2(bottom)}" font-family="${MONO}" font-size="12" fill="${t.soft}">busiest day: ${busyLabel}, ${num(d.busiest.count)} contributions</text>\n`;
  let lx = W - PAD - 38;
  body += `<text x="${W - PAD}" y="${r2(bottom)}" font-family="${MONO}" font-size="12" fill="${t.soft}" text-anchor="end">More</text>\n`;
  for (let level = 4; level >= 0; level--) {
    lx -= 16;
    body += `<path d="${hexPath(lx + 8, bottom - 4, 7.5)}" fill="${t.heat[level]}"/>\n`;
  }
  body += `<text x="${lx - 6}" y="${r2(bottom)}" font-family="${MONO}" font-size="12" fill="${t.soft}" text-anchor="end">Less</text>\n`;

  const H = Math.round(bottom + 22);
  const title = `${num(d.lastYear)} contributions in the last year on ${d.activeDays} active days. Busiest day: ${busyLabel} with ${d.busiest.count}.`;
  return panel(t, H, 'contributions.hex', `${num(d.lastYear)} in the last year`, body, title);
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
  await writeFile(join(ROOT, 'assets', `stats-${name}.svg`), stats(t, data, today));
  await writeFile(join(ROOT, 'assets', `contributions-${name}.svg`), activity(t, data));
}
console.log(
  `${data.login}: ${data.lastYear} contributions last year, ${data.activeDays} active days, ` +
    `longest streak ${data.longestStreak}, all time ${data.allTime}, ${data.publicRepos} repos, ` +
    `${data.stars} stars, ${data.downloads} downloads`,
);
