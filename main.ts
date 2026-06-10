import {
	App,
	ButtonComponent,
	CachedMetadata,
	Editor,
	HeadingCache,
	MarkdownFileInfo,
	MarkdownView,
	Menu,
	Modal,
	normalizePath,
	Notice,
	parseLinktext,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TFile
} from 'obsidian';

type DuplicateHeadingTargetFormat = 'obsidian-block' | 'html-anchor';
type ConversionDirection = 'html-to-block' | 'block-to-html';
type TargetMarkerFormat = DuplicateHeadingTargetFormat;
type MigrationChangeKind = 'heading' | 'wikilink' | 'markdown-link' | 'html-link' | 'skipped';

interface HeadingLinkSettings {
	pathFormat: 'relative' | 'full';
	renameScope: 'vault' | 'folder' | 'file';
	duplicateHeadingTargetFormat: DuplicateHeadingTargetFormat;
}

const DEFAULT_SETTINGS: HeadingLinkSettings = {
	pathFormat: 'relative',
	renameScope: 'vault',
	duplicateHeadingTargetFormat: 'obsidian-block'
}

interface HeadingTargetMarker {
	format: TargetMarkerFormat;
	id: string;
}

interface ParsedHeadingLine {
	prefix: string;
	visibleText: string;
	target?: HeadingTargetMarker;
}

interface LinkRewriteResult {
	target: string;
	id: string;
}

interface DestinationRewriteResult {
	destination: string;
	id: string;
	skippedReason?: string;
}

interface MigrationLineChange {
	file: TFile;
	lineNum: number;
	beforeLine: string;
	afterLine?: string;
	kinds: MigrationChangeKind[];
	ids: string[];
	reason?: string;
}

interface MigrationPlan {
	direction: ConversionDirection;
	changes: MigrationLineChange[];
	headingChanges: number;
	linkChanges: number;
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
				if (!cache) return;

				const targetHeading = this.getTargetHeading(view, editor);

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
								new FindReferencesModal(this.app, this, file, targetHeading, editor).open();
							});
					});
				}
			})
		);

		// Register Commands (Unset shortcuts by default)
		this.addCommand({
			id: 'copy-markdown-link',
			name: 'Copy Markdown Link',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				const targetHeading = this.getTargetHeading(view, editor);
				if (targetHeading) {
					if (!checking && view.file) {
						void this.copyHeadingLink(view.file, targetHeading, this.app.metadataCache.getFileCache(view.file)!, editor);
					}
					return true;
				}
				return false;
			}
		});

		this.addCommand({
			id: 'rename-heading',
			name: 'Rename this Heading',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				const targetHeading = this.getTargetHeading(view, editor);
				if (targetHeading) {
					if (!checking && view.file) {
						new RenameHeadingModal(this.app, this, view.file, targetHeading, editor).open();
					}
					return true;
				}
				return false;
			}
		});

		this.addCommand({
			id: 'find-heading-references',
			name: 'Find Heading References',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				const targetHeading = this.getTargetHeading(view, editor);
				if (targetHeading) {
					if (!checking && view.file) {
						new FindReferencesModal(this.app, this, view.file, targetHeading, editor).open();
					}
					return true;
				}
				return false;
			}
		});

		this.addCommand({
			id: 'convert-heading-link-target-format',
			name: 'Convert Heading Link Target Format...',
			callback: () => {
				new ConvertHeadingTargetFormatModal(this.app, this).open();
			}
		});
	}

	getTargetHeading(view: MarkdownView | MarkdownFileInfo, editor: Editor): HeadingCache | null {
		const file = view.file;
		if (!file) return null;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache || !cache.headings) return null;

		const cursor = editor.getCursor();
		return cache.headings.find(h =>
			cursor.line >= h.position.start.line &&
			cursor.line <= h.position.end.line
		) || null;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<HeadingLinkSettings> | null);
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

		const encodedPath = pathStr.split('/').map(p => encodeURIComponent(p)).join('/');

		const lineNum = targetHeading.position.start.line;
		const lineContent = editor.getLine(lineNum);
		const visibleHeading = getHeadingVisibleText(lineContent, targetHeading.heading);

		// 2. Check for uniqueness and determine fragment
		const matchingHeadingCount = cache.headings
			? cache.headings.filter(h => getHeadingVisibleText(editor.getLine(h.position.start.line), h.heading) === visibleHeading).length
			: 1;
		const isUnique = matchingHeadingCount === 1;

		let fragment = "";
		if (isUnique) {
			fragment = encodeURIComponent(visibleHeading);
		} else {
			const ensured = ensureHeadingTargetFormat(lineContent, visibleHeading, this.settings.duplicateHeadingTargetFormat);

			if (ensured.line !== lineContent) {
				editor.setLine(lineNum, ensured.line);
			}

			fragment = formatFragmentForTarget(this.settings.duplicateHeadingTargetFormat, ensured.id);
		}

		// 3. Assemble Final Markdown Link
		const linkText = visibleHeading;
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

