const $ = selector => document.querySelector(selector);

const glyphs = {
  activity: ['M3 12h3l3-7 4 14 3-7h5'],
  search: ['M21 21l-4.3-4.3', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'],
  calendar: ['M8 3v4m8-4v4M4 10h16', 'M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z'],
  layers: ['m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5'],
  clock: ['M12 8v4l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0Z'],
  tokens: ['m13 2-8 11h6l-1 9 9-12h-6l1-8Z'],
  file: ['M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  left: ['m14 6-6 6 6 6'],
  right: ['m10 6 6 6-6 6'],
  down: ['m6 9 6 6 6-6'],
  close: ['m6 6 12 12M6 18 18 6'],
  copy: ['M9 9h11v11H9z', 'M15 6V4H4v11h2'],
  list: ['M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01'],
};

function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of glyphs[name]) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter(child => child != null));
  return node;
}

function button(className, label, glyph) {
  const node = el('button', className, icon(glyph));
  node.type = 'button';
  node.setAttribute('aria-label', label);
  node.title = label;
  return node;
}

const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const number = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
let zone = 'UTC';
let clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone });
const parseDay = day => new Date(day + 'T12:00:00');
const formatDay = day => shortDay.format(parseDay(day));

function dayOffset(day, offset) {
  const date = parseDay(day);
  date.setDate(date.getDate() + offset);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-');
}

function duration(ms) {
  if (ms < 60_000) return ms > 0 ? '<1m' : '0m';
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
}

function count(value, noun) {
  return `${number.format(value)} ${noun}${value === 1 ? '' : 's'}`;
}

function timeRange(entry) {
  const start = clock.format(entry.start);
  const end = clock.format(entry.end);
  return start === end ? start : `${start}–${end}`;
}

const projectColors = [
  'violet', 'jade', 'blue', 'rust', 'rose', 'ink', 'ochre',
  'teal', 'plum', 'olive', 'sky', 'copper', 'crimson', 'slate',
];
const projectColor = new Map();
const search = $('#search');
const detail = $('#detail');
const detailContent = $('#detail-content');
const main = $('#main');
let snapshot;
let snapshotText;
let day;
let project = '';
let query = '';
let savedDay;
let detailRequest = 0;
let detailTrigger;
let briefOpen = false;
const collapsed = new Set();

$('#bar-icon').append(icon('activity'));
$('#search-icon').append(icon('search'));
$('#close-detail').append(icon('close'));
$('#close-detail').addEventListener('click', () => detail.close());
detail.addEventListener('click', event => {
  if (event.target === detail) detail.close();
});
detail.addEventListener('close', () => {
  detailRequest++;
  detailTrigger?.focus({ preventScroll: true });
  detailTrigger = null;
});

document.addEventListener('keydown', event => {
  if (detail.open) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    search.focus();
    search.select();
  }
});
if (!navigator.platform.startsWith('Mac')) $('#search-shortcut').textContent = 'Ctrl K';

function matches(entry) {
  return (!project || entry.cwd === project) && (!query || [
    entry.title, entry.preview, entry.projectName, entry.cwd, ...entry.files,
  ].some(value => value.toLocaleLowerCase().includes(query)));
}

function byDay() {
  const days = new Map();
  for (const entry of snapshot.sessions) {
    if (!matches(entry)) continue;
    if (!days.has(entry.day)) days.set(entry.day, []);
    days.get(entry.day).push(entry);
  }
  return days;
}

function chooseDay(next, focus = false) {
  if (!next || next === day) return;
  day = next;
  render();
  if (focus) {
    main.querySelector('h1')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

function applyFilter() {
  const dates = byDay();
  if (!dates.has(day)) {
    day = dates.keys().next().value || day;
  }
  render();
}

search.addEventListener('input', () => {
  if (!snapshot) return;
  const next = search.value.trim().toLocaleLowerCase();
  if (!query && next) savedDay = day;
  if (query && !next && savedDay) day = savedDay;
  query = next;
  applyFilter();
});
search.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !search.value) return;
  search.value = '';
  search.dispatchEvent(new Event('input'));
});

