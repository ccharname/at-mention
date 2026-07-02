const { AbstractInputSuggest, EditorSuggest, SuggestModal, Notice, Plugin, PluginSettingTab, Setting } = require('obsidian')

// Default mention type template
const DEFAULT_MENTION_TYPE = {
	trigger: '@',
	label: 'People',
	folders: ['People/'],
	defaultFolder: 'People/',
	requirePrefix: true,
	autoCreateFiles: false,
	useAliases: false,
	folderMode: 'DEFAULT',
}

// Default plugin configuration
const DEFAULT_SETTINGS = {
	mentionTypes: [{ ...DEFAULT_MENTION_TYPE }],
	useExplicitLinks: false,
}

// Regex to extract last name (last word after splitting by spaces)
const LAST_NAME_REGEX = /([\S]+)$/

// Ensure folder path ends with a trailing slash
const normalizeFolder = (p) => p.endsWith('/') ? p : p + '/'

// Max candidates to compute expensive scoring boost (backlinks + recency) for.
const BOOST_CUTOFF = 30

// Chars that break wikilinks (#^|[]) or are illegal in filenames (*"\/<>:?)
const INVALID_TRIGGER_CHARS = '#^|[]*"\\/<>:?'

// Helper to create multi-line descriptions in settings UI
const multiLineDesc = (strings) => {
	const descFragment = document.createDocumentFragment();
	strings.map((string, i, arr) => {
		descFragment.appendChild(document.createTextNode(string));
		if (arr.length - 1 !== i) {
			descFragment.appendChild(document.createElement("br"))
		};
	})
	return descFragment;
}

/**
 * Extract entity name from a file path based on mention type config.
 * Checks against all folders in the mention type's folders array.
 * Returns the canonical name (without trigger prefix) or false.
 */
const getEntityName = (filename, mentionType) => {
	if (!filename.endsWith('.md')) return false
	const folders = (mentionType.folders || []).map(normalizeFolder)
	const matchedFolder = folders.find(f => filename.startsWith(f))
	if (!matchedFolder) return false
	if (mentionType.requirePrefix) {
		const prefix = mentionType.trigger
		const regex = new RegExp('\\/' + escapeRegex(prefix) + '([^\\/]+)\\.md$')
		const match = regex.exec(filename)
		if (!match) return false
		return match[1]
	}
	// Without prefix requirement: any .md in the folder tree is an entity
	const regex = /\/([^\/]+)\.md$/
	const match = regex.exec(filename)
	if (!match) return false
	const name = match[1]
	// Strip trigger prefix from name if present for consistency
	return name.startsWith(mentionType.trigger) ? name.slice(mentionType.trigger.length) : name
}

