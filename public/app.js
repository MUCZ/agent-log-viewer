import { recentProjectEntries, indexProjects, indexProjectTree, folderSessions } from './project-tree.js';

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
  terminal: ['M4 5h16v14H4z', 'm7 9 3 3-3 3m6 0h4'],
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

function ghosttyAction(cwd) {
  if (!cwd?.startsWith('/')) return null;
  const label = el('span', '', 'Open in Ghostty');
  const open = el('button', 'ghostty-button', icon('terminal'), label);
  open.type = 'button';
  const status = el('span', 'ghostty-status');
  status.setAttribute('role', 'status');
  open.addEventListener('click', async () => {
    open.disabled = true;
    label.textContent = 'Opening…';
    status.textContent = '';
    try {
      const response = await fetch('/api/open-in-ghostty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      if (!response.ok) {
        const result = await response.json();
        status.textContent = result.error || 'Could not open Ghostty.';
      }
    } catch {
      status.textContent = 'Could not reach the local Ghostty opener.';
    } finally {
      open.disabled = false;
      label.textContent = 'Open in Ghostty';
    }
  });
  return el('div', 'ghostty-action', open, status);
}

const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const number = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
let zone = 'UTC';
let clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone });
const parseDay = day => new Date(day + 'T12:00:00');
const formatDay = day => shortDay.format(parseDay(day));

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
const viewButtons = [...document.querySelectorAll('.view-nav button')];
const searches = { date: '', project: '' };
const sourceFilter = $('#source');
const sourceNames = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi' };
let allSessions = [];
let snapshot;
let snapshotText;
let histories = new Map();
let projectTree;
const expandedFolders = new Map();
let treeFocus;
let includeSubfolders = true;
let view = 'date';
let currentProject;
let day;
let savedDay;
let detailRequest = 0;
let detailTrigger;
const reportDialog = $('#report');
const reportBody = $('#report-body');
let reportRequest = 0;
let reportTimer;
$('#close-report').append(icon('close'));
$('#close-report').addEventListener('click', () => reportDialog.close());
reportDialog.addEventListener('close', () => {
  reportRequest++;
  clearTimeout(reportTimer);
  reportTimer = null;
  main.querySelector('.report-entry')?.focus({ preventScroll: true });
});
const collapsed = new Set();

$('#search-icon').append(icon('search'));
$('#close-detail').append(icon('close'));
$('#close-detail').addEventListener('click', () => detail.close());
for (const control of viewButtons) {
  control.prepend(icon(control.dataset.view === 'date' ? 'calendar' : 'folder'));
  control.addEventListener('click', () => {
    if (!snapshot || view === control.dataset.view) return;
    view = control.dataset.view;
    search.value = searches[view];
    if (view === 'date') applyFilter();
    else render();
    window.scrollTo(0, 0);
  });
}
detail.addEventListener('click', event => {
  if (event.target === detail) detail.close();
});
detail.addEventListener('close', () => {
  detailRequest++;
  detailTrigger?.focus({ preventScroll: true });
  detailTrigger = null;
});

document.addEventListener('keydown', event => {
  if (detail.open || reportDialog.open) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    search.focus();
    search.select();
  }
});
if (!navigator.platform.startsWith('Mac')) $('#search-shortcut').textContent = 'Ctrl K';

function searchQuery(mode) {
  return searches[mode].trim().toLocaleLowerCase();
}

function matchesSearch(entry, query) {
  return !query || [
    entry.title, entry.preview, entry.projectName, entry.cwd, entry.id, sourceNames[entry.source ?? 'codex'],
    ...entry.files, ...(entry.promptTexts ?? []),
  ].some(value => value?.toLocaleLowerCase().includes(query));
}

function applySourceFilter() {
  snapshot.sessions = sourceFilter.value
    ? allSessions.filter(entry => (entry.source ?? 'codex') === sourceFilter.value)
    : allSessions;
  projectTree = null;
  day ||= snapshot.today;
  if (view === 'date') applyFilter();
  else render();
}

sourceFilter.addEventListener('change', () => {
  if (snapshot) applySourceFilter();
});

function byDay() {
  const days = new Map();
  const query = searchQuery('date');
  for (const entry of snapshot.sessions) {
    if (!matchesSearch(entry, query)) continue;
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
  const previous = searchQuery(view);
  searches[view] = search.value;
  if (view === 'date') {
    const next = searchQuery(view);
    if (!previous && next) savedDay = day;
    if (previous && !next && savedDay) day = savedDay;
    applyFilter();
  } else {
    render();
  }
});