function renderDates(days) {
  const dates = $('#dates');
  const { scrollTop, scrollLeft } = dates;
  dates.replaceChildren();
  for (const [date, entries] of days) {
    const today = date === snapshot.today;
    const dateText = today ? 'Today' : formatDay(date);
    const descriptor = today ? formatDay(date) : weekday.format(parseDay(date));
    const item = el('button', 'date-item',
      icon('calendar'),
      el('span', 'date-text', el('span', 'date-name', dateText), el('span', 'date-description', descriptor)),
      el('span', 'date-count', number.format(entries.length)));
    item.type = 'button';
    item.title = `${dayFormat.format(parseDay(date))} · ${count(entries.length, 'session')}`;
    item.setAttribute('aria-label', item.title);
    if (date === day) item.setAttribute('aria-current', 'date');
    item.addEventListener('click', () => chooseDay(date, true));
    dates.append(item);
  }
  if (!days.size) dates.append(el('p', 'sidebar-empty', 'No matching dates'));
  dates.scrollTop = scrollTop;
  dates.scrollLeft = scrollLeft;

  const recent = Array.from({ length: 14 }, (_, index) => dayOffset(snapshot.today, index - 13));
  const peak = Math.max(1, ...recent.map(date => days.get(date)?.length || 0));
  const pulse = $('#pulse');
  pulse.replaceChildren();
  for (const date of recent) {
    const sessions = days.get(date)?.length || 0;
    const cell = el(sessions ? 'button' : 'span', 'pulse-cell', el('span', 'pulse-fill'));
    cell.title = `${formatDay(date)} · ${count(sessions, 'session')}`;
    cell.firstChild.style.height = `${sessions ? Math.max(20, sessions * 100 / peak) : 10}%`;
    if (sessions) {
      cell.type = 'button';
      cell.setAttribute('aria-label', cell.title);
      if (date === day) cell.setAttribute('aria-current', 'date');
      cell.addEventListener('click', () => chooseDay(date, true));
    }
    pulse.append(cell);
  }
  $('#pulse-range').replaceChildren(el('span', '', formatDay(recent[0])), el('span', '', formatDay(recent[13])));
}

function metric(glyph, label, value, caption, title) {
  const tile = el('section', 'metric',
    el('div', 'metric-label', icon(glyph), el('span', '', label)),
    el('div', 'metric-value', value), el('div', 'metric-caption', caption));
  if (title) tile.title = title;
  return tile;
}

function projectGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.cwd)) {
      groups.set(entry.cwd, {
        name: entry.projectName, cwd: entry.cwd, sessions: [], tokens: 0, color: projectColor.get(entry.cwd),
      });
    }
    const group = groups.get(entry.cwd);
    group.sessions.push(entry);
    group.tokens += entry.tokens.total;
  }
  return [...groups.values()].sort((a, b) =>
    b.tokens - a.tokens || b.sessions.length - a.sessions.length);
}

function projectIndex(groups, cards) {
  const hasTokens = groups.some(group => group.tokens > 0);
  const unit = hasTokens ? 'tokens' : 'sessions';
  const weight = group => hasTokens ? group.tokens : group.sessions.length;
  const total = groups.reduce((sum, group) => sum + weight(group), 0);
  const segments = el('div', 'segments');
  segments.setAttribute('aria-hidden', 'true');
  const index = el('ul', 'project-index-list');
  for (const [position, group] of groups.entries()) {
    const percent = Math.round(weight(group) / total * 100);
    if (weight(group)) {
      const segment = el('div', `segment tone-${group.color}`);
      segment.style.flexGrow = weight(group);
      segment.title = `${group.name} · ${percent}%`;
      segments.append(segment);
    }
    const parent = group.cwd.slice(0, group.cwd.lastIndexOf('/')) || '/';
    const parts = parent.split('/').filter(Boolean);
    const location = parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parent;
    const jump = el('button', `project-jump tone-${group.color}`,
      el('span', 'project-jump-mark'),
      el('span', 'project-jump-label', el('strong', '', group.name),
        group.cwd && group.cwd !== '/' ? el('span', 'project-jump-path', location) : null),
      el('span', 'project-share', `${percent}%`));
    jump.type = 'button';
    jump.title = group.cwd || group.name;
    jump.setAttribute('aria-label', `Jump to ${group.cwd || group.name} · ${percent}% of ${unit}`);
    jump.addEventListener('click', () => {
      const card = cards[position];
      card.open = true;
      card.querySelector('summary').focus({ preventScroll: true });
      card.scrollIntoView({ block: 'start' });
    });
    index.append(el('li', '', jump));
  }
  return el('section', 'project-index',
    el('div', 'project-index-header',
      el('div', 'project-index-heading', el('h2', '', 'Projects'), el('span', 'section-count', number.format(groups.length))),
      el('p', 'project-index-caption', `Share of ${unit}`),
      segments),
    index);
}

