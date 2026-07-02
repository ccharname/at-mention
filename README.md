# At Mention

Obsidian plugin for multi-trigger entity mentions. Type `@` (or any custom trigger character) to fuzzy-search and link entity notes — people, projects, companies, anything that lives in a folder.

## Features

- **Multiple mention types** — each trigger character (`@`, `#`, `&`, …) maps to its own folder(s) and settings
- **Fuzzy search with smart ranking** — matches names and frontmatter aliases; results boosted by backlink count and recency
- **Bare trigger browsing** — type just `@` to see your most-linked / most-recent entities
- **Auto-create entity files** — optionally create the note (with per-entity or per-lastname subfolders) when you mention someone new
- **Link selected text** — command palette action to turn any selected text into an entity link

## Install via BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. In BRAT settings, choose **Add Beta plugin** and enter:
   ```
   ccharname/at-mention
   ```
3. Enable **At Mention** in Community plugins

## Usage

1. Open **Settings → At Mention** and configure a mention type: trigger character, label, and the folder(s) containing your entity notes (e.g. `People/`)
2. In any note, type the trigger (e.g. `@ali`) and pick a suggestion — a wikilink is inserted
3. Optional per-type settings:
   - **Require trigger prefix in filename** — only files named like `@Alice.md` count as entities
   - **Include aliases** — match frontmatter `aliases` too
   - **Auto-create files** — create the entity note on first mention
   - **Folder mode** — flat, per-entity subfolder, or per-lastname subfolder

## License

MIT
