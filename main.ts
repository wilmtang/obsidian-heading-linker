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
	headingFormat: 'full-path' | 'target-only';
}

const DEFAULT_SETTINGS: HeadingLinkSettings = {
	pathFormat: 'relative',
	headingFormat: 'full-path'
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
							.onClick(() => this.copyHeadingLink(file, targetHeading, cache));
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

	async copyHeadingLink(file: TFile, targetHeading: HeadingCache, cache: CachedMetadata) {
		// 1. Determine File Path String
		let pathStr = "";
		if (this.settings.pathFormat === 'full') {
			pathStr = file.path; // e.g., "folder/subfolder/file.md"
		} else {
			pathStr = `./${file.name}`; // e.g., "./file.md"
		}

		// 2. Determine Heading Path String
		let headingStr = "";
		if (this.settings.headingFormat === 'full-path') {
			const parents = this.getHeadingParents(targetHeading, cache.headings || []);
			const parentNames = parents.map(h => h.heading);
			parentNames.push(targetHeading.heading);
			headingStr = parentNames.join('/');
		} else {
			headingStr = targetHeading.heading;
		}

		// Encode spaces and special characters for standard Markdown links
		const encodedPath = encodeURI(pathStr);
		// Obsidian links often use spaces, but strictly speaking, standard URIs need encoding
		const encodedHeading = headingStr.replace(/ /g, '%20');

		// 3. Assemble Final Markdown Link
		const linkText = targetHeading.heading;
		const markdownLink = `[${linkText}](${encodedPath}#${encodedHeading})`;

		// 4. Write to Clipboard
		await navigator.clipboard.writeText(markdownLink);
		new Notice('Heading link copied to clipboard!');
	}

	// Helper to traverse backwards and find parent headings based on heading levels
	getHeadingParents(target: HeadingCache, allHeadings: HeadingCache[]): HeadingCache[] {
		const parents: HeadingCache[] = [];
		let currentLevel = target.level;
		const targetIndex = allHeadings.indexOf(target);

		for (let i = targetIndex - 1; i >= 0; i--) {
			const h = allHeadings[i];
			if (h.level < currentLevel) {
				parents.unshift(h);
				currentLevel = h.level;
			}
			if (currentLevel === 1) break;
		}
		return parents;
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

		new Setting(containerEl)
			.setName('Heading Format')
			.setDesc('Choose whether to include parent headings in the anchor link.')
			.addDropdown(drop => drop
				.addOption('full-path', 'Full Path (Parent/Child/Target)')
				.addOption('target-only', 'Target Only (Target)')
				.setValue(this.plugin.settings.headingFormat)
				.onChange(async (value: 'full-path' | 'target-only') => {
					this.plugin.settings.headingFormat = value;
					await this.plugin.saveSettings();
				}));
	}
}