function projectFilter() {
  const available = new Map(snapshot.sessions.map(entry => [entry.cwd, entry.projectName]));
  const select = el('select', '');
  select.id = 'project';
  select.setAttribute('aria-label', 'Filter by project');
  select.append(new Option('All projects', ''));
  const labels = [...available.values()];
  for (const [cwd, name] of [...available].sort((a, b) => a[1].localeCompare(b[1]))) {
    if (!cwd) continue;
    const label = labels.filter(value => value === name).length > 1 ? cwd : name;
    const option = new Option(label, cwd);
    option.title = cwd;
    select.append(option);
  }
  select.value = project;
  select.addEventListener('change', () => {
    project = select.value;
    applyFilter();
    $('#project')?.focus({ preventScroll: true });
  });
  return el('div', 'select-wrap', icon('folder'), select, icon('down'));
}

function sessionRow(entry, peakTokens) {
  const label = el('span', 'session-title', entry.title);
  const trimmedTitle = entry.title.replace(/…$/, '').toLocaleLowerCase();
  const preview = entry.preview && !entry.preview.toLocaleLowerCase().startsWith(trimmedTitle)
    ? el('span', 'session-preview', entry.preview) : null;
  const fileInfo = entry.files.length ? el('span', 'row-file', icon('file'), count(entry.files.length, 'file')) : null;
  if (fileInfo) fileInfo.title = entry.files.join('\n');
  const tokens = entry.tokens.total;
  const tokenFill = tokens > 0 ? el('span', 'token-fill') : null;
  if (tokenFill) tokenFill.style.width = `${tokens / peakTokens * 100}%`;
  const tokenBar = peakTokens ? el('span', 'token-bar', tokenFill) : null;
  tokenBar?.setAttribute('aria-hidden', 'true');
  const usage = el('span', 'row-stat',
    el('span', 'row-tokens', tokens ? `${compact.format(tokens)} tokens` : '—'), tokenBar);
  usage.title = tokens ? `${number.format(tokens)} tokens` : 'No token usage recorded';
  const session = el('button', 'session-row',
    el('span', 'row-time', el('span', 'time-range', timeRange(entry)), fileInfo),
    el('span', 'session-info', label, preview),
    usage,
    el('span', 'row-chevron', icon('right')));
  session.type = 'button';
  label.title = entry.title;
  session.addEventListener('click', () => openDetail(entry, session));
  return session;
}

function groupCard(group, peakTokens) {
  const card = el('details', `project-card tone-${group.color}`);
  const key = `${day}/${group.cwd}`;
  card.open = !collapsed.has(key);
  card.addEventListener('toggle', () => {
    if (card.open) collapsed.delete(key);
    else collapsed.add(key);
  });
  const path = el('code', 'project-path', group.cwd || 'Working directory unavailable');
  path.title = group.cwd;
  const total = el('span', 'project-tokens', `${compact.format(group.tokens)} tokens`);
  total.title = `${number.format(group.tokens)} tokens`;
  const heading = el('summary', 'project-heading',
    el('span', 'project-glyph', icon('folder')),
    el('span', 'project-label', el('strong', '', group.name), path),
    el('span', 'project-totals', total, el('span', 'project-session-count', count(group.sessions.length, 'session'))),
    el('span', 'group-chevron', icon('down')));
  card.append(heading, el('div', 'sessions', ...group.sessions.map(entry => sessionRow(entry, peakTokens))));
  return card;
}

function dailySummary(groups) {
  const section = el('details', 'daily-summary');
  section.open = briefOpen;
  section.addEventListener('toggle', () => { briefOpen = section.open; });
  section.append(el('summary', 'summary-heading',
    el('span', 'summary-icon', icon('list')), el('span', '', 'Daily summary'), icon('down')));
  const entries = groups.map(group => el('div', 'summary-group',
    el('strong', '', group.name), el('span', 'muted', ` · ${count(group.sessions.length, 'session')} · ${compact.format(group.tokens)} tokens`),
    el('ul', '', ...group.sessions.map(entry => el('li', '', entry.title)))));
  section.append(el('div', 'summary-body', ...entries));
  return section;
}

