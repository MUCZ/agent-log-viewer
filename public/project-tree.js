export function* recentProjectEntries(entries, today, days) {
  const first = new Date(today + 'T00:00:00Z');
  first.setUTCDate(first.getUTCDate() - days + 1);
  const firstDay = first.toISOString().slice(0, 10);
  // The activity feed lists daily slices newest first.
  for (const entry of entries) {
    if (entry.day < firstDay) break;
    if (entry.day <= today) yield entry;
  }
}

export function indexProjects(entries) {
  const histories = new Map();
  for (const entry of entries) {
    if (!histories.has(entry.cwd)) {
      histories.set(entry.cwd, { cwd: entry.cwd, name: entry.projectName, lastActive: entry.end, tokens: 0, requests: 0, sessions: new Map() });
    }
    const history = histories.get(entry.cwd);
    history.lastActive = Math.max(history.lastActive, entry.end);
    history.tokens += entry.tokens.total;
    history.requests += entry.requests ?? 0;
    const key = JSON.stringify([entry.source ?? 'codex', entry.id]);
    if (!history.sessions.has(key)) history.sessions.set(key, []);
    history.sessions.get(key).push(entry);
  }
  return new Map([...histories].sort(([, a], [, b]) =>
    b.sessions.size - a.sessions.size || b.lastActive - a.lastActive || a.cwd.localeCompare(b.cwd)));
}

export function indexProjectTree(histories) {
  const directories = new Map();
  const roots = [];

  function directory(cwd) {
    if (directories.has(cwd)) return directories.get(cwd);
    const history = histories.get(cwd);
    const name = history?.name || cwd.slice(cwd.lastIndexOf('/') + 1) || cwd;
    const node = { cwd, name, label: name, history, children: [] };
    directories.set(cwd, node);
    if (cwd.startsWith('/') && cwd !== '/') {
      directory(cwd.slice(0, cwd.lastIndexOf('/')) || '/').children.push(node);
    } else {
      roots.push(node);
    }
    return node;
  }

  for (const cwd of histories.keys()) directory(cwd);

  const byPath = new Map();
  function compact(node, parent) {
    let label = node.name;
    while (!node.history && node.children.length === 1) {
      node = node.children[0];
      label = label === '/' ? '/' + node.name : label + '/' + node.name;
    }
    node.label = label;
    node.parent = parent;
    byPath.set(node.cwd, node);
    node.children = node.children.map(child => compact(child, node)).sort(compare);
    node.histories = node.children.flatMap(child => child.histories);
    if (node.history) node.histories.unshift(node.history);
    const identities = new Set();
    node.tokens = 0;
    node.requests = 0;
    node.lastActive = 0;
    for (const history of node.histories) {
      for (const key of history.sessions.keys()) identities.add(key);
      node.tokens += history.tokens;
      node.requests += history.requests;
      node.lastActive = Math.max(node.lastActive, history.lastActive);
    }
    node.sessionCount = identities.size;
    return node;
  }
  function compare(a, b) {
    return b.sessionCount - a.sessionCount || b.lastActive - a.lastActive || a.label.localeCompare(b.label);
  }
  return { roots: roots.map(node => compact(node, null)).sort(compare), byPath };
}

export function folderSessions(folder, includeChildren) {
  if (!includeChildren || !folder.children.length) return folder.history?.sessions ?? new Map();
  const sessions = new Map();
  for (const history of folder.histories) {
    for (const [key, slices] of history.sessions) {
      if (sessions.has(key)) sessions.get(key).push(...slices);
      else sessions.set(key, [...slices]);
    }
  }
  return sessions;
}