function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = class AtMention extends Plugin {
	async onload() {
		this.entityMaps = {}
		await this.loadSettings()
		this.registerEvent(this.app.vault.on('delete', async event => { await this.update(event) }))
		this.registerEvent(this.app.vault.on('create', async event => { await this.update(event) }))
		this.registerEvent(this.app.vault.on('rename', async (event, originalFilepath) => { await this.update(event, originalFilepath) }))
		this.registerEvent(this.app.metadataCache.on('changed', (file) => { this.updateAliasesForFile(file) }))
		this.addSettingTab(new AtMentionSettingTab(this.app, this))
		this.suggestor = new AtMentionSuggestor(this.app, this)
		this.registerEditorSuggest(this.suggestor)

		this.addCommand({
			id: 'link-selection-to-entity',
			name: 'Link selected text to entity',
			editorCallback: (editor, view) => {
				const selection = editor.getSelection()
				if (!selection) {
					new Notice('No text selected')
					return
				}
				const from = editor.getCursor('from')
				const to = editor.getCursor('to')

				const allFileMaps = {}
				const allAliasMaps = {}
				for (const trigger in this.entityMaps) {
					Object.assign(allFileMaps, this.entityMaps[trigger].fileMap)
					Object.assign(allAliasMaps, this.entityMaps[trigger].aliasMap)
				}

				new EntitySuggestModal(
					this.app,
					allFileMaps,
					allAliasMaps,
					this.settings,
					selection,
					async (entityName) => {
						const trigger = this.findTriggerForEntity(entityName)
						const link = await this.createEntityLink(entityName, trigger)
						editor.replaceRange(link, from, to)
					}
				).open()
			}
		})

		this.app.workspace.onLayoutReady(this.initialize)
	}

	async loadSettings() {
		const stored = await this.loadData() || {}

		if (stored.peopleFolder && !stored.mentionTypes) {
			stored.mentionTypes = [{
				trigger: '@',
				label: 'People',
				folders: [stored.peopleFolder],
				defaultFolder: stored.peopleFolder,
				requirePrefix: stored.requireAtPrefix ?? true,
				autoCreateFiles: stored.autoCreateFiles ?? false,
				useAliases: stored.useAliases ?? false,
				folderMode: stored.folderMode ?? 'DEFAULT',
			}]
			stored.useExplicitLinks = stored.useExplicitLinks ?? false
			delete stored.peopleFolder
			delete stored.requireAtPrefix
			delete stored.autoCreateFiles
			delete stored.useAliases
			delete stored.folderMode
		}
		if (Array.isArray(stored.mentionTypes)) {
			for (var mt of stored.mentionTypes) {
				if (mt.folder && !mt.folders) {
					mt.folders = [mt.folder]
					mt.defaultFolder = mt.folder
					delete mt.folder
				}
			}
		}

		// structuredClone: defaults hold nested arrays; settings mutate in place,
		// a shallow copy would corrupt the module-level constants
		this.settings = Object.assign({}, structuredClone(DEFAULT_SETTINGS), stored)
		if (!Array.isArray(this.settings.mentionTypes) || this.settings.mentionTypes.length === 0) {
			this.settings.mentionTypes = [structuredClone(DEFAULT_MENTION_TYPE)]
		}
	}

	async saveSettings() {
		await this.saveData(this.settings || DEFAULT_SETTINGS)
	}

	findTriggerForEntity(entityName) {
		// Reverse order: on a name collision the command's Object.assign merge
		// shows the later type's entry, so resolve to that same type
		for (const trigger of Object.keys(this.entityMaps).reverse()) {
			if (this.entityMaps[trigger].fileMap[entityName]) return trigger
		}
		return this.settings.mentionTypes[0]?.trigger || '@'
	}

	getAliasesForFile = (filepath) => {
		const file = this.app.vault.getAbstractFileByPath(filepath)
		const aliases = file && this.app.metadataCache.getFileCache(file)?.frontmatter?.aliases
		return Array.isArray(aliases) ? aliases.filter(a => typeof a === 'string') : []
	}

	updateAliasesForFile = (file) => {
		let changed = false
		for (const mt of this.settings.mentionTypes) {
			if (!mt.useAliases) continue
			const name = getEntityName(file.path, mt)
			if (!name) continue
			const maps = this.entityMaps[mt.trigger]
			if (!maps) continue
			for (const [alias, canonical] of Object.entries(maps.aliasMap)) {
				if (canonical === name) delete maps.aliasMap[alias]
			}
			for (const alias of this.getAliasesForFile(file.path)) {
				maps.aliasMap[alias] = name
			}
			changed = true
		}
		if (changed) this.suggestor.updateEntityMaps(this.entityMaps)
	}

	update = async ({ path, deleted }, originalFilepath) => {
		let needsUpdate = false
		for (const mt of this.settings.mentionTypes) {
			const maps = this.entityMaps[mt.trigger]
			if (!maps) continue

			const name = getEntityName(path, mt)
			if (name) {
				if (deleted) {
					delete maps.fileMap[name]
					for (const [alias, canonical] of Object.entries(maps.aliasMap)) {
						if (canonical === name) delete maps.aliasMap[alias]
					}
				} else {
					maps.fileMap[name] = path
					if (mt.useAliases) {
						for (const alias of this.getAliasesForFile(path)) {
							maps.aliasMap[alias] = name
						}
					}
				}
				needsUpdate = true
			}

			if (originalFilepath) {
				const oldName = getEntityName(originalFilepath, mt)
				// oldName === name: moved within the same mention-type folder — the entry was
				// just refreshed above; deleting it here would erase a live entity
				if (oldName && oldName !== name) {
					delete maps.fileMap[oldName]
					for (const [alias, canonical] of Object.entries(maps.aliasMap)) {
						if (canonical === oldName) delete maps.aliasMap[alias]
					}
					needsUpdate = true
				}
			}
		}
		if (needsUpdate) this.suggestor.updateEntityMaps(this.entityMaps)
	}

	initialize = () => {
		this.entityMaps = {}
		for (const mt of this.settings.mentionTypes) {
			const fileMap = {}
			const aliasMap = {}
			for (const { path: filename } of this.app.vault.getMarkdownFiles()) {
				const name = getEntityName(filename, mt)
				if (name) {
					fileMap[name] = filename
					if (mt.useAliases) {
						for (const alias of this.getAliasesForFile(filename)) {
							aliasMap[alias] = name
						}
					}
				}
			}
			this.entityMaps[mt.trigger] = { fileMap, aliasMap, config: mt }
		}
		window.setTimeout(() => {
			this.suggestor.updateEntityMaps(this.entityMaps)
		})
	}

	async createEntityLink(display, trigger) {
		const mt = this.settings.mentionTypes.find(m => m.trigger === trigger)
		if (!mt) return '[[' + display + ']]'

		const lastNameMatch = LAST_NAME_REGEX.exec(display)
		const lastName = lastNameMatch && lastNameMatch[1] ? lastNameMatch[1] : ''
		const prefix = mt.requirePrefix ? mt.trigger : ''
		const filename = prefix + display + '.md'
		const displayName = mt.requirePrefix ? mt.trigger + display : display

		// Existing entity: link to its actual indexed path instead of reconstructing it —
		// the on-disk name may keep a trigger prefix that getEntityName stripped,
		// or live in a non-default folder
		const existingPath = this.entityMaps[trigger]?.fileMap[display]
		if (existingPath) {
			if (this.settings.useExplicitLinks) {
				return '[[' + existingPath + '|' + displayName + ']]'
			}
			return '[[' + existingPath.slice(existingPath.lastIndexOf('/') + 1, -3) + ']]'
		}

		var baseFolder = mt.defaultFolder || (mt.folders && mt.folders[0]) || ''
		let targetFolder = normalizeFolder(baseFolder)
		let filePath = targetFolder + filename

		if (mt.folderMode === "PER_PERSON") {
			targetFolder = normalizeFolder(baseFolder) + prefix + display + '/'
			filePath = targetFolder + filename
		} else if (mt.folderMode === "PER_LASTNAME") {
			targetFolder = normalizeFolder(baseFolder) + (lastName ? lastName + '/' : '')
			filePath = targetFolder + filename
		}

		if (mt.autoCreateFiles) {
			const folderToCreate = targetFolder.replace(/\/$/, '')
			try { await this.app.vault.createFolder(folderToCreate) } catch (e) { /* exists */ }
			try { await this.app.vault.create(filePath, '') } catch (e) { /* exists */ }
		}

		if (this.settings.useExplicitLinks) {
			return '[[' + filePath + '|' + displayName + ']]'
		}
		return '[[' + displayName + ']]'
	}
}

