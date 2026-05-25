import {
	App,
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TFile,
	HeadingCache,
	CachedMetadata
} from 'obsidian';

interface HeadingLinkSettings {
	pathFormat: 'relative' | 'full';
	renameScope: 'vault' | 'folder' | 'file';
}

const DEFAULT_SETTINGS: HeadingLinkSettings = {
	pathFormat: 'relative',
	renameScope: 'vault'
}

export default class HeadingLinkCopierPlugin extends Plugin {
	settings!: HeadingLinkSettings;

	async onload() {
		await this.loadSettings();

		// Adds the settings tab
		this.addSettingTab(new HeadingLinkSettingTab(this.app, this));

		// Registers the right-click menu event in the Markdown Editor
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				const file = view.file;
				if (!file) return;

				const cache = this.app.metadataCache.getFileCache(file);
				if (!cache || !cache.headings) return;

				const cursor = editor.getCursor();

				// Check if the cursor is currently on a heading
				const targetHeading = cache.headings.find(h =>
					cursor.line >= h.position.start.line &&
					cursor.line <= h.position.end.line
				);

				if (targetHeading) {
					menu.addItem((item) => {
						item.setTitle('Copy markdown link to heading')
							.setIcon('link')
							.onClick(() => this.copyHeadingLink(file, targetHeading, cache, editor));
					});

					menu.addItem((item) => {
						item.setTitle('Rename this heading...')
							.setIcon('pencil')
							.onClick(() => {
								new RenameHeadingModal(this.app, this, file, targetHeading, editor).open();
							});
					});

					menu.addItem((item) => {
						item.setTitle('Find heading references...')
							.setIcon('search')
							.onClick(() => {
								new FindReferencesModal(this.app, this, file, targetHeading).open();
							});
					});
				}
			})
		);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async copyHeadingLink(file: TFile, targetHeading: HeadingCache, cache: CachedMetadata, editor: Editor) {
		// 1. Determine File Path String
		let pathStr = "";
		if (this.settings.pathFormat === 'full') {
			pathStr = file.path; // e.g., "folder/subfolder/file.md"
		} else {
			pathStr = `./${file.name}`; // e.g., "./file.md"
		}

		// Encode spaces and special characters for standard Markdown links
		// Split by '/' so we don't encode the path separators, and then encode each part
		// This handles '#' and '?' in filenames properly
		const encodedPath = pathStr.split('/').map(p => encodeURIComponent(p)).join('/');

		// 2. Check for uniqueness and determine fragment
		const isUnique = cache.headings ? cache.headings.filter(h => h.heading === targetHeading.heading).length === 1 : true;

		let fragment = "";
		if (isUnique) {
			// c. if the heading itself is already unique, do things like normal
			fragment = targetHeading.heading.replace(/ /g, '%20');
		} else {
			// When copying a heading link, if the heading in the current file is not unique:
			const lineNum = targetHeading.position.start.line;
			const lineContent = editor.getLine(lineNum);

			// b. if the heading is already having a html id, copy the id as the link. Don't add another id
			const idMatch = lineContent.match(/id=['"]([^'"]+)['"]/i);

			if (idMatch && idMatch[1]) {
				fragment = idMatch[1];
			} else {
				// a. edit the markdown so that the heading contains an explicit HTML ID, and use the id as the link
				const safeHeading = targetHeading.heading.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').toLowerCase();
				const newId = `${safeHeading}-${Math.random().toString(36).substring(2, 8)}`;
				const newLineContent = lineContent + ` <a id="${newId}"></a>`;
				editor.setLine(lineNum, newLineContent);
				fragment = newId;
			}
		}

		// 3. Assemble Final Markdown Link
		// the link text should remain the same as the heading itself like before
		const linkText = targetHeading.heading;
		const markdownLink = `[${linkText}](${encodedPath}#${fragment})`;

		// 4. Write to Clipboard
		await navigator.clipboard.writeText(markdownLink);
		new Notice('Heading link copied to clipboard!');
	}
}