function clearSearch() {
  search.value = '';
  search.dispatchEvent(new Event('input'));
}

search.addEventListener('keydown', event => {
  if (event.key === 'Escape' && search.value) clearSearch();
});

const monthFormat = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
const calendarToggle = $('#calendar-toggle');
const calendarControls = $('#calendar-controls');
const calendarBack = button('calendar-step', 'Previous month with activity', 'left');
const calendarNext = button('calendar-step', 'Next month with activity', 'right');
calendarControls.append(calendarBack, calendarNext);
calendarToggle.append(icon('down'));

function expandCalendar(expanded) {
  calendarToggle.setAttribute('aria-expanded', String(expanded));
  $('#calendar-body').hidden = calendarControls.hidden = !expanded;
}
calendarToggle.addEventListener('click', () => expandCalendar($('#calendar-body').hidden));

let calendarMonth;
let calendarSelection;
function renderCalendar(totals) {
  const months = [...new Set([...totals.keys()].map(date => date.slice(0, 7)))].sort();
  if (calendarSelection !== day || !months.includes(calendarMonth)) {
    calendarMonth = day.slice(0, 7);
    calendarSelection = day;
  }
  const first = parseDay(calendarMonth + '-01');
  const monthName = monthFormat.format(first);
  $('#calendar-month').textContent = monthName;
  calendarToggle.setAttribute('aria-label', `Activity calendar for ${monthName}`);

  const previousMonth = months.findLast(month => month < calendarMonth);
  const nextMonth = months.find(month => month > calendarMonth);
  for (const [step, next] of [[calendarBack, previousMonth], [calendarNext, nextMonth]]) {
    step.disabled = !next;
    step.onclick = () => {
      calendarMonth = next;
      renderCalendar(totals);
      if (step.disabled) (step === calendarBack ? calendarNext : calendarBack).focus();
    };
  }

  const grid = $('#calendar-grid');
  grid.replaceChildren();
  for (const label of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
    const heading = el('span', 'calendar-weekday', label);
    heading.setAttribute('aria-hidden', 'true');
    grid.append(heading);
  }
  for (let index = 0; index < (first.getDay() + 6) % 7; index++) grid.append(el('span'));

  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const dates = Array.from({ length: last }, (_, index) => `${calendarMonth}-${String(index + 1).padStart(2, '0')}`);
  const peak = Math.max(1, ...dates.map(date => totals.get(date)?.tokens ?? 0));
  let activeDays = 0;
  let tokens = 0;
  for (const [index, date] of dates.entries()) {
    const data = totals.get(date);
    const cell = el(data ? 'button' : 'span', 'calendar-day', String(index + 1));
    if (data) {
      activeDays++;
      tokens += data.tokens;
      cell.type = 'button';
      cell.dataset.level = Math.max(1, Math.ceil(3 * data.tokens / peak));
      cell.title = data.label;
      cell.setAttribute('aria-label', data.label);
      if (date === day) cell.setAttribute('aria-current', 'date');
      cell.addEventListener('click', () => chooseDay(date, true));
    } else {
      cell.setAttribute('aria-hidden', 'true');
    }
    if (date === snapshot.today) cell.classList.add('is-today');
    grid.append(cell);
  }
  $('#calendar-stats').textContent = `${count(activeDays, 'active day')} · ${compact.format(tokens)} tokens`;
}

function renderDates(days) {
  const dates = $('#dates');
  const totals = new Map();
  dates.replaceChildren();
  for (const [date, entries] of days) {
    const today = date === snapshot.today;
    const dateText = today ? 'Today' : formatDay(date);
    const descriptor = date.slice(0, 4) !== snapshot.today.slice(0, 4) ? date.slice(0, 4)
      : today ? formatDay(date) : weekday.format(parseDay(date));
    const tokens = entries.reduce((sum, entry) => sum + entry.tokens.total, 0);
    const label = `${dayFormat.format(parseDay(date))}, ${date.slice(0, 4)} · ${count(entries.length, 'session')} · ${count(tokens, 'token')}`;
    totals.set(date, { tokens, label });
    const item = el('button', 'date-item history-row',
      el('span', 'date-text', el('span', 'date-name', dateText), el('span', 'date-description', descriptor)),
      el('span', 'history-sessions', number.format(entries.length)),
      el('span', 'history-tokens', compact.format(tokens)));
    item.type = 'button';
    item.title = label;
    item.setAttribute('aria-label', label);
    if (date === day) item.setAttribute('aria-current', 'date');
    item.addEventListener('click', () => chooseDay(date, true));
    dates.append(item);
  }
  if (!days.size) dates.append(el('p', 'sidebar-empty', 'No matching dates'));
  renderCalendar(totals);
}