function removeAccents(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function fuzzyMatch(pattern, text) {
    pattern = removeAccents(pattern).toLowerCase();
    text = removeAccents(text).toLowerCase();

    const getSimilarityFactor = () => {
        const lenRatio = Math.min(pattern.length / text.length, 1.0);
        return Math.pow(lenRatio, 0.5);
    };

    const substringIndex = text.indexOf(pattern);
    if (substringIndex !== -1) {
        let substringScore = 2000;
        if (substringIndex === 0) {
            substringScore += 1000;
        } else if (text[substringIndex - 1] === ' ') {
            substringScore += 500;
        }
        return substringScore * getSimilarityFactor();
    }

    const patternWords = pattern.split(' ').filter(w => w.length > 0);
    if (patternWords.length > 1) {
        const textWords = text.split(' ');
        let matchedWords = 0;
        let usedIndices = new Set();
        for (let pWord of patternWords) {
            for (let i = 0; i < textWords.length; i++) {
                if (!usedIndices.has(i) && textWords[i].startsWith(pWord)) {
                    matchedWords++;
                    usedIndices.add(i);
                    break;
                }
            }
        }
        if (matchedWords === patternWords.length) {
            return 1500 * getSimilarityFactor();
        }
    }

    const words = text.split(' ');
    if (words.length > 1 && pattern.length <= words.length) {
        let patternIdx = 0;
        let wordIdx = 0;
        while (patternIdx < pattern.length && wordIdx < words.length) {
            if (words[wordIdx].length > 0 && words[wordIdx][0] === pattern[patternIdx]) {
                patternIdx++;
            }
            wordIdx++;
        }
        if (patternIdx === pattern.length) {
            return 1000 * getSimilarityFactor();
        }
    }

    for (let word of words) {
        if (word.startsWith(pattern)) {
            return 800 * getSimilarityFactor();
        }
    }

    return -Infinity;
}

function getScoringBoost(app, filepath) {
    const file = app.vault.getAbstractFileByPath(filepath);
    if (!file) return 0;

    let backlinkBoost = 0;
    const backlinks = app.metadataCache.getBacklinksForFile(file);
    if (backlinks && backlinks.data) {
        const count = backlinks.data.size;
        backlinkBoost = count > 0 ? Math.log(count + 1) * 1000 : 0;
    }

    const daysAgo = (Date.now() - file.stat.mtime) / 86400000;
    const recencyBoost = Math.max(0, 200 * Math.exp(-daysAgo / 30));

    return backlinkBoost + recencyBoost;
}

class EntitySuggestModal extends SuggestModal {
	constructor(app, fileMap, aliasMap, settings, initialQuery, onChoose) {
		super(app)
		this.fileMap = fileMap
		this.aliasMap = aliasMap
		this.settings = settings
		this.initialQuery = initialQuery
		this.onChoose = onChoose
		this.setPlaceholder('Select entity or create new')
	}

	onOpen() {
		super.onOpen()
		this.inputEl.value = this.initialQuery
		this.inputEl.select()
		this.scope.register([], "Tab", (evt) => {
			if (this.chooser && this.chooser.selectedItem >= 0 && this.chooser.values) {
				const selectedSuggestion = this.chooser.values[this.chooser.selectedItem]
				this.onChooseSuggestion(selectedSuggestion)
				this.close()
				return false
			}
			return true
		})
	}

	getSuggestions(query) {
		const bestByEntity = {}

		// Empty query (user cleared the box): browse everything, ranked by boost
		for (let key in (this.fileMap || {})) {
			const score = query ? fuzzyMatch(query, key) : 1
			if (score > 0) {
				bestByEntity[key] = { score, matchedAlias: null }
			}
		}

		for (let alias in (this.aliasMap || {})) {
			const canonicalName = this.aliasMap[alias]
			if (!(this.fileMap || {})[canonicalName]) continue
			const score = fuzzyMatch(query, alias)
			if (score > 0 && (!bestByEntity[canonicalName] || score > bestByEntity[canonicalName].score)) {
				bestByEntity[canonicalName] = { score, matchedAlias: alias }
			}
		}

		let fuzzyResults = Object.entries(bestByEntity).map(([name, data]) => ({ name, ...data }))
		fuzzyResults.sort((a, b) => b.score - a.score)
		const topCandidates = query ? fuzzyResults.slice(0, BOOST_CUTOFF) : fuzzyResults

		for (const candidate of topCandidates) {
			candidate.score += getScoringBoost(this.app, this.fileMap[candidate.name])
		}

		topCandidates.sort((a, b) => b.score - a.score)
		let suggestions = topCandidates.slice(0, 20).map(s => ({
			type: 'existing',
			name: s.name,
			matchedAlias: s.matchedAlias,
		}))

		if (query) suggestions.push({ type: 'create', name: query })
		return suggestions
	}

	renderSuggestion(suggestion, el) {
		if (suggestion.type === 'create') {
			el.createEl('div', { text: 'New: ' + suggestion.name })
		} else if (suggestion.matchedAlias) {
			el.createEl('div', { text: suggestion.name + ' (via ' + suggestion.matchedAlias + ')' })
		} else {
			el.createEl('div', { text: suggestion.name })
		}
	}

	onChooseSuggestion(suggestion) {
		this.onChoose(suggestion.name)
	}
}

class AtMentionSuggestor extends EditorSuggest {
	constructor(app, plugin) {
		super(app)
		this.plugin = plugin
		this.entityMaps = {}
		this.dismissedTriggers = {}
		this.activeTrigger = null

		this.scope.register([], "Tab", (evt) => {
			if (this.suggestions && this.suggestions.values && this.suggestions.selectedItem >= 0) {
				const selectedValue = this.suggestions.values[this.suggestions.selectedItem]
				this.selectSuggestion(selectedValue)
				return false
			}
			return true
		})
	}

	close() {
		if (this.context && !this._selectionMade) {
			const key = this.context.start.line + ':' + this.context.start.ch
			// Remember what was dismissed, so a changed query can re-trigger
			this.dismissedTriggers[key] = this.context.query || ''
		}
		this._selectionMade = false
		super.close()
	}

	updateEntityMaps(entityMaps) {
		this.entityMaps = entityMaps
	}

	onTrigger(cursor, editor, tFile) {
		const line = editor.getLine(cursor.line).substring(0, cursor.ch)
		let bestMatch = null

		for (const mt of this.plugin.settings.mentionTypes) {
			const idx = line.lastIndexOf(mt.trigger)
			if (idx < 0) continue
			const query = line.substring(idx + mt.trigger.length)
			// Boundary: a mention is a name, not a sentence — stop following the cursor
			// once the query is clearly prose (keeps multi-word names working)
			if (query.length > 50 || query.split(' ').length > 5) continue
			if (idx > 0 && line[idx - 1] !== ' ') continue

			if (!bestMatch || idx > bestMatch.index) {
				bestMatch = { index: idx, trigger: mt.trigger, query }
			}
		}

		if (!bestMatch) {
			this.dismissedTriggers = {}
			return null
		}

		const key = cursor.line + ':' + bestMatch.index
		const dismissedQuery = this.dismissedTriggers[key]
		if (dismissedQuery !== undefined) {
			// Still the same (or continued) query → respect the dismissal;
			// a rewritten query is a fresh mention attempt
			if (bestMatch.query.startsWith(dismissedQuery)) return null
			delete this.dismissedTriggers[key]
		}

		this.activeTrigger = bestMatch.trigger

		return {
			start: { line: cursor.line, ch: bestMatch.index },
			end: { line: cursor.line, ch: cursor.ch },
			query: bestMatch.query,
		}
	}

	getSuggestions(context) {
		const maps = this.entityMaps[this.activeTrigger]
		if (!maps) return []

		const mt = maps.config
		const bestByEntity = {}

		for (let key in (maps.fileMap || {})) {
			// Empty query (bare trigger): list everything, ranked by backlink/recency boost
			const score = context.query ? fuzzyMatch(context.query, key) : 1
			if (score > 0) {
				bestByEntity[key] = { score, matchedAlias: null }
			}
		}

		if (mt.useAliases) {
			for (let alias in (maps.aliasMap || {})) {
				const canonicalName = maps.aliasMap[alias]
				if (!maps.fileMap[canonicalName]) continue
				const score = fuzzyMatch(context.query, alias)
				if (score > 0 && (!bestByEntity[canonicalName] || score > bestByEntity[canonicalName].score)) {
					bestByEntity[canonicalName] = { score, matchedAlias: alias }
				}
			}
		}

		let fuzzyResults = Object.entries(bestByEntity).map(([name, data]) => ({ name, ...data }))
		fuzzyResults.sort((a, b) => b.score - a.score)
		// ponytail: empty query boosts all entities (scores are uniform, cutoff would pick arbitrarily); fine for hundreds, revisit if a mention folder hits thousands
		const topCandidates = context.query ? fuzzyResults.slice(0, BOOST_CUTOFF) : fuzzyResults

		for (const candidate of topCandidates) {
			candidate.score += getScoringBoost(this.app, maps.fileMap[candidate.name])
		}

		topCandidates.sort((a, b) => b.score - a.score)
		let suggestions = topCandidates.slice(0, 20).map(s => ({
			suggestionType: 'set',
			displayText: s.name,
			matchedAlias: s.matchedAlias,
			context,
		}))

		suggestions.push({ suggestionType: 'create', displayText: context.query, context })
		return suggestions
	}

	renderSuggestion(value, elem) {
		const maps = this.entityMaps[this.activeTrigger]
		const label = maps ? maps.config.label : ''
		if (value.suggestionType === 'create') {
			elem.setText('New ' + label + ': ' + value.displayText)
		} else if (value.matchedAlias) {
			elem.setText(value.displayText + ' (via ' + value.matchedAlias + ')')
		} else {
			elem.setText(value.displayText)
		}
	}

	async selectSuggestion(value) {
		this._selectionMade = true
		this.dismissedTriggers = {}
		const trigger = this.activeTrigger
		const link = await this.plugin.createEntityLink(value.displayText, trigger)

		value.context.editor.replaceRange(
			link,
			value.context.start,
			value.context.end,
		)
	}
}

class FolderSuggest extends AbstractInputSuggest {
	constructor(app, inputEl, onChangeCb) {
		super(app, inputEl)
		this.textInputEl = inputEl
		this.onChangeCb = onChangeCb
	}

	getSuggestions(inputStr) {
		const inputLower = inputStr.toLowerCase()
		const folders = this.app.vault.getAllFolders().map(f => f.path + '/')
		return folders.filter(folder => folder.toLowerCase().includes(inputLower))
	}

	renderSuggestion(folder, el) {
		el.createEl('div', { text: folder })
	}

	selectSuggestion(folder, evt) {
		this.textInputEl.value = folder
		this.close()
		this.onChangeCb(folder)
	}
}

class AtMentionSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin)
		this.plugin = plugin
	}

	display() {
		const { containerEl } = this
		containerEl.empty()
		containerEl.createEl('h2', { text: 'At Mention Settings' })

		new Setting(containerEl)
			.setName('Explicit links')
			.setDesc('When inserting links include the full path')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useExplicitLinks)
				.onChange(async (value) => {
					this.plugin.settings.useExplicitLinks = value
					await this.plugin.saveSettings()
					this.plugin.initialize()
				})
			)

		containerEl.createEl('h3', { text: 'Mention Types' })

		this.plugin.settings.mentionTypes.forEach((mt, index) => {
			const section = containerEl.createDiv({ cls: 'at-mention-type-section' })
			section.style.border = '1px solid var(--background-modifier-border)'
			section.style.borderRadius = '8px'
			section.style.padding = '12px'
			section.style.marginBottom = '12px'

			const header = section.createDiv({ cls: 'at-mention-type-header' })
			header.style.display = 'flex'
			header.style.justifyContent = 'space-between'
			header.style.alignItems = 'center'
			header.style.marginBottom = '8px'

			const title = header.createEl('h4', { text: mt.trigger + ' ' + mt.label })
			title.style.margin = '0'

			if (this.plugin.settings.mentionTypes.length > 1) {
				const deleteBtn = header.createEl('button', { text: 'Remove' })
				deleteBtn.style.color = 'var(--text-error)'
				deleteBtn.addEventListener('click', async () => {
					this.plugin.settings.mentionTypes.splice(index, 1)
					await this.plugin.saveSettings()
					this.plugin.initialize()
					this.display()
				})
			}

			new Setting(section)
				.setName('Trigger character')
				.setDesc('The character that activates this mention type')
				.addText(text => text
					.setPlaceholder('@')
					.setValue(mt.trigger)
					.onChange(async (value) => {
						if (value.length > 0) {
							const t = value.charAt(0)
							if (INVALID_TRIGGER_CHARS.includes(t)) {
								new Notice('"' + t + '" cannot be a trigger: it breaks wikilinks or filenames')
								return
							}
							if (this.plugin.settings.mentionTypes.some(m => m !== mt && m.trigger === t)) {
								new Notice('"' + t + '" is already used by another mention type')
								return
							}
							mt.trigger = t
							await this.plugin.saveSettings()
							this.plugin.initialize()
						}
					})
				)

			new Setting(section)
				.setName('Label')
				.setDesc('Display name for this mention type')
				.addText(text => text
					.setPlaceholder('People')
					.setValue(mt.label)
					.onChange(async (value) => {
						mt.label = value
						await this.plugin.saveSettings()
					})
				)

			var foldersContainer = section.createDiv()
			var folders = mt.folders || []
			folders.forEach((folder, fi) => {
				new Setting(foldersContainer)
					.setName(fi === 0 ? 'Folders' : '')
					.setDesc(fi === 0 ? 'Folders to scan for entity files' : '')
					.addSearch(search => {
						var handleFolderChange = async (value) => {
							mt.folders[fi] = value
							if (fi === 0) mt.defaultFolder = value
							await this.plugin.saveSettings()
							this.plugin.initialize()
						}
						search
							.setPlaceholder('People/')
							.setValue(folder)
							.onChange(handleFolderChange)
						new FolderSuggest(this.app, search.inputEl, handleFolderChange)
						search.inputEl.blur()
					})
					.addButton(btn => {
						btn.setButtonText('-')
						btn.setTooltip('Remove folder')
						if (folders.length <= 1) btn.setDisabled(true)
						btn.onClick(async () => {
							mt.folders.splice(fi, 1)
							mt.defaultFolder = mt.folders[0] || ''
							await this.plugin.saveSettings()
							this.plugin.initialize()
							this.display()
						})
					})
			})
			new Setting(foldersContainer)
				.addButton(btn => {
					btn.setButtonText('+ Add folder')
					btn.onClick(async () => {
						if (!mt.folders) mt.folders = []
						mt.folders.push('')
						await this.plugin.saveSettings()
						this.display()
					})
				})

			new Setting(section)
				.setName('Require trigger prefix in filename')
				.setDesc(multiLineDesc([
					'When enabled, only files starting with "' + mt.trigger + '" are recognized.',
					'When disabled, all .md files in the folder are treated as entities.'
				]))
				.addToggle(toggle => toggle
					.setValue(mt.requirePrefix)
					.onChange(async (value) => {
						mt.requirePrefix = value
						await this.plugin.saveSettings()
						this.plugin.initialize()
					})
				)

			new Setting(section)
				.setName('Auto-create files')
				.setDesc('Automatically create entity files when selecting a new suggestion')
				.addToggle(toggle => toggle
					.setValue(mt.autoCreateFiles)
					.onChange(async (value) => {
						mt.autoCreateFiles = value
						await this.plugin.saveSettings()
					})
				)

			new Setting(section)
				.setName('Include aliases')
				.setDesc('Match entities by their frontmatter aliases')
				.addToggle(toggle => toggle
					.setValue(mt.useAliases)
					.onChange(async (value) => {
						mt.useAliases = value
						await this.plugin.saveSettings()
						this.plugin.initialize()
					})
				)

			new Setting(section)
				.setName('Folder mode')
				.setDesc(multiLineDesc([
					"Default: Folder/Entity.md",
					"Per Entity: Folder/Entity/Entity.md",
					"Per Lastname: Folder/LastName/Entity.md",
				]))
				.addDropdown(dropdown => {
					dropdown.addOption("DEFAULT", "Default")
					dropdown.addOption("PER_PERSON", "Per entity")
					dropdown.addOption("PER_LASTNAME", "Per lastname")
					dropdown.setValue(mt.folderMode || 'DEFAULT')
					dropdown.onChange(async (value) => {
						mt.folderMode = value
						await this.plugin.saveSettings()
						this.plugin.initialize()
					})
				})
		})

		new Setting(containerEl)
			.setName('Add mention type')
			.setDesc('Add a new trigger character with its own folder')
			.addButton(button => button
				.setButtonText('+ Add')
				.onClick(async () => {
					var usedTriggers = this.plugin.settings.mentionTypes.map(function(m) { return m.trigger })
					var candidates = ['@', '&', '~', '!', '+', '$']
					var available = candidates.find(function(t) { return usedTriggers.indexOf(t) === -1 })
					this.plugin.settings.mentionTypes.push({
						trigger: available || '~',
						label: 'New Type',
						folders: [''],
						defaultFolder: '',
						requirePrefix: false,
						autoCreateFiles: false,
						useAliases: false,
						folderMode: 'DEFAULT',
					})
					await this.plugin.saveSettings()
					this.plugin.initialize()
					this.display()
				})
			)
	}
}
/* nosourcemap */
