import test from 'node:test';
import assert from 'node:assert/strict';
import { folderSessions, indexProjects, indexProjectTree } from '../public/project-tree.js';

function entry(cwd, id, total, source = 'codex', end = 1) {
  return { cwd, id, source, end, projectName: cwd.split('/').at(-1) || cwd || 'No working directory', tokens: { total } };
}

test('tree compacts unrecorded parents and preserves recorded folders and their exact scope', () => {
  const entries = [
    entry('/Users/dev/workspace', 'parent', 12),
    entry('/Users/dev/workspace/ponsu', 'one', 20),
    entry('/Users/dev/workspace/ponsu', 'one', 10, 'codex', 2),
    entry('/Users/dev/workspace/ponsu', 'one', 3, 'pi'),
    entry('/Users/dev/review/ponsu', 'other', 8),
    entry('/Users/dev/workspace-old', 'neighbor', 5),
  ];
  const tree = indexProjectTree(indexProjects(entries));
  const root = tree.roots[0];
  assert.equal(root.cwd, '/Users/dev');
  assert.equal(root.label, '/Users/dev');
  assert.equal(folderSessions(root, false).size, 0);
  assert.equal(root.sessionCount, 5);
  assert.equal(root.tokens, 58);
  const workspace = tree.byPath.get('/Users/dev/workspace');
  assert.equal(workspace.children[0].label, 'ponsu');
  assert.equal(workspace.children[0].parent, workspace);
  assert.equal(tree.byPath.get('/Users/dev/review/ponsu').label, 'review/ponsu');
  assert.equal(workspace.sessionCount, 3);
  assert.equal(workspace.tokens, 45);
  assert.equal(workspace.lastActive, 2);
  assert.deepEqual([...folderSessions(workspace, false).values()].flat(), [entries[0]]);
  const scoped = [...folderSessions(workspace, true).values()];
  assert.deepEqual(scoped.map(slices => slices.length), [1, 2, 1]);
});

test('folder rollups count sessions across directories once and keep source IDs independent', () => {
  const entries = [
    entry('/work/api', 'id', 7), entry('/work/tools', 'id', 2), entry('/work', 'id', 5, 'claude'),
  ];
  const tree = indexProjectTree(indexProjects(entries));
  const root = tree.roots[0];
  assert.equal(root.sessionCount, 2);
  assert.equal(root.tokens, 14);
  assert.equal(folderSessions(root, true).get('["codex","id"]').length, 2);
  assert.equal(folderSessions(tree.byPath.get('/work/api'), false).get('["codex","id"]').length, 1);
});

test('missing working directory and filesystem root remain selectable and empty history is valid', () => {
  const tree = indexProjectTree(indexProjects([entry('', 'unknown', 0), entry('/', 'root', 1), entry('/tmp', 'temp', 4)]));
  assert.equal(tree.roots.length, 2);
  assert.equal(tree.byPath.get('').name, 'No working directory');
  assert.equal(tree.byPath.get('/').children[0].cwd, '/tmp');
  assert.equal(tree.byPath.get('/').sessionCount, 2);
  assert.deepEqual(indexProjectTree(indexProjects([])).roots, []);
});
