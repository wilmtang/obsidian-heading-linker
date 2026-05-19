import {
	App,
	Editor,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	HeadingCache,
	CachedMetadata
} from 'obsidian';

interface HeadingLinkSettings {
	pathFormat: 'relative' | 'full';
}

const DEFAULT_SETTINGS: HeadingLinkSettings = {
	pathFormat: 'relative'
}

export default class HeadingLinkCopierPlugin extends Plugin {
	settings: HeadingLinkSettings;

	async onload() {
		await this.loadSettings();

		// Adds the settings tab
		this.addSettingTab(new HeadingLinkSettingTab(this.app, this));

		// Registers the right-click menu event in the Markdown Editor
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
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
				.onChange(async (value: 'relative' | 'full') => {
					this.plugin.settings.pathFormat = value;
					await this.plugin.saveSettings();
				}));
	}
}
