// Minimal logic checks: node test.js
// Stubs the 'obsidian' module so main.js loads outside the app.
const assert = require('assert')
const Module = require('module')
const origLoad = Module._load
Module._load = (request, ...args) => request === 'obsidian'
	? {
		AbstractInputSuggest: class {},
		EditorSuggest: class { constructor() { this.scope = { register() {} } } close() {} },
		SuggestModal: class { constructor() { this.scope = { register() {} } } setPlaceholder() {} },
		Notice: class {},
		Plugin: class {
			constructor(app) { this.app = app }
			registerEvent() {}
			addSettingTab() {}
			addCommand() {}
			registerEditorSuggest() {}
			async loadData() { return this._data }
			async saveData() {}
		},
		PluginSettingTab: class {},
		Setting: class {},
	}
	: origLoad(request, ...args)

const AtMention = require('./main.js')

const MT = {
	trigger: '@', label: 'People', folders: ['People/'], defaultFolder: 'People/',
	requirePrefix: true, autoCreateFiles: false, useAliases: false, folderMode: 'DEFAULT',
}

const makePlugin = (mt, useExplicitLinks = false) => {
	const p = new AtMention()
	p.settings = { mentionTypes: [mt], useExplicitLinks }
	p.suggestor = { updateEntityMaps() {} }
	p.entityMaps = { [mt.trigger]: { fileMap: {}, aliasMap: {}, config: mt } }
	return p
}

async function main() {
	// --- update(): rename within the same mention-type folder keeps the entity
	let p = makePlugin({ ...MT })
	p.entityMaps['@'].fileMap['John'] = 'People/@John.md'
	await p.update({ path: 'People/Archive/@John.md' }, 'People/@John.md')
	assert.strictEqual(p.entityMaps['@'].fileMap['John'], 'People/Archive/@John.md', 'move-to-subfolder must keep entity')

	// rename that changes the name swaps old for new
	await p.update({ path: 'People/@Johnny.md' }, 'People/Archive/@John.md')
	assert.strictEqual(p.entityMaps['@'].fileMap['John'], undefined)
	assert.strictEqual(p.entityMaps['@'].fileMap['Johnny'], 'People/@Johnny.md')

	// delete removes the entity (relies on Obsidian's internal deleted flag)
	await p.update({ path: 'People/@Johnny.md', deleted: true })
	assert.strictEqual(p.entityMaps['@'].fileMap['Johnny'], undefined)

	// --- createEntityLink(): existing entity links to its real on-disk name
	// indexed name "Bob" but file is @Bob.md (requirePrefix off)
	p = makePlugin({ ...MT, requirePrefix: false })
	p.entityMaps['@'].fileMap['Bob'] = 'People/@Bob.md'
	assert.strictEqual(await p.createEntityLink('Bob', '@'), '[[@Bob]]')

	// explicit links use the actual indexed path, not a reconstructed guess
	p.settings.useExplicitLinks = true
	assert.strictEqual(await p.createEntityLink('Bob', '@'), '[[People/@Bob.md|Bob]]')

	// unknown entity still falls through to the constructed-link path
	p.settings.useExplicitLinks = false
	assert.strictEqual(await p.createEntityLink('Carol', '@'), '[[Carol]]')
	p = makePlugin({ ...MT })
	assert.strictEqual(await p.createEntityLink('Dave', '@'), '[[@Dave]]')

	// --- onTrigger(): boundary, link guard, dismissal semantics
	const appStub = {
		vault: { on() {}, getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
		metadataCache: { on() {} },
		workspace: { onLayoutReady() {} },
	}
	p = new AtMention(appStub)
	p._data = { mentionTypes: [{ ...MT }], useExplicitLinks: false }
	await p.onload()
	const sg = p.suggestor
	const trig = (text) => sg.onTrigger({ line: 0, ch: text.length }, { getLine: () => text })

	let ctx = trig('Met @bo')
	assert.strictEqual(ctx && ctx.query, 'bo')
	// prose boundary: popup stops following a sentence
	assert.strictEqual(trig('Met @bob about the roadmap next week please'), null)
	// trigger inside an inserted link stays inert (preceded by "[")
	assert.strictEqual(trig('See [[@Bob]]'), null)
	// a completed wikilink later in the query no longer kills the mention
	ctx = trig('@bob knows [[Plan]]')
	assert.strictEqual(ctx && ctx.query, 'bob knows [[Plan]]')
	// Escape at "bo" stays dismissed while the same query continues...
	sg.context = { start: { line: 0, ch: 4 }, query: 'bo' }
	sg.close()
	assert.strictEqual(trig('Met @bob'), null)
	// ...but a rewritten query is a fresh mention attempt
	ctx = trig('Met @sam')
	assert.strictEqual(ctx && ctx.query, 'sam')

	// --- findTriggerForEntity(): resolves name collisions to the same type the
	// link-selection command displays (last type wins in its merged map)
	p = new AtMention()
	const mtA = { ...MT }
	const mtB = { ...MT, trigger: '&', folders: ['Also/'], defaultFolder: 'Also/' }
	p.settings = { mentionTypes: [mtA, mtB], useExplicitLinks: false }
	p.entityMaps = {
		'@': { fileMap: { Sam: 'People/@Sam.md' }, aliasMap: {}, config: mtA },
		'&': { fileMap: { Sam: 'Also/Sam.md' }, aliasMap: {}, config: mtB },
	}
	assert.strictEqual(p.findTriggerForEntity('Sam'), '&')

	// --- updateAliasesForFile(): refreshes every matching mention type
	const mt1 = { ...MT, useAliases: true }
	const mt2 = { ...MT, trigger: '&', useAliases: true, requirePrefix: false }
	p = new AtMention({
		vault: { getAbstractFileByPath: () => ({}) },
		metadataCache: { getFileCache: () => ({ frontmatter: { aliases: ['Ace'] } }) },
	})
	p.settings = { mentionTypes: [mt1, mt2], useExplicitLinks: false }
	p.suggestor = { updateEntityMaps() {} }
	p.entityMaps = {
		'@': { fileMap: {}, aliasMap: {}, config: mt1 },
		'&': { fileMap: {}, aliasMap: {}, config: mt2 },
	}
	p.updateAliasesForFile({ path: 'People/@Al.md' })
	assert.strictEqual(p.entityMaps['@'].aliasMap['Ace'], 'Al')
	assert.strictEqual(p.entityMaps['&'].aliasMap['Ace'], '@Al')

	// --- loadSettings(): mutating one plugin's settings must not pollute defaults
	const pa = new AtMention()
	pa._data = null
	await pa.loadSettings()
	pa.settings.mentionTypes[0].folders.push('Polluted/')
	const pb = new AtMention()
	pb._data = null
	await pb.loadSettings()
	assert.strictEqual(pb.settings.mentionTypes[0].folders.length, 1, 'defaults must stay clean across loads')

	console.log('all checks passed')
}

main().catch(e => { console.error(e); process.exit(1) })