function uniqueValues(values: string[]): string[] {
	return [...new Set(values)];
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function getSafeIdBase(value: string): string {
	const safe = value
		.replace(/[^a-zA-Z0-9]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.toLowerCase();
	return safe || 'heading';
}

function generateSafeId(heading: string): string {
	return `${getSafeIdBase(heading)}-${Math.random().toString(36).substring(2, 8)}`;
}

function isSafeTargetId(id: string): boolean {
	return /^[A-Za-z0-9-]+$/.test(id);
}

function parseHeadingLine(line: string): ParsedHeadingLine | null {
	const headingMatch = line.match(/^(#{1,6}\s+)(.*)$/);
	if (!headingMatch) return null;

	let content = headingMatch[2].trimEnd();
	let target: HeadingTargetMarker | undefined;

	const blockMatch = content.match(/^(.*?)(?:\s+\^([A-Za-z0-9-]+))$/);
	if (blockMatch) {
		content = blockMatch[1].trimEnd();
		target = { format: 'obsidian-block', id: blockMatch[2] };
	}

	const anchorMatch = content.match(/^(.*?)(?:\s*<a\s+[^>]*\bid=(["'])([A-Za-z0-9-]+)\2[^>]*>\s*<\/a>)$/i);
	if (anchorMatch) {
		content = anchorMatch[1].trimEnd();
		if (!target) {
			target = { format: 'html-anchor', id: anchorMatch[3] };
		}
	}

	return {
		prefix: headingMatch[1],
		visibleText: content,
		target
	};
}

function getHeadingVisibleText(line: string, fallback: string): string {
	return parseHeadingLine(line)?.visibleText || fallback;
}

function formatTargetMarker(format: TargetMarkerFormat, id: string): string {
	return format === 'obsidian-block' ? `^${id}` : `<a id="${id}"></a>`;
}

function formatFragmentForTarget(format: TargetMarkerFormat, id: string): string {
	return format === 'obsidian-block' ? `^${id}` : id;
}

function buildHeadingLine(prefix: string, visibleText: string, format?: TargetMarkerFormat, id?: string): string {
	const marker = format && id ? ` ${formatTargetMarker(format, id)}` : '';
	return `${prefix}${visibleText}${marker}`;
}

function ensureHeadingTargetFormat(line: string, fallbackHeading: string, targetFormat: TargetMarkerFormat): { line: string; id: string } {
	const parsed = parseHeadingLine(line);
	const prefix = parsed?.prefix ?? '';
	const visibleText = parsed?.visibleText || fallbackHeading;
	const id = parsed?.target?.id ?? generateSafeId(visibleText);
	const linePrefix = prefix || line.match(/^(#{1,6}\s+)/)?.[1] || '';

	return {
		line: buildHeadingLine(linePrefix, visibleText, targetFormat, id),
		id
	};
}

function updateHeadingLineText(line: string, newName: string, targetFormat: TargetMarkerFormat): string | null {
	const parsed = parseHeadingLine(line);
	if (!parsed) return null;

	return buildHeadingLine(parsed.prefix, newName, parsed.target ? targetFormat : undefined, parsed.target?.id);
}

function getHeadingTargetIds(line: string): string[] {
	const parsed = parseHeadingLine(line);
	return parsed?.target?.id ? [parsed.target.id] : [];
}

function getFilesInScope(app: App, file: TFile, scope: HeadingLinkSettings['renameScope']): TFile[] {
	if (scope === 'file') {
		return [file];
	}

	if (scope === 'folder') {
		const currentFolder = file.parent?.path ?? '';
		return app.vault.getMarkdownFiles().filter(f =>
			(f.parent?.path ?? '') === currentFolder
		);
	}

	return app.vault.getMarkdownFiles();
}

function getCurrentHeadingContext(line: string, currentHeading: string | null): string | null {
	const parsed = parseHeadingLine(line);
	return parsed ? parsed.visibleText : currentHeading;
}

function getEncodedHeadingVariants(heading: string): string[] {
	return uniqueValues([
		heading,
		encodeURIComponent(heading),
		heading.replace(/ /g, '%20')
	]);
}

function replaceHeadingTextReferences(data: string, oldName: string, newName: string): { data: string; count: number } {
	let newData = data;
	let count = 0;
	const escapedNewEncoded = encodeURIComponent(newName);

	const wikiLinkRegex = new RegExp(
		`(\\[\\[[^\\]]*?#)${escapeRegex(oldName)}((?:\\]\\])|(?:\\|([^\\]]*)\\]\\]))`,
		'g'
	);

	newData = newData.replace(wikiLinkRegex, (match, before: string, after: string, alias: string | undefined) => {
		count++;
		if (alias === oldName) {
			return `${before}${newName}|${newName}]]`;
		}
		return `${before}${newName}${after}`;
	});

	for (const oldEncoded of getEncodedHeadingVariants(oldName)) {
		const mdLinkRegex = new RegExp(
			`\\[([^\\]]*)\\]\\(([^)]*?#)${escapeRegex(oldEncoded)}\\)`,
			'g'
		);
		const htmlLinkRegex = new RegExp(
			`(<a[^>]*?href=["'][^"']*?#)${escapeRegex(oldEncoded)}(["'][^>]*>)([^<]*)(</a>)`,
			'g'
		);

		newData = newData.replace(mdLinkRegex, (match, alias: string, pathAndHash: string) => {
			count++;
			if (alias === oldName) {
				return `[${newName}](${pathAndHash}${escapedNewEncoded})`;
			}
			return `[${alias}](${pathAndHash}${escapedNewEncoded})`;
		});

		newData = newData.replace(htmlLinkRegex, (match, beforeHref: string, afterHref: string, alias: string, endTag: string) => {
			count++;
			if (alias === oldName) {
				return `${beforeHref}${escapedNewEncoded}${afterHref}${newName}${endTag}`;
			}
			return `${beforeHref}${escapedNewEncoded}${afterHref}${alias}${endTag}`;
		});
	}

	return { data: newData, count };
}

function replaceStableIdLinkAliases(data: string, targetIds: string[], oldName: string, newName: string): { data: string; count: number } {
	let newData = data;
	let count = 0;

	for (const id of targetIds) {
		for (const fragment of [`#${id}`, `#^${id}`]) {
			const escapedFragment = escapeRegex(fragment);
			const wikiAliasRegex = new RegExp(`(\\[\\[[^\\]]*?${escapedFragment}\\|)${escapeRegex(oldName)}(\\]\\])`, 'g');
			const mdAliasRegex = new RegExp(`\\[${escapeRegex(oldName)}\\](\\([^)]*?${escapedFragment}\\))`, 'g');
			const htmlAliasRegex = new RegExp(`(<a[^>]*?href=["'][^"']*?${escapedFragment}["'][^>]*>)${escapeRegex(oldName)}(</a>)`, 'g');

			newData = newData.replace(wikiAliasRegex, (match, before: string, after: string) => {
				count++;
				return `${before}${newName}${after}`;
			});

			newData = newData.replace(mdAliasRegex, (match, destination: string) => {
				count++;
				return `[${newName}]${destination}`;
			});

			newData = newData.replace(htmlAliasRegex, (match, before: string, after: string) => {
				count++;
				return `${before}${newName}${after}`;
			});
		}
	}

	return { data: newData, count };
}

function findRegexMatches(line: string, regex: RegExp): { start: number; end: number }[] {
	const matches: { start: number; end: number }[] = [];
	let match: RegExpExecArray | null;
	regex.lastIndex = 0;
	while ((match = regex.exec(line)) !== null) {
		matches.push({ start: match.index, end: match.index + match[0].length });
		if (match[0].length === 0) regex.lastIndex++;
	}
	return matches;
}

function getReferenceMatches(line: string, headingName: string, targetIds: string[]): { start: number; end: number }[] {
	const matches: { start: number; end: number }[] = [];

	const wikiHeadingRegex = new RegExp(
		`\\[\\[[^\\]]*?#${escapeRegex(headingName)}(?:(?:\\]\\])|(?:\\|[^\\]]*\\]\\]))`,
		'g'
	);
	matches.push(...findRegexMatches(line, wikiHeadingRegex));

	for (const encodedHeading of getEncodedHeadingVariants(headingName)) {
		const mdHeadingRegex = new RegExp(`\\[[^\\]]*\\]\\([^)]*?#${escapeRegex(encodedHeading)}\\)`, 'g');
		const htmlHeadingRegex = new RegExp(`<a[^>]*?href=["'][^"']*?#${escapeRegex(encodedHeading)}["'][^>]*>[^<]*</a>`, 'g');
		matches.push(...findRegexMatches(line, mdHeadingRegex));
		matches.push(...findRegexMatches(line, htmlHeadingRegex));
	}

	for (const id of targetIds) {
		for (const fragment of [`#${id}`, `#^${id}`]) {
			const escapedFragment = escapeRegex(fragment);
			const wikiIdRegex = new RegExp(`\\[\\[[^\\]]*?${escapedFragment}(?:(?:\\]\\])|(?:\\|[^\\]]*\\]\\]))`, 'g');
			const mdIdRegex = new RegExp(`\\[[^\\]]*\\]\\([^)]*?${escapedFragment}\\)`, 'g');
			const htmlIdRegex = new RegExp(`<a[^>]*?href=["'][^"']*?${escapedFragment}["'][^>]*>[^<]*</a>`, 'g');
			matches.push(...findRegexMatches(line, wikiIdRegex));
			matches.push(...findRegexMatches(line, mdIdRegex));
			matches.push(...findRegexMatches(line, htmlIdRegex));
		}
	}

	return matches.sort((a, b) => a.start - b.start);
}

function splitLines(content: string): string[] {
	return content.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/);
}

function isExternalDestination(destination: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination);
}

function stripDestinationWrapper(destination: string): { destination: string; wrapped: boolean } {
	if (destination.startsWith('<') && destination.endsWith('>')) {
		return { destination: destination.substring(1, destination.length - 1), wrapped: true };
	}
	return { destination, wrapped: false };
}

function restoreDestinationWrapper(destination: string, wrapped: boolean): string {
	return wrapped ? `<${destination}>` : destination;
}

function getSourceIdFromSubpath(subpath: string, direction: ConversionDirection): string | null {
	if (direction === 'html-to-block') {
		const match = subpath.match(/^#([A-Za-z0-9-]+)$/);
		return match ? match[1] : null;
	}

	const match = subpath.match(/^#\^([A-Za-z0-9-]+)$/);
	return match ? match[1] : null;
}

function getTargetSubpath(id: string, direction: ConversionDirection): string {
	return direction === 'html-to-block' ? `#^${id}` : `#${id}`;
}

function replaceSubpath(linktext: string, newSubpath: string): string {
	const hashIndex = linktext.indexOf('#');
	if (hashIndex === -1) {
		return `${linktext}${newSubpath}`;
	}
	return `${linktext.substring(0, hashIndex)}${newSubpath}`;
}

function resolveInternalFile(app: App, linkPath: string, sourceFile: TFile): TFile | null {
	if (!linkPath) return sourceFile;

	const decodedPath = safeDecodeURIComponent(linkPath);
	const sourceFolder = sourceFile.parent?.path ?? '';
	const candidates = uniqueValues([
		decodedPath,
		decodedPath.replace(/\.md$/i, ''),
		decodedPath.replace(/^\.\//, ''),
		decodedPath.replace(/^\.\//, '').replace(/\.md$/i, '')
	]);

	for (const candidate of candidates) {
		const metadataMatch = app.metadataCache.getFirstLinkpathDest(candidate, sourceFile.path);
		if (metadataMatch) return metadataMatch;

		const directPath = candidate.endsWith('.md') ? candidate : `${candidate}.md`;
		const directMatch = app.vault.getFileByPath(directPath);
		if (directMatch) return directMatch;

		if (candidate.startsWith('./') || candidate.startsWith('../')) {
			const resolvedPath = normalizePath(`${sourceFolder}/${candidate}`);
			const relativeMatch = app.vault.getFileByPath(resolvedPath.endsWith('.md') ? resolvedPath : `${resolvedPath}.md`);
			if (relativeMatch) return relativeMatch;
		}
	}

	return null;
}

function maybeRewriteLinktextTarget(
	app: App,
	linktext: string,
	sourceFile: TFile,
	idMapByFile: Map<string, Map<string, string>>,
	direction: ConversionDirection
): LinkRewriteResult | null {
	const parsed = parseLinktext(linktext);
	const sourceId = getSourceIdFromSubpath(parsed.subpath, direction);
	if (!sourceId) return null;

	const destinationFile = resolveInternalFile(app, parsed.path, sourceFile);
	if (!destinationFile) return null;

	const targetId = idMapByFile.get(destinationFile.path)?.get(sourceId);
	if (!targetId) return null;

	return {
		target: replaceSubpath(linktext, getTargetSubpath(targetId, direction)),
		id: sourceId
	};
}

function maybeRewriteMarkdownDestination(
	app: App,
	rawDestination: string,
	sourceFile: TFile,
	idMapByFile: Map<string, Map<string, string>>,
	direction: ConversionDirection
): DestinationRewriteResult | null {
	const stripped = stripDestinationWrapper(rawDestination);
	const destination = stripped.destination;

	if (isExternalDestination(destination)) return null;

	const hashIndex = destination.indexOf('#');
	if (hashIndex === -1) return null;

	const path = destination.substring(0, hashIndex);
	const subpath = destination.substring(hashIndex);
	const sourceId = getSourceIdFromSubpath(subpath, direction);
	if (!sourceId) return null;

	const destinationFile = resolveInternalFile(app, path, sourceFile);
	if (!destinationFile) {
		return {
			destination: rawDestination,
			id: sourceId,
			skippedReason: 'Unresolved internal link target'
		};
	}

	const targetId = idMapByFile.get(destinationFile.path)?.get(sourceId);
	if (!targetId) return null;

	const rewritten = `${path}${getTargetSubpath(targetId, direction)}`;
	return {
		destination: restoreDestinationWrapper(rewritten, stripped.wrapped),
		id: sourceId
	};
}

function addMigrationKind(kinds: Set<MigrationChangeKind>, kind: MigrationChangeKind): void {
	kinds.add(kind);
}

function addMigrationId(ids: Set<string>, id: string): void {
	ids.add(id);
}

function buildLineMigrationChange(
	app: App,
	file: TFile,
	lineNum: number,
	line: string,
	idMapByFile: Map<string, Map<string, string>>,
	direction: ConversionDirection
): MigrationLineChange | null {
	const sourceFormat: TargetMarkerFormat = direction === 'html-to-block' ? 'html-anchor' : 'obsidian-block';
	const targetFormat: TargetMarkerFormat = direction === 'html-to-block' ? 'obsidian-block' : 'html-anchor';
	const kinds = new Set<MigrationChangeKind>();
	const ids = new Set<string>();
	let newLine = line;
	let reason: string | undefined;

	const parsedHeading = parseHeadingLine(newLine);
	if (parsedHeading?.target?.format === sourceFormat) {
		const targetId = idMapByFile.get(file.path)?.get(parsedHeading.target.id);
		if (targetId) {
			newLine = buildHeadingLine(parsedHeading.prefix, parsedHeading.visibleText, targetFormat, targetId);
			addMigrationKind(kinds, 'heading');
			addMigrationId(ids, parsedHeading.target.id);
		}
	}

	newLine = newLine.replace(/\[\[([^\]]+)\]\]/g, (match, body: string) => {
		const pipeIndex = body.indexOf('|');
		const target = pipeIndex === -1 ? body : body.substring(0, pipeIndex);
		const alias = pipeIndex === -1 ? '' : body.substring(pipeIndex);
		const rewrite = maybeRewriteLinktextTarget(app, target, file, idMapByFile, direction);

		if (!rewrite) return match;

		addMigrationKind(kinds, 'wikilink');
		addMigrationId(ids, rewrite.id);
		return `[[${rewrite.target}${alias}]]`;
	});

	newLine = newLine.replace(/(\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s\n]+)(\))/g, (match, before: string, destination: string, after: string) => {
		const rewrite = maybeRewriteMarkdownDestination(app, destination, file, idMapByFile, direction);

		if (!rewrite) return match;
		if (rewrite.skippedReason) {
			addMigrationKind(kinds, 'skipped');
			addMigrationId(ids, rewrite.id);
			reason = rewrite.skippedReason;
			return match;
		}

		addMigrationKind(kinds, 'markdown-link');
		addMigrationId(ids, rewrite.id);
		return `${before}${rewrite.destination}${after}`;
	});

	newLine = newLine.replace(/(<a\b[^>]*?\bhref=(["']))([^"']+)(\2[^>]*>)/gi, (match, before: string, _quote: string, destination: string, after: string) => {
		const rewrite = maybeRewriteMarkdownDestination(app, destination, file, idMapByFile, direction);

		if (!rewrite) return match;
		if (rewrite.skippedReason) {
			addMigrationKind(kinds, 'skipped');
			addMigrationId(ids, rewrite.id);
			reason = rewrite.skippedReason;
			return match;
		}

		addMigrationKind(kinds, 'html-link');
		addMigrationId(ids, rewrite.id);
		return `${before}${rewrite.destination}${after}`;
	});

	if (kinds.size === 0) return null;

	const kindValues = [...kinds];
	const idValues = [...ids];

	if (newLine === line && kindValues.includes('skipped')) {
		return {
			file,
			lineNum,
			beforeLine: line,
			kinds: kindValues,
			ids: idValues,
			reason
		};
	}

	return {
		file,
		lineNum,
		beforeLine: line,
		afterLine: newLine,
		kinds: kindValues.filter(kind => kind !== 'skipped'),
		ids: idValues
	};
}

async function buildMigrationPlan(app: App, direction: ConversionDirection): Promise<MigrationPlan> {
	const files = app.vault.getMarkdownFiles();
	const linesByFile = new Map<string, string[]>();
	const idMapByFile = new Map<string, Map<string, string>>();
	const sourceFormat: TargetMarkerFormat = direction === 'html-to-block' ? 'html-anchor' : 'obsidian-block';

	for (const file of files) {
		const content = await app.vault.cachedRead(file);
		const lines = splitLines(content);
		linesByFile.set(file.path, lines);

		for (const line of lines) {
			const parsed = parseHeadingLine(line);
			if (!parsed?.target || parsed.target.format !== sourceFormat || !isSafeTargetId(parsed.target.id)) continue;

			let fileMap = idMapByFile.get(file.path);
			if (!fileMap) {
				fileMap = new Map<string, string>();
				idMapByFile.set(file.path, fileMap);
			}
			fileMap.set(parsed.target.id, parsed.target.id);
		}
	}

	const changes: MigrationLineChange[] = [];
	let headingChanges = 0;
	let linkChanges = 0;
	for (const file of files) {
		const lines = linesByFile.get(file.path) ?? [];
		for (let i = 0; i < lines.length; i++) {
			const change = buildLineMigrationChange(app, file, i, lines[i], idMapByFile, direction);
			if (!change) continue;

			if (change.kinds.includes('heading')) headingChanges++;
			if (change.kinds.some(kind => kind === 'wikilink' || kind === 'markdown-link' || kind === 'html-link')) linkChanges++;
			changes.push(change);
		}
	}

	return {
		direction,
		changes,
		headingChanges,
		linkChanges
	};
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
		this.newName = getHeadingVisibleText(editor.getLine(heading.position.start.line), heading.heading);
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle('Rename heading');

		new Setting(contentEl)
			.setName('New heading name')
			.addText((text) => {
				text.setValue(this.newName);
				text.onChange((value) => { this.newName = value; });
				text.inputEl.select();
				text.inputEl.setCssStyles({ width: '100%' });
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); void this.doRename(); }
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
		const lineNum = this.heading.position.start.line;
		const lineContent = this.editor.getLine(lineNum);
		const oldName = getHeadingVisibleText(lineContent, this.heading.heading);
		const targetIds = getHeadingTargetIds(lineContent);

		// Validate
		if (!newName) {
			new Notice('Heading name cannot be empty.');
			return;
		}
		if (newName === oldName) {
			this.close();
			return;
		}

		const newLine = updateHeadingLineText(lineContent, newName, this.plugin.settings.duplicateHeadingTargetFormat);
		if (!newLine) {
			new Notice('Could not parse heading line.');
			return;
		}
		this.editor.setLine(lineNum, newLine);

		const filesToSearch = getFilesInScope(this.app, this.file, this.plugin.settings.renameScope);

		// Search and replace in each file
		let totalLinks = 0;
		let totalFiles = 0;
		const affectedFiles: string[] = [];

		for (const f of filesToSearch) {
			try {
				let fileLinksUpdated = 0;

				const updateData = (data: string): string => {
					let result = replaceHeadingTextReferences(data, oldName, newName);
					fileLinksUpdated += result.count;

					if (targetIds.length > 0) {
						result = replaceStableIdLinkAliases(result.data, targetIds, oldName, newName);
						fileLinksUpdated += result.count;
					}

					return result.data;
				};

				if (f === this.file) {
					const updatedEditorContent = updateData(this.editor.getValue());
					if (fileLinksUpdated > 0) {
						this.editor.setValue(updatedEditorContent);
					}
				} else {
					await this.app.vault.process(f, updateData);
				}

				if (fileLinksUpdated > 0) {
					totalLinks += fileLinksUpdated;
					totalFiles++;
					affectedFiles.push(`${f.path} (${fileLinksUpdated} link${fileLinksUpdated > 1 ? 's' : ''})`);
				}
			} catch (err) {
				console.error(`Heading rename: failed to process ${f.path}`, err);
			}
		}

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
	contextHeading: string | null;
}

class FindReferencesModal extends SuggestModal<HeadingReference> {
	plugin: HeadingLinkCopierPlugin;
	file: TFile;
	heading: HeadingCache;
	editor: Editor;
	suggestions: HeadingReference[] = [];

	constructor(app: App, plugin: HeadingLinkCopierPlugin, file: TFile, heading: HeadingCache, editor: Editor) {
		super(app);
		this.plugin = plugin;
		this.file = file;
		this.heading = heading;
		this.editor = editor;
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to open file' },
			{ command: 'shift + ↵', purpose: 'to rename heading' },
			{ command: 'esc', purpose: 'to dismiss' }
		]);

		this.scope.register(['Shift'], 'Enter', (evt: KeyboardEvent) => {
			evt.preventDefault();
			this.close();
			new RenameHeadingModal(this.app, this.plugin, this.file, this.heading, this.editor).open();
			return false;
		});
	}

	open() {
		void this.findReferences()
			.then(() => {
				if (this.suggestions.length > 0) {
					const scope = this.plugin.settings.renameScope;
					this.setPlaceholder(`Found ${this.suggestions.length} reference(s) in ${scope} scope. Type to filter...`);
					super.open();
				}
			})
			.catch((err) => {
				console.error('Heading references: failed to search references', err);
				new Notice('Failed to find heading references.');
			});
	}

	async findReferences() {
		const headingLine = this.editor.getLine(this.heading.position.start.line);
		const oldName = getHeadingVisibleText(headingLine, this.heading.heading);
		const targetIds = getHeadingTargetIds(headingLine);
		const filesToSearch = getFilesInScope(this.app, this.file, this.plugin.settings.renameScope);

		const newSuggestions: HeadingReference[] = [];

		for (const f of filesToSearch) {
			try {
				const content = await this.app.vault.cachedRead(f);
				const lines = splitLines(content);

				let currentHeading: string | null = null;

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					currentHeading = getCurrentHeadingContext(line, currentHeading);

					const matchData = getReferenceMatches(line, oldName, targetIds);

					for (const m of matchData) {
						const linesBefore = [];
						if (i > 0) linesBefore.push(lines[i - 1]);

						const linesAfter = [];
						if (i + 1 < lines.length) {
							linesAfter.push(lines[i + 1]);
						}

						newSuggestions.push({
							file: f,
							lineNum: i,
							lineText: line,
							linesBefore,
							linesAfter,
							matchStartIndex: m.start,
							matchEndIndex: m.end,
							contextHeading: currentHeading
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
		const titleEl = el.createEl('div', { attr: { style: 'margin-bottom: 4px;' } });
		titleEl.createEl('span', { text: ref.file.basename, attr: { style: 'font-weight: 600; color: var(--text-accent);' } });
		if (ref.contextHeading) {
			titleEl.createEl('span', { text: ' - ', attr: { style: 'color: var(--text-muted); margin: 0 4px;' } });
			titleEl.createEl('span', { text: ref.contextHeading, attr: { style: 'font-style: italic; color: var(--text-normal); background-color: var(--background-secondary); padding: 0 4px; border-radius: 4px; font-size: 0.9em;' } });
		}

		const contextEl = el.createEl('div', { attr: { style: 'font-size: 0.85em; line-height: 1.4;' } });

		for (const line of ref.linesBefore) {
			contextEl.createEl('div', { text: line, attr: { style: 'color: var(--text-muted); opacity: 0.7; white-space: pre-wrap;' } });
		}

		const lineEl = contextEl.createEl('div', { attr: { style: 'color: var(--text-normal); white-space: pre-wrap;' } });

		const beforeMatch = ref.lineText.substring(0, ref.matchStartIndex);
		const theMatch = ref.lineText.substring(ref.matchStartIndex, ref.matchEndIndex);
		const afterMatch = ref.lineText.substring(ref.matchEndIndex);

		if (beforeMatch.length > 0) {
			lineEl.appendChild(activeDocument.createTextNode(beforeMatch));
		}
		lineEl.createEl('mark', { text: theMatch, attr: { style: 'color: var(--text-normal); background-color: var(--text-selection); border-radius: 2px;' } });
		if (afterMatch.length > 0) {
			lineEl.appendChild(activeDocument.createTextNode(afterMatch));
		}

		for (const line of ref.linesAfter) {
			contextEl.createEl('div', { text: line, attr: { style: 'color: var(--text-muted); opacity: 0.7; white-space: pre-wrap;' } });
		}
	}

	onChooseSuggestion(ref: HeadingReference, evt: MouseEvent | KeyboardEvent) {
		const leaf = this.app.workspace.getLeaf(false);
		void leaf.openFile(ref.file, { eState: { line: ref.lineNum } });
	}
}

class ConvertHeadingTargetFormatModal extends Modal {
	plugin: HeadingLinkCopierPlugin;
	direction: ConversionDirection;
	plan: MigrationPlan | null = null;
	summaryEl: HTMLElement | null = null;
	listEl: HTMLElement | null = null;
	filterInput: HTMLInputElement | null = null;
	applyButton: ButtonComponent | null = null;

	constructor(app: App, plugin: HeadingLinkCopierPlugin) {
		super(app);
		this.plugin = plugin;
		this.direction = plugin.settings.duplicateHeadingTargetFormat === 'obsidian-block' ? 'html-to-block' : 'block-to-html';
	}

	async onOpen() {
		const { contentEl } = this;
		this.setTitle('Convert heading link target format');

		new Setting(contentEl)
			.setName('Direction')
			.setDesc('Dry run a vault-wide conversion before applying changes.')
			.addDropdown(drop => drop
				.addOption('html-to-block', 'HTML anchors -> Obsidian block IDs')
				.addOption('block-to-html', 'Obsidian block IDs -> HTML anchors')
				.setValue(this.direction)
				.onChange(async (value: string) => {
					this.direction = value as ConversionDirection;
					await this.rescan();
				}));

		this.summaryEl = contentEl.createEl('div', {
			attr: {
				style: 'margin: 12px 0; color: var(--text-muted);'
			}
		});

		this.filterInput = contentEl.createEl('input', {
			attr: {
				type: 'search',
				placeholder: 'Filter planned changes...',
				style: 'width: 100%; box-sizing: border-box; margin-bottom: 8px;'
			}
		});
		this.filterInput.addEventListener('input', () => this.renderItems());

		this.listEl = contentEl.createEl('div', {
			attr: {
				style: 'max-height: 420px; overflow: auto; border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 6px;'
			}
		});

		new Setting(contentEl)
			.addButton((btn) => {
				this.applyButton = btn;
				btn.setButtonText('Apply changes')
					.setCta()
					.setDisabled(true)
					.onClick(() => this.applyChanges());
			})
			.addButton((btn) => btn
				.setButtonText('Close')
				.onClick(() => this.close()));

		await this.rescan();
	}

	async rescan() {
		if (this.summaryEl) {
			this.summaryEl.setText('Scanning vault...');
		}
		if (this.applyButton) {
			this.applyButton.setDisabled(true);
		}
		if (this.listEl) {
			this.listEl.empty();
		}

		this.plan = await buildMigrationPlan(this.app, this.direction);
		this.renderSummary();
		this.renderItems();

		if (this.applyButton) {
			this.applyButton.setDisabled(!this.plan.changes.some(change => change.afterLine !== undefined));
		}
	}

	renderSummary() {
		if (!this.summaryEl || !this.plan) return;

		const changedFiles = new Set(this.plan.changes.filter(change => change.afterLine !== undefined).map(change => change.file.path)).size;
		const skipped = this.plan.changes.filter(change => change.afterLine === undefined).length;
		const directionText = this.direction === 'html-to-block'
			? 'HTML anchors -> Obsidian block IDs'
			: 'Obsidian block IDs -> HTML anchors';

		this.summaryEl.setText(`${directionText}: ${this.plan.headingChanges} heading line(s), ${this.plan.linkChanges} link line(s), ${changedFiles} file(s), ${skipped} skipped item(s).`);
	}

	renderItems() {
		if (!this.listEl || !this.plan) return;

		const query = this.filterInput?.value.toLowerCase() ?? '';
		this.listEl.empty();

		const items = this.plan.changes.filter(change => {
			const haystack = [
				change.file.path,
				change.beforeLine,
				change.afterLine ?? '',
				change.kinds.join(' '),
				change.reason ?? '',
				change.ids.join(' ')
			].join('\n').toLowerCase();
			return haystack.includes(query);
		});

		if (items.length === 0) {
			this.listEl.createEl('div', {
				text: 'No matching planned changes.',
				attr: { style: 'color: var(--text-muted); padding: 8px;' }
			});
			return;
		}

		for (const change of items) {
			const itemEl = this.listEl.createEl('div', {
				attr: {
					style: 'padding: 8px; border-bottom: 1px solid var(--background-modifier-border);'
				}
			});

			itemEl.createEl('div', {
				text: `${change.file.path}:${change.lineNum + 1} - ${change.kinds.join(', ')}`,
				attr: { style: 'font-weight: 600; color: var(--text-accent); margin-bottom: 4px;' }
			});

			itemEl.createEl('div', {
				text: change.beforeLine,
				attr: { style: 'white-space: pre-wrap; color: var(--text-muted); font-size: 0.85em;' }
			});

			if (change.afterLine !== undefined) {
				itemEl.createEl('div', {
					text: change.afterLine,
					attr: { style: 'white-space: pre-wrap; color: var(--text-normal); font-size: 0.85em; margin-top: 2px;' }
				});
			} else {
				itemEl.createEl('div', {
					text: change.reason ?? 'Skipped',
					attr: { style: 'color: var(--text-warning); font-size: 0.85em; margin-top: 2px;' }
				});
			}
		}
	}

	async applyChanges() {
		if (!this.plan) return;

		const applicableChanges = this.plan.changes.filter((change): change is MigrationLineChange & { afterLine: string } => change.afterLine !== undefined);
		if (applicableChanges.length === 0) {
			new Notice('No migration changes to apply.');
			return;
		}

		if (this.applyButton) {
			this.applyButton.setDisabled(true);
		}

		const changesByFile = new Map<string, Array<MigrationLineChange & { afterLine: string }>>();
		for (const change of applicableChanges) {
			const existing = changesByFile.get(change.file.path) ?? [];
			existing.push(change);
			changesByFile.set(change.file.path, existing);
		}

		let changedFiles = 0;
		let changedLines = 0;
		let skippedStale = 0;

		for (const [filePath, changes] of changesByFile) {
			const file = changes[0].file;
			let fileChanged = false;

			await this.app.vault.process(file, (data) => {
				const lines = splitLines(data);

				for (const change of changes) {
					if (lines[change.lineNum] === change.beforeLine) {
						lines[change.lineNum] = change.afterLine;
						fileChanged = true;
						changedLines++;
					} else {
						skippedStale++;
					}
				}

				return fileChanged ? lines.join('\n') : data;
			});

			if (fileChanged) {
				changedFiles++;
			} else {
				console.warn(`Heading target migration: no current lines matched planned changes for ${filePath}`);
			}
		}

		new Notice(`Heading target migration complete. Changed ${changedLines} line(s) in ${changedFiles} file(s).${skippedStale ? ` Skipped ${skippedStale} stale line(s).` : ''}`, 8000);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
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

		new Setting(containerEl)
			.setName('Heading tools')
			.setHeading();

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
			.setName('Duplicate Heading Target Format')
			.setDesc('Choose how duplicate headings get stable targets.')
			.addDropdown(drop => drop
				.addOption('obsidian-block', 'Obsidian block ID (^id)')
				.addOption('html-anchor', 'HTML anchor (<a id="..."></a>)')
				.setValue(this.plugin.settings.duplicateHeadingTargetFormat)
				.onChange(async (value: string) => {
					this.plugin.settings.duplicateHeadingTargetFormat = value as DuplicateHeadingTargetFormat;
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