function metric(glyph, label, value, caption, title) {
  const tile = el('section', 'metric',
    el('div', 'metric-label', icon(glyph), el('span', '', label)),
    el('div', 'metric-value', value), el('div', 'metric-caption', caption));
  if (title) tile.title = title;
  return tile;
}

$('#project-period').addEventListener('change', () => {
  projectTree = null;
  render();
});

function combineSession(entries) {
  const slices = [...entries].sort((a, b) => a.start - b.start);
  const first = slices[0];
  const last = slices.at(-1);
  const summary = {
    ...last,
    start: first.start,
    firstDay: first.day,
    activityDays: slices.map(entry => entry.day),
    activeMs: 0,
    turns: 0,
    requests: 0,
    tokens: { input: 0, output: 0, total: 0 },
    files: [...new Set(slices.flatMap(entry => entry.files))].sort(),
  };
  for (const slice of slices) {
    summary.activeMs += slice.activeMs;
    summary.turns += slice.turns;
    summary.requests += slice.requests ?? 0;
    summary.tokens.input += slice.tokens.input;
    summary.tokens.output += slice.tokens.output;
    summary.tokens.total += slice.tokens.total;
  }
  summary.preview = slices.find(slice => slice.preview)?.preview ?? '';
  summary.model ||= slices.findLast(slice => slice.model)?.model ?? null;
  return summary;
}

function parentPath(cwd) {
  if (!cwd || cwd === '/') return '';
  const parent = cwd.slice(0, cwd.lastIndexOf('/')) || '/';
  const parts = parent.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parent;
}

function renderProjectList() {
  const list = $('#project-list');
  const hadFocus = list.contains(document.activeElement);
  const initial = !list.firstElementChild;
  const scrollTop = list.scrollTop;
  const visible = new Map();
  const lastActiveDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: zone });

  function focusItem(item, focus = true) {
    if (!item) return;
    const previous = visible.get(treeFocus);
    if (previous) previous.tabIndex = -1;
    treeFocus = item.dataset.cwd;
    item.tabIndex = 0;
    if (focus) item.focus({ preventScroll: true });
    if (!focus && !initial) return;
    const bounds = list.getBoundingClientRect();
    const row = item.firstElementChild.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
  }

  function branch(nodes, topLevel = false) {
    const group = el('ul', topLevel ? 'project-tree' : 'folder-children');
    group.setAttribute('role', topLevel ? 'tree' : 'group');
    if (topLevel) group.setAttribute('aria-label', 'Project folders');
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const expanded = expandedFolders.get(node.cwd) ?? topLevel;
      const toggle = el('span', 'folder-toggle', hasChildren ? icon(expanded ? 'down' : 'right') : null);
      if (hasChildren) toggle.title = expanded ? 'Collapse folder' : 'Expand folder';
      const name = el('span', 'folder-name', node.label);
      const stats = el('span', 'folder-stats', count(node.requests, 'request'), ' · ', compact.format(node.tokens) + ' tokens');
      const glyph = el('span', `folder-icon tone-${projectColor.get(node.cwd) ?? 'slate'}`, icon('folder'));
      const row = el('div', 'folder-row', toggle, glyph, el('span', 'folder-label', name, stats));
      const item = el('li', 'folder-item', row);
      item.dataset.cwd = node.cwd;
      item.title = `${node.cwd || node.name} · ${count(node.sessionCount, 'session')} · ${number.format(node.tokens)} tokens · Last active ${lastActiveDate.format(node.lastActive)}`;
      item.setAttribute('role', 'treeitem');
      item.setAttribute('aria-label', node.label + ', ' + stats.textContent);
      item.setAttribute('aria-selected', String(currentProject === node.cwd));
      item.tabIndex = -1;
      visible.set(node.cwd, item);
      if (hasChildren) item.setAttribute('aria-expanded', String(expanded));
      if (hasChildren && expanded) item.append(branch(node.children));
      function toggleBranch() {
        treeFocus = node.cwd;
        expandedFolders.set(node.cwd, !expanded);
        renderProjectList();
        list.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
      }
      function select() {
        focusItem(item);
        if (currentProject === node.cwd) return;
        currentProject = node.cwd;
        includeSubfolders = true;
        render();
        window.scrollTo(0, 0);
      }
      row.addEventListener('click', event => {
        if (hasChildren && toggle.contains(event.target)) toggleBranch();
        else select();
      });
      item.addEventListener('keydown', event => {
        if (event.target !== item) return;
        const items = [...visible.values()];
        const index = items.indexOf(item);
        switch (event.key) {
          case 'ArrowUp': focusItem(items[index - 1]); break;
          case 'ArrowDown': focusItem(items[index + 1]); break;
          case 'Home': focusItem(items[0]); break;
          case 'End': focusItem(items.at(-1)); break;
          case 'ArrowRight':
            if (hasChildren && !expanded) toggleBranch();
            else if (hasChildren) focusItem(visible.get(node.children[0].cwd));
            break;
          case 'ArrowLeft':
            if (hasChildren && expanded) toggleBranch();
            else if (node.parent) focusItem(visible.get(node.parent.cwd));
            break;
          case 'Enter':
          case ' ': select(); break;
          default: return;
        }
        event.preventDefault();
      });
      group.append(item);
    }
    return group;
  }
  list.replaceChildren(branch(projectTree.roots, true));
  list.scrollTop = scrollTop;
  focusItem(visible.get(treeFocus) ?? visible.get(currentProject) ?? visible.values().next().value, hadFocus);
  $('#project-count').textContent = number.format(histories.size);
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