function render() {
  const days = byDay();
  renderDates(days);
  main.setAttribute('aria-busy', 'false');
  const dates = [...days.keys()];
  const entries = days.get(day) || [];
  const groups = projectGroups(entries);
  const position = dates.indexOf(day);
  const back = button('icon-button', 'Older activity date', 'left');
  const forward = button('icon-button', 'Newer activity date', 'right');
  back.disabled = position < 0 || position >= dates.length - 1;
  forward.disabled = position < 1;
  back.addEventListener('click', () => chooseDay(dates[position + 1], true));
  forward.addEventListener('click', () => chooseDay(dates[position - 1], true));
  const dateTitle = dayFormat.format(parseDay(day));
  const title = el('h1', '', dateTitle);
  title.tabIndex = -1;
  const zoneLabel = zone.replaceAll('_', ' ');
  const year = parseDay(day).getFullYear();
  const heading = el('section', 'day-heading',
    el('div', '', title, el('p', 'day-subtitle',
      day === snapshot.today ? `Today · ${zoneLabel}` : `${year} · ${zoneLabel}`)),
    el('div', 'heading-controls', projectFilter(), el('div', 'date-switch', back, forward)));
  const nodes = [heading];

  if (entries.length) {
    const totals = entries.reduce((sum, entry) => {
      sum.activeMs += entry.activeMs;
      sum.input += entry.tokens.input;
      sum.output += entry.tokens.output;
      sum.tokens += entry.tokens.total;
      return sum;
    }, { activeMs: 0, input: 0, output: 0, tokens: 0 });
    const uniqueFiles = new Set(entries.flatMap(entry => entry.files.map(file =>
      file.startsWith('/') ? file : `${entry.cwd}/${file}`))).size;
    nodes.push(el('div', 'metrics',
      metric('layers', 'Sessions', number.format(entries.length), `Across ${count(groups.length, 'project')}`),
      metric('tokens', 'Tokens', compact.format(totals.tokens), `${compact.format(totals.input)} in · ${compact.format(totals.output)} out`,
        `${number.format(totals.input)} input · ${number.format(totals.output)} output · ${number.format(totals.tokens)} total`),
      metric('file', 'Changed files', number.format(uniqueFiles), 'From recorded edits',
        'Counts unique file paths reported by successful Codex patch events. Shell edits may be absent.'),
      metric('clock', 'Active time', duration(totals.activeMs), 'Approximate',
        'Adds activity within each session. Gaps over 10 minutes are excluded. Sessions can overlap.')));
    const peakTokens = snapshot.sessions.reduce((peak, entry) =>
      entry.day === day ? Math.max(peak, entry.tokens.total) : peak, 0);
    const scale = peakTokens ? el('span', 'token-scale', 'Token use') : null;
    if (scale) scale.title = 'Bar lengths are relative to the highest token total for this date';
    const cards = groups.map(group => groupCard(group, peakTokens));
    const timeline = el('section', 'timeline',
      el('div', 'timeline-heading', el('h2', '', 'Sessions'), scale),
      ...cards);
    const rail = el('aside', 'activity-rail', projectIndex(groups, cards), dailySummary(groups));
    rail.setAttribute('aria-label', 'Daily overview');
    nodes.push(el('div', 'activity-layout', timeline, rail));
  } else {
    const filtered = Boolean(query || project);
    const empty = el('section', 'empty',
      el('span', 'empty-icon', icon(filtered ? 'search' : 'calendar')),
      el('h2', '', filtered ? 'No matching sessions' : 'No Codex activity yet'),
      el('p', '', filtered ? 'Try a different search or project.' : 'Local sessions will appear here after Codex starts recording activity.'));
    if (filtered) {
      const clear = el('button', 'plain-button', 'Clear filters');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        project = '';
        search.value = '';
        if (query) search.dispatchEvent(new Event('input'));
        else applyFilter();
        search.focus();
      });
      empty.append(clear);
    }
    nodes.push(empty);
  }
  if (snapshot.unreadable) {
    nodes.push(el('p', 'read-note', `${count(snapshot.unreadable, 'log')} could not be read.`));
  }
  main.replaceChildren(...nodes);
}