/**
 * Escapes special regex characters in a string so it can be used as a literal in a RegExp.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class RenameHeadingModal extends Modal {
	plugin: HeadingLinkCopierPlugin;
	file: TFile;
	heading: HeadingCache;
	editor: Editor;
	newName: string;

	constructor(app: App, plugin: HeadingLinkCopierPlugin, file: TFile, heading: HeadingCache, editor: Editor) {
		super(app);
		this.plugin = plugin;
		this.file = file;
		this.heading = heading;
		this.editor = editor;
		this.newName = heading.heading;
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle('Rename heading');

		new Setting(contentEl)
			.setName('New heading name')
			.addText((text) => {
				text.setValue(this.heading.heading);
				text.onChange((value) => { this.newName = value; });
				text.inputEl.select();
				text.inputEl.style.width = '100%';
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); this.doRename(); }
				});
			});

		new Setting(contentEl)
			.addButton((btn) => btn
				.setButtonText('Rename')
				.setCta()
				.onClick(() => this.doRename()))
			.addButton((btn) => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	async doRename() {
		const newName = this.newName.trim();
		const oldName = this.heading.heading;

		// Validate
		if (!newName) {
			new Notice('Heading name cannot be empty.');
			return;
		}
		if (newName === oldName) {
			this.close();
			return;
		}

		// Step 1: Rename the heading in the current file
		const lineNum = this.heading.position.start.line;
		const lineContent = this.editor.getLine(lineNum);

		// Preserve the heading prefix (e.g. "## ") and any trailing <a id="..."> tag
		const headingPrefixMatch = lineContent.match(/^(#{1,6})\s+/);
		if (!headingPrefixMatch) {
			new Notice('Could not parse heading line.');
			return;
		}
		const prefix = headingPrefixMatch[0]; // e.g. "## "

		// Check for trailing <a id="..."> tag and update it if present
		const trailingAnchorMatch = lineContent.match(/(\s*<a\s+id=["'])([^"']+)(["']\s*>\s*<\/a>\s*)$/);
		let newLine: string;
		if (trailingAnchorMatch) {
			// Update the id attribute to match the new heading
			const safeNewHeading = newName.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').toLowerCase();
			const oldId = trailingAnchorMatch[2];
			// Preserve the random suffix if it exists
			const suffixMatch = oldId.match(/-([a-z0-9]{6})$/);
			const suffix = suffixMatch ? `-${suffixMatch[1]}` : '';
			const newId = `${safeNewHeading}${suffix}`;
			newLine = `${prefix}${newName}${trailingAnchorMatch[1]}${newId}${trailingAnchorMatch[3]}`;
		} else {
			newLine = `${prefix}${newName}`;
		}
		this.editor.setLine(lineNum, newLine);

		// Step 2: Determine files in scope
		const scope = this.plugin.settings.renameScope;
		let filesToSearch: TFile[];

		if (scope === 'file') {
			filesToSearch = [this.file];
		} else if (scope === 'folder') {
			const currentFolder = this.file.parent?.path ?? '';
			filesToSearch = this.app.vault.getMarkdownFiles().filter(f =>
				(f.parent?.path ?? '') === currentFolder
			);
		} else {
			// vault
			filesToSearch = this.app.vault.getMarkdownFiles();
		}

		// Step 3: Build regex patterns for the old heading
		const escapedOld = escapeRegex(oldName);
		const escapedOldEncoded = escapeRegex(oldName.replace(/ /g, '%20'));
		const escapedNew = newName;
		const escapedNewEncoded = newName.replace(/ /g, '%20');

		// Wikilinks: [[...#OldHeading]] and [[...#OldHeading|alias]]
		const wikiLinkRegex = new RegExp(
			`(\\[\\[[^\\]]*?#)${escapedOld}((?:\\]\\])|(?:\\|([^\\]]*)\\]\\]))`, 'g'
		);
		// Standard markdown links: [alias](path#OldHeading) — heading may be URL-encoded
		const mdLinkRegex = new RegExp(
			`\\[([^\\]]*)\\]\\(([^)]*?#)${escapedOldEncoded}\\)`, 'g'
		);
		// HTML links: <a href="path#OldHeading">alias</a>
		const htmlLinkRegex = new RegExp(
			`(<a[^>]*?href=["'][^"']*?#)${escapedOldEncoded}(["'][^>]*>)([^<]*)(</a>)`, 'g'
		);

		// Step 4: Search and replace in each file
		let totalLinks = 0;
		let totalFiles = 0;
		const affectedFiles: string[] = [];

		for (const f of filesToSearch) {
			// Skip the current file for vault.process — we already edited it via editor
			// but we still need to update links within the current file
			try {
				let fileLinksUpdated = 0;
				await this.app.vault.process(f, (data) => {
					let newData = data;

					// Replace wikilinks
					newData = newData.replace(wikiLinkRegex, (match, before, after, alias) => {
						fileLinksUpdated++;
						if (alias === oldName) {
							return `${before}${escapedNew}|${escapedNew}]]`;
						}
						return `${before}${escapedNew}${after}`;
					});

					// Replace markdown links
					newData = newData.replace(mdLinkRegex, (match, alias, pathAndHash) => {
						fileLinksUpdated++;
						if (alias === oldName) {
							return `[${escapedNew}](${pathAndHash}${escapedNewEncoded})`;
						}
						return `[${alias}](${pathAndHash}${escapedNewEncoded})`;
					});

					// Replace HTML links
					newData = newData.replace(htmlLinkRegex, (match, beforeHref, afterHref, alias, endTag) => {
						fileLinksUpdated++;
						if (alias === oldName) {
							return `${beforeHref}${escapedNewEncoded}${afterHref}${escapedNew}${endTag}`;
						}
						return `${beforeHref}${escapedNewEncoded}${afterHref}${alias}${endTag}`;
					});

					return newData;
				});

				if (fileLinksUpdated > 0) {
					totalLinks += fileLinksUpdated;
					totalFiles++;
					affectedFiles.push(`${f.path} (${fileLinksUpdated} link${fileLinksUpdated > 1 ? 's' : ''})`);
				}
			} catch (err) {
				console.error(`Heading rename: failed to process ${f.path}`, err);
			}
		}

		// Step 5: Show results
		if (totalLinks > 0) {
			const summary = `Renamed heading. Updated ${totalLinks} link${totalLinks > 1 ? 's' : ''} across ${totalFiles} file${totalFiles > 1 ? 's' : ''}:\n${affectedFiles.join('\n')}`;
			new Notice(summary, 8000);
		} else {
			new Notice('Heading renamed. No links to update.');
		}

		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

interface HeadingReference {
	file: TFile;
	lineNum: number;
	lineText: string;
	linesBefore: string[];
	linesAfter: string[];
	matchStartIndex: number;
	matchEndIndex: number;
}

class FindReferencesModal extends SuggestModal<HeadingReference> {
	plugin: HeadingLinkCopierPlugin;
	file: TFile;
	heading: HeadingCache;
	suggestions: HeadingReference[] = [];

	constructor(app: App, plugin: HeadingLinkCopierPlugin, file: TFile, heading: HeadingCache) {
		super(app);
		this.plugin = plugin;
		this.file = file;
		this.heading = heading;
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to open file' },
			{ command: 'esc', purpose: 'to dismiss' }
		]);
	}

	async open() {
		await this.findReferences();
		if (this.suggestions.length > 0) {
			const scope = this.plugin.settings.renameScope;
			this.setPlaceholder(`Found ${this.suggestions.length} reference(s) in ${scope} scope. Type to filter...`);
			super.open();
		}
	}

	async findReferences() {
		const oldName = this.heading.heading;
		const scope = this.plugin.settings.renameScope;
		let filesToSearch: TFile[];

		if (scope === 'file') {
			filesToSearch = [this.file];
		} else if (scope === 'folder') {
			const currentFolder = this.file.parent?.path ?? '';
			filesToSearch = this.app.vault.getMarkdownFiles().filter(f =>
				(f.parent?.path ?? '') === currentFolder
			);
		} else {
			// vault
			filesToSearch = this.app.vault.getMarkdownFiles();
		}

		const escapedOld = escapeRegex(oldName);
		const escapedOldEncoded = escapeRegex(oldName.replace(/ /g, '%20'));

		const wikiLinkRegex = new RegExp(`(\\[\\[[^\\]]*?#)${escapedOld}((?:\\]\\])|(?:\\|([^\\]]*)\\]\\]))`, 'g');
		const mdLinkRegex = new RegExp(`\\[([^\\]]*)\\]\\(([^)]*?#)${escapedOldEncoded}\\)`, 'g');
		const htmlLinkRegex = new RegExp(`(<a[^>]*?href=["'][^"']*?#)${escapedOldEncoded}(["'][^>]*>)([^<]*)(</a>)`, 'g');

		const newSuggestions: HeadingReference[] = [];

		for (const f of filesToSearch) {
			try {
				const content = await this.app.vault.cachedRead(f);
				const lines = content.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/);

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const matchData: {start: number, end: number}[] = [];
					let match;
					
					wikiLinkRegex.lastIndex = 0;
					while ((match = wikiLinkRegex.exec(line)) !== null) {
						matchData.push({ start: match.index, end: match.index + match[0].length });
					}
					
					mdLinkRegex.lastIndex = 0;
					while ((match = mdLinkRegex.exec(line)) !== null) {
						matchData.push({ start: match.index, end: match.index + match[0].length });
					}
					
					htmlLinkRegex.lastIndex = 0;
					while ((match = htmlLinkRegex.exec(line)) !== null) {
						matchData.push({ start: match.index, end: match.index + match[0].length });
					}

					for (const m of matchData) {
						const linesBefore = [];
						if (i > 0) linesBefore.push(lines[i - 1]);
						
						const linesAfter = [];
						for (let offset = 1; offset <= 3; offset++) {
							if (i + offset < lines.length) {
								linesAfter.push(lines[i + offset]);
							}
						}

						newSuggestions.push({
							file: f,
							lineNum: i,
							lineText: line,
							linesBefore,
							linesAfter,
							matchStartIndex: m.start,
							matchEndIndex: m.end
						});
					}
				}
			} catch (err) {
				console.error(`Heading search: failed to read ${f.path}`, err);
			}
		}

		this.suggestions = newSuggestions;

		if (this.suggestions.length === 0) {
			new Notice(`No references found for "${oldName}".`);
		}
	}

	getSuggestions(query: string): HeadingReference[] {
		const lowerQuery = query.toLowerCase();
		return this.suggestions.filter(ref =>
			ref.file.path.toLowerCase().includes(lowerQuery) ||
			ref.lineText.toLowerCase().includes(lowerQuery)
		);
	}

	renderSuggestion(ref: HeadingReference, el: HTMLElement) {
		el.createEl('div', { text: ref.file.path, attr: { style: 'font-weight: 600; margin-bottom: 4px; color: var(--text-accent);' } });
		
		const contextEl = el.createEl('div', { attr: { style: 'font-size: 0.85em; line-height: 1.4;' } });
		
		for (const line of ref.linesBefore) {
			contextEl.createEl('div', { text: line, attr: { style: 'color: var(--text-muted); opacity: 0.7; white-space: pre-wrap;' } });
		}
		
		const lineEl = contextEl.createEl('div', { attr: { style: 'color: var(--text-normal); white-space: pre-wrap;' } });
		
		const beforeMatch = ref.lineText.substring(0, ref.matchStartIndex);
		const theMatch = ref.lineText.substring(ref.matchStartIndex, ref.matchEndIndex);
		const afterMatch = ref.lineText.substring(ref.matchEndIndex);
		
		if (beforeMatch.length > 0) {
			lineEl.appendChild(document.createTextNode(beforeMatch));
		}
		lineEl.createEl('mark', { text: theMatch, attr: { style: 'color: var(--text-normal); background-color: var(--text-selection); border-radius: 2px;' } });
		if (afterMatch.length > 0) {
			lineEl.appendChild(document.createTextNode(afterMatch));
		}
		
		for (const line of ref.linesAfter) {
			contextEl.createEl('div', { text: line, attr: { style: 'color: var(--text-muted); opacity: 0.7; white-space: pre-wrap;' } });
		}
	}

	onChooseSuggestion(ref: HeadingReference, evt: MouseEvent | KeyboardEvent) {
		const leaf = this.app.workspace.getLeaf(false);
		leaf.openFile(ref.file, { eState: { line: ref.lineNum } });
	}
}

class HeadingLinkSettingTab extends PluginSettingTab {
	plugin: HeadingLinkCopierPlugin;

	constructor(app: App, plugin: HeadingLinkCopierPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Heading Link Copier Settings' });

		new Setting(containerEl)
			.setName('File Path Format')
			.setDesc('Choose whether to include the relative path or the full vault path.')
			.addDropdown(drop => drop
				.addOption('relative', 'Relative (./filename.md)')
				.addOption('full', 'Full (folder/filename.md)')
				.setValue(this.plugin.settings.pathFormat)
				.onChange(async (value: string) => {
					this.plugin.settings.pathFormat = value as 'relative' | 'full';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Rename Scope')
			.setDesc('When renaming a heading, search and update links in:')
			.addDropdown(drop => drop
				.addOption('vault', 'Entire vault')
				.addOption('folder', 'Current folder only')
				.addOption('file', 'Current file only')
				.setValue(this.plugin.settings.renameScope)
				.onChange(async (value: string) => {
					this.plugin.settings.renameScope = value as 'vault' | 'folder' | 'file';
					await this.plugin.saveSettings();
				}));
	}
}