function distributionCard(title, unit, segments, list, badge) {
  segments.setAttribute('aria-hidden', 'true');
  return el('section', 'project-index',
    el('div', 'project-index-header',
      el('div', 'project-index-heading', el('h2', '', title), badge),
      el('p', 'project-index-caption', `Share of ${unit}`), segments), list);
}

function harnessLabel(source) {
  return source === 'claude' ? 'Claude' : sourceNames[source];
}

function harnessDistribution(entries) {
  const usage = new Map();
  let total = 0;
  for (const entry of entries) {
    const source = entry.source ?? 'codex';
    usage.set(source, (usage.get(source) ?? 0) + entry.tokens.total);
    total += entry.tokens.total;
  }
  const segments = el('div', 'segments harness-segments');
  const list = el('ul', 'harness-list');
  for (const [source, tokens] of [...usage].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const name = harnessLabel(source);
    const share = total ? percent.format(tokens / total) : '—';
    if (tokens) {
      const segment = el('span', `segment harness-${source}`);
      segment.style.flexGrow = tokens;
      segments.append(segment);
    }
    const amount = el('span', 'harness-amount', `${compact.format(tokens)} tokens`);
    amount.title = `${number.format(tokens)} tokens`;
    list.append(el('li', `harness-entry harness-${source}`, el('strong', '', name),
      amount, el('span', 'project-share', share)));
  }
  return distributionCard('Harnesses', 'tokens', segments, list);
}