function shellWord(value) {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function resumePanel(entry) {
  const directory = entry.cwd ? el('span', 'resume-argument', `--cd=${shellWord(entry.cwd)}`) : null;
  const command = el('code', 'resume-command', 'codex resume ', directory, directory ? ' ' : null,
    el('span', 'resume-argument', `-- ${shellWord(entry.id)}`));
  const label = el('span', '', 'Copy');
  const copy = el('button', 'copy-command', icon('copy'), label);
  copy.type = 'button';
  copy.setAttribute('aria-label', 'Copy resume command');
  const status = el('span', 'resume-status');
  status.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command.textContent);
      label.textContent = 'Copied';
      status.classList.remove('copy-help');
      status.textContent = 'Resume command copied.';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(command);
      selection.removeAllRanges();
      selection.addRange(range);
      status.classList.add('copy-help');
      status.textContent = 'Command selected. Press Cmd-C or Ctrl-C to copy.';
    }
  });
  return el('section', 'resume-panel',
    el('div', 'resume-heading', el('h3', '', 'Resume in Terminal'), copy),
    command,
    el('div', 'resume-session', el('span', '', 'Session ID'), el('code', '', entry.id)),
    status);
}

async function openDetail(entry, trigger) {
  const request = ++detailRequest;
  detailTrigger = trigger;
  const heading = el('div', 'detail-intro',
    el('p', 'detail-date', `${formatDay(entry.day)} · ${timeRange(entry)}${entry.archived ? ' · Archived' : ''}`),
    el('h2', '', entry.title), el('p', 'detail-path', icon('folder'), entry.cwd || 'Working directory unavailable'));
  heading.querySelector('h2').id = 'detail-title';
  const stats = el('dl', 'detail-stats',
    el('div', '', el('dt', '', 'Active time'), el('dd', '', duration(entry.activeMs))),
    el('div', '', el('dt', '', 'Tokens'), el('dd', '', number.format(entry.tokens.total))),
    el('div', '', el('dt', '', 'Model'), el('dd', '', entry.model || 'Unavailable')));
  const files = el('section', 'detail-section',
    el('h3', '', 'Changed files', el('span', 'detail-count', number.format(entry.files.length))));
  if (entry.files.length) {
    files.append(el('ul', 'file-list', ...entry.files.map(file =>
      el('li', '', icon('file'), el('code', '', file)))));
  } else {
    files.append(el('p', 'muted', 'No file edits recorded for this day.'));
  }
  const prompts = el('section', 'detail-section', el('h3', '', 'User prompts',
    el('span', 'detail-count', number.format(entry.turns))));
  const promptBody = el('div', '', el('p', 'muted', 'Loading prompts…'));
  prompts.append(promptBody);
  detailContent.replaceChildren(heading, resumePanel(entry), stats, prompts, files);
  detailContent.scrollTop = 0;
  detail.showModal();
  $('#close-detail').focus();
  try {
    const params = new URLSearchParams({ day: entry.day, id: entry.id });
    const response = await fetch(`/api/session?${params}`);
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json();
    if (request !== detailRequest) return;
    promptBody.replaceChildren(data.prompts.length
      ? el('ol', 'prompt-list', ...data.prompts.map(prompt => {
        const time = el('time', '', clock.format(prompt.time));
        time.dateTime = new Date(prompt.time).toISOString();
        return el('li', '', time, el('p', '', prompt.text));
      }))
      : el('p', 'muted', 'No user prompts recorded for this day.'));
  } catch {
    if (request === detailRequest) promptBody.replaceChildren(el('p', 'muted', 'Prompts could not be loaded.'));
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/activity');
    if (!response.ok) throw new Error('Unavailable');
    const text = await response.text();
    if (text === snapshotText) return;
    const previous = snapshot;
    snapshot = JSON.parse(text);
    snapshotText = text;
    zone = snapshot.timeZone || 'UTC';
    clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone });
    for (const entry of snapshot.sessions) {
      if (!projectColor.has(entry.cwd)) {
        projectColor.set(entry.cwd, projectColors[projectColor.size % projectColors.length]);
      }
    }
    if (!day || !previous?.sessions.length && !query && !project) day = snapshot.sessions[0]?.day || snapshot.today;
    if (project && !snapshot.sessions.some(entry => entry.cwd === project)) project = '';
    render();
  } catch {
    if (snapshot) return;
    main.setAttribute('aria-busy', 'false');
    main.replaceChildren(el('section', 'empty',
      el('span', 'empty-icon', icon('activity')),
      el('h1', '', 'History is unavailable'),
      el('p', '', 'Check that the local Worklog server is running and can read your Codex directory.')));
  }
}

await refresh();
setInterval(() => {
  if (!document.hidden && !detail.open && !main.contains(document.activeElement)) refresh();
}, 30_000);
