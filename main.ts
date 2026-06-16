import {
	App,
	ButtonComponent,
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
	targets: HeadingTargetMarker[];
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

type ReferenceKind = 'wikilink' | 'markdown-link' | 'html-link';
type ReferenceTargetKind = 'heading' | 'stable-id';

interface ResolvedReferenceMatch {
	start: number;
	end: number;
	kind: ReferenceKind;
	targetKind: ReferenceTargetKind;
}

interface ReferenceRewrite {
	start: number;
	end: number;
	replacement: string;
}

interface ReferenceLineRewriteResult {
	line: string;
	count: number;
	matches: ResolvedReferenceMatch[];
}

interface TextLine {
	text: string;
	ending: string;
}

interface ReferenceTarget {
	file: TFile;
	oldName: string;
	newName: string;
	targetIds: string[];
}

interface HeadingRenameResult {
	totalLinks: number;
	totalFiles: number;
	affectedFiles: string[];
	failedFiles: string[];
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
							.onClick(() => void this.copyHeadingLink(file, targetHeading, editor));
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
						void this.copyHeadingLink(view.file, targetHeading, editor);
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

	async copyHeadingLink(file: TFile, targetHeading: HeadingCache, editor: Editor) {
		// 1. Determine File Path String
		let pathStr = "";
		if (this.settings.pathFormat === 'full') {
			pathStr = file.path; // e.g., "folder/subfolder/file.md"
		} else {
			pathStr = `./${file.name}`; // e.g., "./file.md"
		}

		const lineNum = targetHeading.position.start.line;
		const lineContent = editor.getLine(lineNum);
		const visibleHeading = getHeadingVisibleText(lineContent, targetHeading.heading);

		// 2. Check for uniqueness and determine fragment
		const matchingHeadingCount = countMatchingHeadingVisibleText(editor, visibleHeading);
		const isUnique = matchingHeadingCount === 1;

		let fragment = "";
		if (isUnique) {
			fragment = visibleHeading;
		} else {
			const ensured = ensureHeadingTargetFormat(lineContent, visibleHeading, this.settings.duplicateHeadingTargetFormat);

			if (ensured.line !== lineContent) {
				editor.setLine(lineNum, ensured.line);
			}

			fragment = formatFragmentForTarget(this.settings.duplicateHeadingTargetFormat, ensured.id);
		}

		// 3. Assemble Final Markdown Link
		const linkText = escapeMarkdownLinkText(visibleHeading);
		const destination = formatMarkdownLinkDestination(`${pathStr}#${fragment}`);
		const markdownLink = `[${linkText}](${destination})`;

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

function escapeMarkdownLinkDestinationContent(value: string): string {
	return value.replace(/>/g, '\\>');
}

function unescapeMarkdownLinkDestinationContent(value: string): string {
	return value.replace(/\\>/g, '>');
}

export function escapeMarkdownLinkText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/\[/g, '\\[')
		.replace(/\]/g, '\\]');
}

function formatMarkdownLinkDestination(destination: string): string {
	return `<${escapeMarkdownLinkDestinationContent(destination)}>`;
}

function encodeMarkdownLinkFragment(value: string): string {
	return encodeURIComponent(value).replace(/[()]/g, char =>
		`%${char.charCodeAt(0).toString(16).toUpperCase()}`
	);
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

export function parseHeadingLine(line: string): ParsedHeadingLine | null {
	const headingMatch = line.match(/^(#{1,6}\s+)(.*)$/);
	if (!headingMatch) return null;

	let content = headingMatch[2].trimEnd();
	const reversedTargets: HeadingTargetMarker[] = [];

	while (true) {
		const blockMatch = content.match(/^(.*?)(?:\s+\^([A-Za-z0-9-]+))$/);
		if (blockMatch) {
			content = blockMatch[1].trimEnd();
			reversedTargets.push({ format: 'obsidian-block', id: blockMatch[2] });
			continue;
		}

		const anchorMatch = content.match(/^(.*?)(?:\s*<a\s+[^>]*\bid=(["'])([A-Za-z0-9-]+)\2[^>]*>\s*<\/a>)$/i);
		if (anchorMatch) {
			content = anchorMatch[1].trimEnd();
			reversedTargets.push({ format: 'html-anchor', id: anchorMatch[3] });
			continue;
		}

		break;
	}

	const targets = reversedTargets.reverse();

	return {
		prefix: headingMatch[1],
		visibleText: content,
		target: targets[targets.length - 1],
		targets
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

function buildHeadingLineWithTargets(prefix: string, visibleText: string, targets: HeadingTargetMarker[]): string {
	const markers = targets.map(target => formatTargetMarker(target.format, target.id));
	return `${prefix}${visibleText}${markers.length > 0 ? ` ${markers.join(' ')}` : ''}`;
}

function ensureHeadingTargetFormat(line: string, fallbackHeading: string, targetFormat: TargetMarkerFormat): { line: string; id: string } {
	const parsed = parseHeadingLine(line);
	const prefix = parsed?.prefix ?? '';
	const visibleText = parsed?.visibleText || fallbackHeading;
	const existingTarget = parsed?.targets.find(target => target.format === targetFormat) ?? parsed?.target;
	const id = existingTarget?.id ?? generateSafeId(visibleText);
	const linePrefix = prefix || line.match(/^(#{1,6}\s+)/)?.[1] || '';

	return {
		line: buildHeadingLine(linePrefix, visibleText, targetFormat, id),
		id
	};
}

function updateHeadingLineText(line: string, newName: string, targetFormat: TargetMarkerFormat): string | null {
	const parsed = parseHeadingLine(line);
	if (!parsed) return null;

	if (parsed.targets.length > 0) {
		return buildHeadingLineWithTargets(parsed.prefix, newName, parsed.targets);
	}

	return buildHeadingLine(parsed.prefix, newName, parsed.target ? targetFormat : undefined, parsed.target?.id);
}

function getHeadingTargetIds(line: string): string[] {
	const parsed = parseHeadingLine(line);
	return parsed ? uniqueValues(parsed.targets.map(target => target.id)) : [];
}

export function countMatchingHeadingVisibleText(editor: Editor, visibleHeading: string): number {
	let count = 0;

	for (let i = 0; i < editor.lineCount(); i++) {
		const parsed = parseHeadingLine(editor.getLine(i));
		if (parsed?.visibleText === visibleHeading) {
			count++;
		}
	}

	return count;
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
		encodeMarkdownLinkFragment(heading),
		heading.replace(/ /g, '%20')
	]);
}

function isSameFile(a: TFile, b: TFile): boolean {
	return a.path === b.path;
}

function escapeHtmlText(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function splitLinesWithEndings(content: string): TextLine[] {
	const lines: TextLine[] = [];
	const endingRegex = /\r\n|[\n\v\f\r\x85\u2028\u2029]/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = endingRegex.exec(content)) !== null) {
		lines.push({
			text: content.substring(lastIndex, match.index),
			ending: match[0]
		});
		lastIndex = endingRegex.lastIndex;
	}

	if (lastIndex < content.length || content.length === 0) {
		lines.push({
			text: content.substring(lastIndex),
			ending: ''
		});
	}

	return lines;
}

function joinLinesWithEndings(lines: TextLine[]): string {
	return lines.map(line => `${line.text}${line.ending}`).join('');
}

function getReferenceTargetKind(subpath: string, headingName: string, targetIds: string[]): ReferenceTargetKind | null {
	if (!subpath.startsWith('#')) return null;

	const fragment = subpath.substring(1);
	const decodedFragment = safeDecodeURIComponent(fragment);
	const decodedTargetId = decodedFragment.startsWith('^') ? decodedFragment.substring(1) : decodedFragment;

	if (targetIds.includes(decodedTargetId)) {
		return 'stable-id';
	}

	if (getEncodedHeadingVariants(headingName).includes(fragment) || decodedFragment === headingName) {
		return 'heading';
	}

	return null;
}

function resolveReferenceTargetKind(
	app: App,
	sourceFile: TFile,
	targetFile: TFile,
	linkPath: string,
	subpath: string,
	headingName: string,
	targetIds: string[]
): ReferenceTargetKind | null {
	const targetKind = getReferenceTargetKind(subpath, headingName, targetIds);
	if (!targetKind) return null;

	const destinationFile = resolveInternalFile(app, linkPath, sourceFile);
	if (!destinationFile || !isSameFile(destinationFile, targetFile)) return null;

	return targetKind;
}

function getMarkdownDestinationParts(rawDestination: string): { path: string; subpath: string; wrapped: boolean } | null {
	const stripped = stripDestinationWrapper(rawDestination);
	if (isExternalDestination(stripped.destination)) return null;

	const hashIndex = stripped.destination.indexOf('#');
	if (hashIndex === -1) return null;

	return {
		path: stripped.destination.substring(0, hashIndex),
		subpath: stripped.destination.substring(hashIndex),
		wrapped: stripped.wrapped
	};
}

function rewriteMarkdownDestinationHeading(rawDestination: string, newName: string): string {
	const stripped = stripDestinationWrapper(rawDestination);
	const hashIndex = stripped.destination.indexOf('#');
	if (hashIndex === -1) return rawDestination;

	const path = stripped.destination.substring(0, hashIndex);
	const newFragment = stripped.wrapped
		? newName
		: encodeMarkdownLinkFragment(newName);

	return restoreDestinationWrapper(`${path}#${newFragment}`, stripped.wrapped);
}

function rewriteHtmlDestinationHeading(destination: string, newName: string): string {
	const hashIndex = destination.indexOf('#');
	if (hashIndex === -1) return destination;
	return `${destination.substring(0, hashIndex)}#${encodeMarkdownLinkFragment(newName)}`;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	return aStart < bEnd && bStart < aEnd;
}

function addResolvedReference(
	line: string,
	matches: ResolvedReferenceMatch[],
	rewrites: ReferenceRewrite[],
	match: ResolvedReferenceMatch,
	replacement?: string
): void {
	if (matches.some(existing => rangesOverlap(existing.start, existing.end, match.start, match.end))) {
		return;
	}

	matches.push(match);

	if (replacement !== undefined && replacement !== line.substring(match.start, match.end)) {
		rewrites.push({
			start: match.start,
			end: match.end,
			replacement
		});
	}
}

function collectReferenceLineChanges(
	app: App,
	line: string,
	sourceFile: TFile,
	target: ReferenceTarget
): { matches: ResolvedReferenceMatch[]; rewrites: ReferenceRewrite[] } {
	const matches: ResolvedReferenceMatch[] = [];
	const rewrites: ReferenceRewrite[] = [];

	line.replace(/\[\[([^\]\n]+)\]\]/g, (match: string, body: string, offset: number) => {
		const pipeIndex = body.indexOf('|');
		const linkTarget = pipeIndex === -1 ? body : body.substring(0, pipeIndex);
		const alias = pipeIndex === -1 ? undefined : body.substring(pipeIndex + 1);
		const parsed = parseLinktext(linkTarget);
		const targetKind = resolveReferenceTargetKind(app, sourceFile, target.file, parsed.path, parsed.subpath, target.oldName, target.targetIds);

		if (!targetKind) return match;

		const rewrittenTarget = targetKind === 'heading'
			? replaceSubpath(linkTarget, `#${target.newName}`)
			: linkTarget;
		const rewrittenAlias = alias === target.oldName ? target.newName : alias;
		const replacement = rewrittenAlias === undefined
			? `[[${rewrittenTarget}]]`
			: `[[${rewrittenTarget}|${rewrittenAlias}]]`;

		addResolvedReference(line, matches, rewrites, {
			start: offset,
			end: offset + match.length,
			kind: 'wikilink',
			targetKind
		}, replacement);

		return match;
	});

	line.replace(/\[([^\]\n]*)\]\((<(?:\\[^\n]|[^>\\\n])+>|[^)\s\n]+)\)/g, (match: string, label: string, destination: string, offset: number) => {
		const parts = getMarkdownDestinationParts(destination);
		if (!parts) return match;

		const targetKind = resolveReferenceTargetKind(app, sourceFile, target.file, parts.path, parts.subpath, target.oldName, target.targetIds);
		if (!targetKind) return match;

		const rewrittenLabel = label === target.oldName ? escapeMarkdownLinkText(target.newName) : label;
		const rewrittenDestination = targetKind === 'heading'
			? rewriteMarkdownDestinationHeading(destination, target.newName)
			: destination;
		const replacement = `[${rewrittenLabel}](${rewrittenDestination})`;

		addResolvedReference(line, matches, rewrites, {
			start: offset,
			end: offset + match.length,
			kind: 'markdown-link',
			targetKind
		}, replacement);

		return match;
	});

	line.replace(/<a\b([^>]*?)\bhref=(["'])([^"']+)\2([^>]*)>([^<]*)<\/a>/gi, (
		match: string,
		beforeHref: string,
		quote: string,
		destination: string,
		afterHref: string,
		label: string,
		offset: number
	) => {
		const parts = getMarkdownDestinationParts(destination);
		if (!parts) return match;

		const targetKind = resolveReferenceTargetKind(app, sourceFile, target.file, parts.path, parts.subpath, target.oldName, target.targetIds);
		if (!targetKind) return match;

		const rewrittenDestination = targetKind === 'heading'
			? rewriteHtmlDestinationHeading(destination, target.newName)
			: destination;
		const rewrittenLabel = label === target.oldName ? escapeHtmlText(target.newName) : label;
		const replacement = `<a${beforeHref}href=${quote}${rewrittenDestination}${quote}${afterHref}>${rewrittenLabel}</a>`;

		addResolvedReference(line, matches, rewrites, {
			start: offset,
			end: offset + match.length,
			kind: 'html-link',
			targetKind
		}, replacement);

		return match;
	});

	return {
		matches: matches.sort((a, b) => a.start - b.start),
		rewrites
	};
}

export function getReferenceMatches(
	app: App,
	line: string,
	sourceFile: TFile,
	targetFile: TFile,
	headingName: string,
	targetIds: string[]
): ResolvedReferenceMatch[] {
	return collectReferenceLineChanges(app, line, sourceFile, {
		file: targetFile,
		oldName: headingName,
		newName: headingName,
		targetIds
	}).matches;
}

export function rewriteReferenceLine(
	app: App,
	line: string,
	sourceFile: TFile,
	target: ReferenceTarget
): ReferenceLineRewriteResult {
	const { matches, rewrites } = collectReferenceLineChanges(app, line, sourceFile, target);

	let rewrittenLine = line;
	let count = 0;
	for (const rewrite of rewrites.sort((a, b) => b.start - a.start)) {
		rewrittenLine = `${rewrittenLine.substring(0, rewrite.start)}${rewrite.replacement}${rewrittenLine.substring(rewrite.end)}`;
		count++;
	}

	return {
		line: rewrittenLine,
		count,
		matches
	};
}

export function rewriteReferencesInContent(
	app: App,
	sourceFile: TFile,
	content: string,
	target: ReferenceTarget
): { data: string; count: number } {
	const lines = splitLinesWithEndings(content);
	let count = 0;

	for (const line of lines) {
		const result = rewriteReferenceLine(app, line.text, sourceFile, target);
		line.text = result.line;
		count += result.count;
	}

	return {
		data: count > 0 ? joinLinesWithEndings(lines) : content,
		count
	};
}

export function rewriteReferencesInEditor(
	app: App,
	editor: Editor,
	sourceFile: TFile,
	target: ReferenceTarget
): number {
	let count = 0;

	for (let i = 0; i < editor.lineCount(); i++) {
		const line = editor.getLine(i);
		const result = rewriteReferenceLine(app, line, sourceFile, target);
		if (result.line !== line) {
			editor.setLine(i, result.line);
		}
		count += result.count;
	}

	return count;
}

export async function renameHeadingReferences(
	app: App,
	editor: Editor,
	target: ReferenceTarget,
	filesToSearch: TFile[]
): Promise<HeadingRenameResult> {
	let totalLinks = 0;
	let totalFiles = 0;
	const affectedFiles: string[] = [];
	const failedFiles: string[] = [];

	for (const f of filesToSearch) {
		try {
			let fileLinksUpdated = 0;

			if (isSameFile(f, target.file)) {
				fileLinksUpdated = rewriteReferencesInEditor(app, editor, f, target);
			} else {
				await app.vault.process(f, (data) => {
					const result = rewriteReferencesInContent(app, f, data, target);
					fileLinksUpdated += result.count;
					return result.data;
				});
			}

			if (fileLinksUpdated > 0) {
				totalLinks += fileLinksUpdated;
				totalFiles++;
				affectedFiles.push(`${f.path} (${fileLinksUpdated} link${fileLinksUpdated > 1 ? 's' : ''})`);
			}
		} catch (err) {
			console.error(`Heading rename: failed to process ${f.path}`, err);
			failedFiles.push(f.path);
		}
	}

	return {
		totalLinks,
		totalFiles,
		affectedFiles,
		failedFiles
	};
}

function splitLines(content: string): string[] {
	return content.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/);
}

function isExternalDestination(destination: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination);
}

function stripDestinationWrapper(destination: string): { destination: string; wrapped: boolean } {
	if (destination.startsWith('<') && destination.endsWith('>')) {
		return { destination: unescapeMarkdownLinkDestinationContent(destination.substring(1, destination.length - 1)), wrapped: true };
	}
	return { destination, wrapped: false };
}

function restoreDestinationWrapper(destination: string, wrapped: boolean): string {
	return wrapped ? formatMarkdownLinkDestination(destination) : destination;
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

function uniqueTargetMarkers(targets: HeadingTargetMarker[]): HeadingTargetMarker[] {
	const seen = new Set<string>();
	return targets.filter(target => {
		const key = `${target.format}:${target.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function convertHeadingTargets(
	parsedHeading: ParsedHeadingLine,
	sourceFormat: TargetMarkerFormat,
	targetFormat: TargetMarkerFormat,
	idMap: Map<string, string> | undefined
): { line: string; ids: string[] } | null {
	if (!idMap) return null;

	const convertedIds: string[] = [];
	const convertedTargets = parsedHeading.targets.map(target => {
		if (target.format !== sourceFormat) return target;

		const targetId = idMap.get(target.id);
		if (!targetId) return target;

		convertedIds.push(target.id);
		return {
			format: targetFormat,
			id: targetId
		};
	});

	if (convertedIds.length === 0) return null;

	return {
		line: buildHeadingLineWithTargets(parsedHeading.prefix, parsedHeading.visibleText, uniqueTargetMarkers(convertedTargets)),
		ids: convertedIds
	};
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
	const headingConversion = parsedHeading
		? convertHeadingTargets(parsedHeading, sourceFormat, targetFormat, idMapByFile.get(file.path))
		: null;
	if (headingConversion) {
		newLine = headingConversion.line;
		addMigrationKind(kinds, 'heading');
		for (const id of headingConversion.ids) {
			addMigrationId(ids, id);
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

	newLine = newLine.replace(/(\[[^\]\n]*\]\()(<(?:\\[^\n]|[^>\\\n])+>|[^)\s\n]+)(\))/g, (match, before: string, destination: string, after: string) => {
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

export async function buildMigrationPlan(app: App, direction: ConversionDirection): Promise<MigrationPlan> {
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
			const sourceTargets = parsed?.targets.filter(target => target.format === sourceFormat && isSafeTargetId(target.id)) ?? [];
			if (sourceTargets.length === 0) continue;

			let fileMap = idMapByFile.get(file.path);
			if (!fileMap) {
				fileMap = new Map<string, string>();
				idMapByFile.set(file.path, fileMap);
			}
			for (const target of sourceTargets) {
				fileMap.set(target.id, target.id);
			}
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
				.onClick(() => void this.doRename()))
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

		const filesToSearch = getFilesInScope(this.app, this.file, this.plugin.settings.renameScope);

		const target: ReferenceTarget = {
			file: this.file,
			oldName,
			newName,
			targetIds
		};

		this.editor.setLine(lineNum, newLine);
		const {
			totalLinks,
			totalFiles,
			affectedFiles,
			failedFiles
		} = await renameHeadingReferences(this.app, this.editor, target, filesToSearch);

		if (failedFiles.length > 0) {
			const summary = `Heading renamed with ${failedFiles.length} file${failedFiles.length > 1 ? 's' : ''} skipped. Updated ${totalLinks} link${totalLinks === 1 ? '' : 's'} across ${totalFiles} file${totalFiles === 1 ? '' : 's'}.\nFailed:\n${failedFiles.join('\n')}`;
			new Notice(summary, 10000);
		} else if (totalLinks > 0) {
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

						const matchData = getReferenceMatches(this.app, line, f, this.file, oldName, targetIds);

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
				const lines = splitLinesWithEndings(data);

				for (const change of changes) {
					if (lines[change.lineNum]?.text === change.beforeLine) {
						lines[change.lineNum].text = change.afterLine;
						fileChanged = true;
						changedLines++;
					} else {
						skippedStale++;
					}
				}

				return fileChanged ? joinLinesWithEndings(lines) : data;
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
			.setName('Link Path Format')
			.setDesc('Choose whether generated links use the target file basename or full vault path.')
			.addDropdown(drop => drop
				.addOption('relative', 'Basename (./filename.md)')
				.addOption('full', 'Full vault path (folder/filename.md)')
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
