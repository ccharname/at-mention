const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = process.argv[2] || path.join(__dirname, 'main.js');
const notices = [];
class Stub { constructor(app) { this.app = app; this.scope = { register() {} }; } close() {} setPlaceholder() {} }
class PluginStub extends Stub {
  async loadData() { return this.stored; }
  registerEvent() {} addSettingTab() {} registerEditorSuggest() {} addCommand() {}
}
class Notice { constructor(text) { notices.push(text); } }
const sandbox = { require: () => ({ AbstractInputSuggest: Stub, EditorSuggest: Stub, SuggestModal: Stub, Notice, Plugin: PluginStub, PluginSettingTab: Stub, Setting: Stub }), module: { exports: {} }, window: { setTimeout: fn => fn() }, structuredClone, console };
vm.runInNewContext(fs.readFileSync(source, 'utf8') + '\nmodule.exports.Suggestor = AtMentionSuggestor; module.exports.Modal = EntitySuggestModal;', sandbox);
const Plugin = sandbox.module.exports;
function setup({ files = ['People/@Alice.md'], autoCreateFiles = true, graphSize = 0 } = {}) {
  const mt = { trigger: '@', folders: ['People/'], defaultFolder: 'People/', requirePrefix: true, autoCreateFiles, useAliases: false };
  const state = { files: files.map(p => ({ path: p, stat: { mtime: Date.now() } })), creates: [], events: {}, graphReads: 0, scans: 0 };
  const graph = {};
  for (let i = 0; i < graphSize; i++) graph['note' + i + '.md'] = { 'People/@Alice.md': 1 };
  const app = {
    vault: {
      getMarkdownFiles: () => { state.scans++; return state.files; },
      getAbstractFileByPath: p => state.files.find(f => f.path === p),
      createFolder: async p => { state.creates.push(['folder', p]); },
      create: async (p, content) => { state.creates.push(['file', p, content]); state.files.push({ path: p, stat: { mtime: Date.now() } }); },
      on: (event, callback) => { state.events[event] = callback; return {}; },
    },
    metadataCache: { on() { return {}; }, getFileCache() { return {}; }, get resolvedLinks() { state.graphReads++; return graph; } },
    workspace: { onLayoutReady(fn) { fn(); } },
  };
  const plugin = new Plugin(app);
  plugin.settings = { mentionTypes: [mt], useExplicitLinks: false };
  plugin.suggestor = new Plugin.Suggestor(app, plugin);
  plugin.suggestor.activeTrigger = '@';
  plugin.initialize();
  return { plugin, suggestor: plugin.suggestor, state, mt, app };
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
test('folder rename refreshes descendant paths', async () => {
  const { plugin, state } = setup({ files: ['People/Team/@Alice.md'] });
  state.files = [{ path: 'People/Group/@Alice.md', stat: { mtime: Date.now() } }];
  await plugin.update({ path: 'People/Group', children: [] }, 'People/Team');
  assert.equal(plugin.entityMaps['@'].fileMap.Alice, 'People/Group/@Alice.md');
});
test('unrelated folders do not rescan entity files', async () => {
  const { plugin, state } = setup();
  const before = state.scans;
  await plugin.update({ path: 'Journal/New', children: [] });
  assert.equal(state.scans, before);
});
test('folder deletion removes descendants', async () => {
  const { plugin, state } = setup({ files: ['People/Team/@Alice.md'] });
  state.files = [];
  await plugin.update({ path: 'People/Team', children: [], deleted: true });
  assert.deepEqual(Object.keys(plugin.entityMaps['@'].fileMap), []);
});
test('explicit delete event removes file even without deleted property', async () => {
  const { plugin, state, mt } = setup();
  plugin.stored = { mentionTypes: [mt] };
  await plugin.onload();
  state.files = [];
  await state.events.delete({ path: 'People/@Alice.md' });
  assert.deepEqual(Object.keys(plugin.entityMaps['@'].fileMap), []);
});
test('ordinary file rename keeps new and drops old entity', async () => {
  const { plugin } = setup();
  await plugin.update({ path: 'People/@Bob.md' }, 'People/@Alice.md');
  assert.equal(plugin.entityMaps['@'].fileMap.Bob, 'People/@Bob.md');
  assert.equal(plugin.entityMaps['@'].fileMap.Alice, undefined);
});
test('bare trigger browses existing without empty create', async () => {
  const { suggestor } = setup();
  const values = suggestor.getSuggestions({ query: '' });
  assert.ok(values.some(v => v.displayText === 'Alice'));
  assert.ok(!values.some(v => v.suggestionType === 'create'));
});
test('illegal create name is not offered', async () => {
  const { suggestor } = setup();
  for (const query of ['Alice#Team', 'Alice|Team', 'Alice/Team', 'Alice[Team]', 'Alice^Team', 'Alice?Team', '   ', '\nAlice']) {
    assert.ok(!suggestor.getSuggestions({ query }).some(v => v.suggestionType === 'create'), query);
  }
});
test('direct empty or illegal creation does not write or return broken link', async () => {
  const { plugin, state } = setup();
  for (const name of ['', ' ', 'Alice#Team', 'Alice|Team', 'Alice/Team', 'Alice[Team]', 'Alice^Team', 'Alice?Team', '\nAlice']) {
    assert.equal(await plugin.createEntityLink(name, '@'), null, JSON.stringify(name));
  }
  assert.deepEqual(state.creates, []);
});
test('valid multicharacter names still create and link', async () => {
  const { plugin, state } = setup();
  assert.equal(await plugin.createEntityLink('张 三', '@'), '[[@张 三]]');
  assert.ok(state.creates.some(v => v[0] === 'file' && v[1] === 'People/@张 三.md'));
});
test('failed creation does not insert a broken link', async () => {
  const { plugin, app } = setup();
  app.vault.create = async () => { throw Error('disk full'); };
  assert.equal(await plugin.createEntityLink('Bob', '@'), null);
});
test('invalid inline completion does not replace editor text', async () => {
  const { suggestor } = setup();
  const edits = [];
  await suggestor.selectSuggestion({ displayText: '', context: { editor: { replaceRange: (...args) => edits.push(args) }, start: { line: 0, ch: 0 }, end: { line: 0, ch: 1 } } });
  assert.deepEqual(edits, []);
});
test('no-match queries skip backlink graph while candidates preserve ranking', () => {
  const { suggestor, state, plugin, app } = setup({ graphSize: 9500 });
  const start = performance.now();
  for (let i = 0; i < 50; i++) suggestor.getSuggestions({ query: 'no-match-' + i });
  const emptyReads = state.graphReads;
  const modal = new Plugin.Modal(app, plugin.entityMaps['@'].fileMap, {}, plugin.settings, '', () => {});
  for (let i = 0; i < 50; i++) modal.getSuggestions('no-match-' + i);
  const allEmptyReads = state.graphReads;
  const result = suggestor.getSuggestions({ query: '' });
  const result2 = modal.getSuggestions('Alice');
  console.log('PERF', JSON.stringify({ sourceNotes: 9500, queriesPerSurface: 50, editorEmptyGraphReads: emptyReads, allEmptyGraphReads: allEmptyReads, totalGraphReads: state.graphReads, elapsedMs: Math.round((performance.now() - start) * 100) / 100 }));
  assert.equal(emptyReads, 0);
  assert.equal(allEmptyReads, 0);
  assert.equal(result[0].displayText, 'Alice');
  assert.equal(result2[0].name, 'Alice');
  assert.equal(state.graphReads, 2);
});
(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('PASS', name); }
    catch (error) { failures++; console.log('FAIL', name, error.message); }
  }
  console.log(JSON.stringify({ source, passed: tests.length - failures, failed: failures, total: tests.length }));
  process.exitCode = failures ? 1 : 0;
})();
