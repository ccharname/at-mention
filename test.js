// Minimal logic checks: node test.js
// Stubs the 'obsidian' module so main.js loads outside the app.
const assert = require('assert')
const Module = require('module')
const origLoad = Module._load
Module._load = (request, ...args) => request === 'obsidian'
	? {
		AbstractInputSuggest: class {}, EditorSuggest: class {}, SuggestModal: class {},
		Notice: class {}, Plugin: class {}, PluginSettingTab: class {}, Setting: class {},
	}
	: origLoad(request, ...args)

const AtMention = require('./main.js')

const makePlugin = (mt, useExplicitLinks = false) => {
	const p = new AtMention()
	p.settings = { mentionTypes: [mt], useExplicitLinks }
	p.suggestor = { updateEntityMaps() {} }
	p.entityMaps = { [mt.trigger]: { fileMap: {}, aliasMap: {}, config: mt } }
	return p
}

const MT = {
	trigger: '@', label: 'People', folders: ['People/'], defaultFolder: 'People/',
	requirePrefix: true, autoCreateFiles: false, useAliases: false, folderMode: 'DEFAULT',
}

async function main() {
	// rename within the same mention-type folder keeps the entity (audit fix 1)
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

	// existing entity links to its real on-disk name even when requirePrefix=false
	// indexed name "Bob" but file is @Bob.md (audit fix 4)
	const mtNoPrefix = { ...MT, requirePrefix: false }
	p = makePlugin(mtNoPrefix)
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

	console.log('all checks passed')
}

main().catch(e => { console.error(e); process.exit(1) })