function projectIndex(groups, cards) {
  const hasTokens = groups.some(group => group.tokens > 0);
  const unit = hasTokens ? 'tokens' : 'sessions';
  const weight = group => hasTokens ? group.tokens : group.sessions.length;
  const total = groups.reduce((sum, group) => sum + weight(group), 0);
  const segments = el('div', 'segments');
  const index = el('ul', 'project-index-list');
  for (const [position, group] of groups.entries()) {
    const percent = Math.round(weight(group) / total * 100);
    if (weight(group)) {
      const segment = el('div', `segment tone-${group.color}`);
      segment.style.flexGrow = weight(group);
      segment.title = `${group.name} · ${percent}%`;
      segments.append(segment);
    }
    const location = parentPath(group.cwd);
    const jump = el('button', `project-jump tone-${group.color}`,
      el('span', 'project-jump-mark'),
      el('span', 'project-jump-label', el('strong', '', group.name),
        location ? el('span', 'project-jump-path', location) : null),
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
  return distributionCard('Projects', unit, segments, index, el('span', 'section-count', number.format(groups.length)));
}

function sessionRow(entry, peakTokens) {
  const label = el('span', 'session-title', entry.title);
  const trimmedTitle = entry.title.replace(/…$/, '').toLocaleLowerCase();
  const preview = entry.preview && (entry.source === 'pi' || !entry.preview.toLocaleLowerCase().startsWith(trimmedTitle))
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
  const time = el('span', 'row-time', entry.activityDays ? clock.format(entry.end) : timeRange(entry));
  if (entry.activityDays) time.title = 'Last recorded activity';
  const source = entry.source ?? 'codex';
  const session = el('button', 'session-row',
    time, el('span', `row-source harness-${source}`, harnessLabel(source)),
    el('span', 'session-info', label, preview),
    fileInfo, usage,
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

function dailyReportButton() {
  const control = el('button', 'report-entry', icon('list'), 'Daily report', icon('right'));
  control.type = 'button';
  control.addEventListener('click', () => {
    reportBody.replaceChildren();
    reportDialog.showModal();
    $('#close-report').focus();
    loadReport(day);
  });
  return control;
}

async function loadReport(date, generate = false) {
  const request = ++reportRequest;
  clearTimeout(reportTimer);
  const heading = el('h2', '', dayFormat.format(parseDay(date)));
  heading.id = 'report-title';
  const scope = el('p', 'report-scope', zone + ' · All projects and agents');
  if (!reportBody.querySelector('h2')) reportBody.replaceChildren(heading, scope);
  try {
    const response = await fetch('/api/daily-report?day=' + encodeURIComponent(date), { method: generate ? 'POST' : 'GET' });
    if (!response.ok) throw new Error('Could not load this report.');
    const { report, total, stale, progress, error } = await response.json();
    if (request !== reportRequest || !reportDialog.open) return;
    const content = [heading, scope];
    const actions = el('div', 'report-actions');
    let coverage;
    if (report) {
      const partial = report.analyzed / report.total < 0.9;
      coverage = (partial ? 'Partial report · ' : '') + report.analyzed + ' of ' + report.total + ' sessions analyzed';
      content.push(el('p', 'report-meta', coverage));
      for (const project of report.projects) {
        content.push(el('section', 'report-project', el('h3', '', project.name),
          el('ul', '', ...project.bullets.map(line => el('li', '', line)))));
      }
      if (!report.projects.length) content.push(el('p', '', 'No substantive tasks recorded.'));
      const copy = el('button', 'plain-button', 'Copy Markdown');
      copy.addEventListener('click', async () => {
        const groups = report.projects.map(p => '## ' + p.name + '\n' + p.bullets.map(b => '- ' + b).join('\n'));
        try {
          await navigator.clipboard.writeText(['# ' + date, coverage, ...groups].join('\n\n'));
          copy.textContent = 'Copied';
        } catch { copy.textContent = 'Copy unavailable'; }
      });
      actions.append(copy);
      const { input, output, cost } = report.usage;
      content.push(el('p', 'report-meta', 'Last generation · ' + number.format(input) + ' in · ' + number.format(output)
        + ' out · $' + cost.toFixed(4)));
    } else if (total) {
      content.push(el('p', 'report-intro', 'Generate a project-by-project summary from selected conversation excerpts and recorded edits using Gemini 4 Hydrogen on OpenRouter.'));
    } else content.push(el('p', 'report-intro', 'No sessions recorded for this date.'));
    if (error) content.push(el('p', 'report-error', error));
    if (progress) {
      const status = el('p', 'report-meta', progress.phase + ' · ' + progress.analyzed + ' / ' + progress.total);
      status.setAttribute('role', 'status');
      content.push(status);
      reportTimer = setTimeout(() => loadReport(date), 1500);
    } else if (total && (stale || !report)) {
      const run = el('button', 'plain-button', report ? 'Update report' : 'Generate report');
      run.addEventListener('click', () => {
        run.disabled = true;
        loadReport(date, true);
      });
      actions.append(run);
    }
    reportBody.replaceChildren(...content, actions);
  } catch {
    if (request !== reportRequest) return;
    const retry = el('button', 'plain-button', 'Retry');
    retry.addEventListener('click', () => loadReport(date));
    reportBody.append(el('p', 'report-error', 'Could not load this report.'), retry);
  }
}

function sessionMetrics(entries, caption, includeActiveTime = false) {
  const totals = entries.reduce((sum, entry) => {
    sum.activeMs += entry.activeMs;
    sum.input += entry.tokens.input;
    sum.output += entry.tokens.output;
    sum.tokens += entry.tokens.total;
    return sum;
  }, { activeMs: 0, input: 0, output: 0, tokens: 0 });
  const uniqueFiles = new Set(entries.flatMap(entry => entry.files.map(file =>
    file.startsWith('/') ? file : `${entry.cwd}/${file}`))).size;
  const tiles = [
    metric('layers', 'Sessions', number.format(entries.length), caption),
    metric('tokens', 'Tokens', compact.format(totals.tokens), `${compact.format(totals.input)} in · ${compact.format(totals.output)} out`,
      `${number.format(totals.input)} input · ${number.format(totals.output)} output · ${number.format(totals.tokens)} total`),
    metric('file', 'Changed files', number.format(uniqueFiles), 'From recorded edits',
      'Counts unique paths reported by successful file-edit tools. Shell edits may be absent.'),
  ];
  if (includeActiveTime) {
    tiles.push(metric('clock', 'Active time', duration(totals.activeMs), 'Approximate',
      'Adds activity within each session. Gaps over 10 minutes are excluded. Sessions can overlap.'));
  } else {
    const requests = entries.reduce((sum, entry) => sum + entry.requests, 0);
    tiles.splice(1, 0, metric('activity', 'Requests', number.format(requests), 'Recorded model calls',
      'Counts model requests with usage recorded in the selected period.'));
  }
  return el('div', 'metrics', ...tiles);
}

function emptyView(glyph, heading, message, clearLabel, onClear) {
  const empty = el('section', 'empty',
    el('span', 'empty-icon', icon(glyph)), el('h2', '', heading), el('p', '', message));
  if (onClear) {
    const clear = el('button', 'plain-button', clearLabel);
    clear.type = 'button';
    clear.addEventListener('click', onClear);
    empty.append(clear);
  }
  return empty;
}

function dateView() {
  const days = byDay();
  renderDates(days);
  const entries = days.get(day) || [];
  const groups = projectGroups(entries);
  const dateTitle = dayFormat.format(parseDay(day));
  const title = el('h1', '', dateTitle);
  title.tabIndex = -1;
  const zoneLabel = zone.replaceAll('_', ' ');
  const year = parseDay(day).getFullYear();
  const heading = el('section', 'day-heading',
    title, el('p', 'day-subtitle',
      day === snapshot.today ? `Today · ${zoneLabel}` : `${year} · ${zoneLabel}`));
  const nodes = [heading];

  if (entries.length) {
    nodes.push(sessionMetrics(entries, `Across ${count(groups.length, 'project')}`, true));
    const peakTokens = snapshot.sessions.reduce((peak, entry) =>
      entry.day === day ? Math.max(peak, entry.tokens.total) : peak, 0);
    const cards = groups.map(group => groupCard(group, peakTokens));
    const timeline = el('section', 'timeline',
      el('h2', 'timeline-heading', 'Sessions'),
      ...cards);
    const rail = el('aside', 'activity-rail', harnessDistribution(entries), projectIndex(groups, cards), dailyReportButton());
    rail.setAttribute('aria-label', 'Daily overview');
    nodes.push(el('div', 'activity-layout', timeline, rail));
  } else {
    nodes.push(dailyReportButton());
    nodes.push(searchQuery('date')
      ? emptyView('search', 'No matching sessions', 'Try a different search.', 'Clear search', () => {
        clearSearch();
        search.focus();
      })
      : emptyView('calendar', 'No activity yet', 'Sessions appear here when the selected agents record local activity.'));
  }
  return nodes;
}

function projectView() {
  const days = Number($('#project-period input:checked').value);
  if (!projectTree) {
    histories = indexProjects(recentProjectEntries(snapshot.sessions, snapshot.today, days));
    projectTree = indexProjectTree(histories);
  }
  if (!projectTree.byPath.has(currentProject)) {
    currentProject = histories.keys().next().value;
    includeSubfolders = true;
    treeFocus = currentProject;
    for (let parent = projectTree.byPath.get(currentProject)?.parent; parent; parent = parent.parent) {
      expandedFolders.set(parent.cwd, true);
    }
  }
  renderProjectList();
  const folder = projectTree.byPath.get(currentProject);
  if (!folder) return [emptyView('folder', days === 1 ? 'No project activity today' : `No project activity in the last ${days} days`,
    'Choose another activity window or agent to explore more sessions.')];

  const title = el('h1', '', folder.name);
  title.tabIndex = -1;
  const tone = `tone-${projectColor.get(folder.cwd) ?? 'slate'}`;
  const heading = el('section', `project-page-heading ${tone}`,
    el('span', 'project-glyph', icon('folder')),
    el('div', 'project-page-title', title, el('code', 'project-path', folder.cwd || 'Working directory unavailable')),
    folder.history ? ghosttyAction(folder.cwd) : null);

  const nodes = [heading];
  const withChildren = folder.children.length > 0 && (!folder.history || includeSubfolders);
  if (folder.children.length) {
    const scope = el('div', 'folder-scope');
    if (folder.history) {
      const toggle = el('input', '');
      toggle.type = 'checkbox';
      toggle.checked = includeSubfolders;
      toggle.addEventListener('change', () => {
        includeSubfolders = toggle.checked;
        render();
        main.querySelector('.folder-scope input').focus({ preventScroll: true });
      });
      scope.append(el('label', '', toggle, 'Include subfolders'));
    }
    const directories = withChildren ? folder.histories.length : 1;
    scope.append(el('span', '', number.format(directories) + (directories === 1 ? ' working directory' : ' working directories')));
    nodes.push(scope);
  }
  const query = searchQuery('project');
  const recent = [];
  const sessions = folderSessions(folder, withChildren);
  let peakTokens = 0;
  for (const slices of sessions.values()) {
    const entry = combineSession(slices);
    peakTokens = Math.max(peakTokens, entry.tokens.total);
    if (slices.some(slice => matchesSearch(slice, query))) recent.push(entry);
  }
  recent.sort((a, b) => b.end - a.end);

  if (!recent.length) {
    return [...nodes,
      emptyView('search', 'No matching sessions', 'Try a different search in this folder.', 'Clear search', () => {
        clearSearch();
        search.focus();
      })];
  }

  const dates = new Map();
  for (const entry of recent) {
    if (!dates.has(entry.day)) dates.set(entry.day, []);
    dates.get(entry.day).push(entry);
  }
  const activeDays = new Set(recent.flatMap(entry => entry.activityDays)).size;
  const metrics = sessionMetrics(recent, query ? `Of ${count(sessions.size, 'session')}` : `Across ${count(activeDays, 'day')}`);
  const timeline = el('section', `timeline project-timeline ${tone}`,
    el('h2', 'timeline-heading', 'Recent sessions'));
  for (const [date, entries] of dates) {
    const label = date === snapshot.today ? `Today · ${formatDay(date)}` : dayFormat.format(parseDay(date));
    const year = date.slice(0, 4) !== snapshot.today.slice(0, 4) ? `, ${date.slice(0, 4)}` : '';
    timeline.append(el('section', 'project-day',
      el('div', 'project-day-heading',
        el('h3', '', label + year), el('span', 'muted', count(entries.length, 'session'))),
      ...entries.map(entry => {
        const row = sessionRow(entry, peakTokens);
        if (withChildren) {
          const location = entry.cwd === folder.cwd ? '.' : entry.cwd.slice(folder.cwd === '/' ? 1 : folder.cwd.length + 1);
          const path = el('span', 'session-folder', icon('folder'), location);
          path.title = entry.cwd;
          row.querySelector('.session-info').append(path);
        }
        return row;
      })));
  }
  const rail = el('aside', 'activity-rail', harnessDistribution(recent));
  rail.setAttribute('aria-label', 'Project overview');
  return [...nodes, metrics, el('div', 'activity-layout', timeline, rail)];
}

function render() {
  const byProject = view === 'project';
  for (const control of viewButtons) {
    control.setAttribute('aria-pressed', String(control.dataset.view === view));
  }
  $('#history').hidden = byProject;
  $('#project-history').hidden = !byProject;
  const viewLabel = byProject ? 'Project history' : 'Daily activity';
  $('#view-label').textContent = viewLabel;
  document.title = `Worklog · ${viewLabel}`;
  $('#bar-icon').replaceChildren(icon(byProject ? 'folder' : 'activity'));
  search.placeholder = byProject ? 'Search this folder…' : 'Search sessions and prompts…';
  search.setAttribute('aria-label', byProject ? 'Search sessions and prompts in this folder' : 'Search sessions and prompts');
  const nodes = byProject ? projectView() : dateView();
  if (snapshot.unreadable) {
    nodes.push(el('p', 'read-note', `${count(snapshot.unreadable, 'log')} could not be read.`));
  }
  main.setAttribute('aria-busy', 'false');
  main.replaceChildren(...nodes);
}

function shellWord(value) {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function resumePanel(entry) {
  const cwd = entry.cwd && shellWord(entry.cwd);
  const id = shellWord(entry.id);
  let resume;
  if (entry.source === 'claude' || entry.source === 'pi') {
    const invocation = entry.source === 'claude' ? `claude --resume ${id}` : `pi --session ${shellWord(entry.sessionFile || entry.id)}`;
    resume = cwd ? `cd -- ${cwd} && ${invocation}` : invocation;
  } else {
    resume = `codex resume ${cwd ? `--cd=${cwd} ` : ''}-- ${id}`;
  }
  const command = el('code', 'resume-command', resume);
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

function promptDisclosure(label, text, open = false) {
  const card = el('details', 'prompt-card',
    el('summary', 'prompt-summary', label, icon('down')),
    el('p', 'prompt-text', text));
  card.open = open;
  return card;
}

async function openDetail(entry, trigger) {
  const request = ++detailRequest;
  detailTrigger = trigger;
  const activityDays = entry.activityDays ?? [entry.day];
  const spansDays = activityDays.length > 1;
  const dateRange = spansDays
    ? `${formatDay(entry.firstDay)} ${clock.format(entry.start)} – ${formatDay(entry.day)} ${clock.format(entry.end)}`
    : `${formatDay(entry.day)} · ${timeRange(entry)}`;
  const heading = el('div', 'detail-intro',
    el('p', 'detail-date', `${sourceNames[entry.source ?? 'codex']} · ${dateRange}${entry.archived ? ' · Archived' : ''}`),
    el('h2', '', entry.title),
    el('div', 'detail-location',
      el('p', 'detail-path', icon('folder'), entry.cwd || 'Working directory unavailable'),
      ghosttyAction(entry.cwd)));
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
    files.append(el('p', 'muted', spansDays ? 'No file edits recorded.' : 'No file edits recorded for this day.'));
  }
  const prompts = el('section', 'detail-section', el('h3', '', 'User prompts',
    el('span', 'detail-count', number.format(entry.turns))));
  const instructions = el('div', 'prompt-context');
  const promptBody = el('div', '', el('p', 'muted', 'Loading prompts…'));
  prompts.append(promptBody);
  detailContent.replaceChildren(heading, resumePanel(entry), stats, instructions, prompts, files);
  detailContent.scrollTop = 0;
  detail.showModal();
  $('#close-detail').focus();
  try {
    const sessionDays = await Promise.all(activityDays.map(async date => {
      const params = new URLSearchParams({ source: entry.source ?? 'codex', day: date, id: entry.id });
      const response = await fetch(`/api/session?${params}`);
      if (!response.ok) throw new Error('Unavailable');
      return response.json();
    }));
    if (request !== detailRequest) return;
    const context = sessionDays.find(session => session.instructions)?.instructions;
    if (context?.system) instructions.append(promptDisclosure('System prompt', context.system));
    if (context?.agents) instructions.append(promptDisclosure('AGENTS.md', context.agents));
    const prompts = sessionDays.flatMap(({ summary, prompts }) => prompts.map(prompt => ({ ...prompt, day: summary.day })))
      .sort((a, b) => a.time - b.time);
    promptBody.replaceChildren(prompts.length
      ? el('ol', 'prompt-list', ...prompts.map(prompt => {
        const displayTime = clock.format(prompt.time);
        const time = el('time', '', spansDays ? `${formatDay(prompt.day)} · ${displayTime}` : displayTime);
        time.dateTime = new Date(prompt.time).toISOString();
        const preview = el('span', 'prompt-preview', prompt.text.slice(0, 180).replace(/\s+/g, ' '));
        return el('li', '', promptDisclosure(el('span', 'prompt-label', time, preview), prompt.text, true));
      }))
      : el('p', 'muted', spansDays ? 'No user prompts recorded.' : 'No user prompts recorded for this day.'));
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
    snapshot = JSON.parse(text);
    snapshotText = text;
    allSessions = snapshot.sessions;
    zone = snapshot.timeZone || 'UTC';
    clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone });
    for (const entry of snapshot.sessions) {
      if (!projectColor.has(entry.cwd)) {
        projectColor.set(entry.cwd, projectColors[projectColor.size % projectColors.length]);
      }
    }
    applySourceFilter();
  } catch {
    if (snapshot) return;
    main.setAttribute('aria-busy', 'false');
    main.replaceChildren(el('section', 'empty',
      el('span', 'empty-icon', icon('activity')),
      el('h1', '', 'History is unavailable'),
      el('p', '', 'Check that the local Worklog server is running and can read your session directories.')));
  }
}

await refresh();
setInterval(() => {
  const focused = document.activeElement;
  if (!document.hidden && !detail.open && !reportDialog.open && (!main.contains(focused) || focused.matches('h1'))) refresh();
}, 30_000);
