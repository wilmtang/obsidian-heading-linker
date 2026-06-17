import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	function normalizePath(path: string): string {
		const parts: string[] = [];
		for (const part of path.split('/')) {
			if (!part || part === '.') continue;
			if (part === '..') {
				parts.pop();
				continue;
			}
			parts.push(part);
		}
		return parts.join('/');
	}

	return {
		App: class {},
		ButtonComponent: class {},
		Modal: class {},
		Notice: class {},
		Plugin: class {},
		PluginSettingTab: class {},
		Setting: class {},
		SuggestModal: class {},
		TFile: class {},
		normalizePath,
		parseLinktext: (linktext: string) => {
			const hashIndex = linktext.indexOf('#');
			if (hashIndex === -1) {
				return { path: linktext, subpath: '' };
			}
			return {
				path: linktext.substring(0, hashIndex),
				subpath: linktext.substring(hashIndex)
			};
		}
	};
});

import {
	countMatchingHeadingVisibleText,
	escapeMarkdownLinkText,
	getReferenceMatches,
	parseHeadingLine,
	rewriteReferencesInContent,
	rewriteReferencesInEditor
} from '../main.ts';

interface MockFile {
	path: string;
	name: string;
	basename: string;
	parent: { path: string } | null;
}

function createFile(path: string): MockFile {
	const slashIndex = path.lastIndexOf('/');
	const folderPath = slashIndex === -1 ? '' : path.substring(0, slashIndex);
	const name = slashIndex === -1 ? path : path.substring(slashIndex + 1);
	return {
		path,
		name,
		basename: name.replace(/\.md$/i, ''),
		parent: folderPath ? { path: folderPath } : null
	};
}

function createMockApp(paths: string[]) {
	const files = new Map(paths.map(path => [path, createFile(path)]));

	function byLinkpath(linkpath: string): MockFile | null {
		const normalized = linkpath.replace(/^\.\//, '');
		const withExtension = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
		const direct = files.get(withExtension);
		if (direct) return direct;

		const withoutExtension = normalized.replace(/\.md$/i, '');
		const basenameMatches = [...files.values()].filter(file => file.basename === withoutExtension);
		return basenameMatches.length === 1 ? basenameMatches[0] : null;
	}

	return {
		app: {
			metadataCache: {
				getFirstLinkpathDest: (linkpath: string) => byLinkpath(linkpath)
			},
			vault: {
				getFileByPath: (path: string) => files.get(path) ?? null
			}
		},
		files
	};
}

describe('source-aware reference rewriting', () => {
	it('rewrites heading text links only when they resolve to the target file', () => {
		const { app, files } = createMockApp(['A.md', 'B.md', 'Notes/Source.md']);
		const sourceFile = files.get('Notes/Source.md')!;
		const targetFile = files.get('A.md')!;
		const content = [
			'[[A#Intro]] [[B#Intro]]',
			'[Intro](<A.md#Intro>) [Intro](<B.md#Intro>)',
			'<a href="A.md#Intro">Intro</a> <a href="B.md#Intro">Intro</a>'
		].join('\n');

		const result = rewriteReferencesInContent(app as any, sourceFile as any, content, {
			file: targetFile as any,
			oldName: 'Intro',
			newName: 'Overview',
			targetIds: []
		});

		expect(result.count).toBe(3);
		expect(result.data).toContain('[[A#Overview]]');
		expect(result.data).toContain('[[B#Intro]]');
		expect(result.data).toContain('[Overview](<A.md#Overview>)');
		expect(result.data).toContain('[Intro](<B.md#Intro>)');
		expect(result.data).toContain('<a href="A.md#Overview">Overview</a>');
		expect(result.data).toContain('<a href="B.md#Intro">Intro</a>');
	});

	it('updates stable-id aliases only for links resolved to the target file', () => {
		const { app, files } = createMockApp(['A.md', 'B.md', 'Notes/Source.md']);
		const sourceFile = files.get('Notes/Source.md')!;
		const targetFile = files.get('A.md')!;
		const content = [
			'[[A#^intro-id|Intro]] [[B#^intro-id|Intro]] [[A#^intro-id]]',
			'[Intro](<A.md#^intro-id>) [Intro](<B.md#^intro-id>)',
			'<a href="A.md#intro-id">Intro</a> <a href="B.md#intro-id">Intro</a>'
		].join('\n');

		const result = rewriteReferencesInContent(app as any, sourceFile as any, content, {
			file: targetFile as any,
			oldName: 'Intro',
			newName: 'Overview',
			targetIds: ['intro-id']
		});

		expect(result.count).toBe(3);
		expect(result.data).toContain('[[A#^intro-id|Overview]]');
		expect(result.data).toContain('[[B#^intro-id|Intro]]');
		expect(result.data).toContain('[[A#^intro-id]]');
		expect(result.data).toContain('[Overview](<A.md#^intro-id>)');
		expect(result.data).toContain('[Intro](<B.md#^intro-id>)');
		expect(result.data).toContain('<a href="A.md#intro-id">Overview</a>');
		expect(result.data).toContain('<a href="B.md#intro-id">Intro</a>');
	});

	it('reports references only when they resolve to the selected target file', () => {
		const { app, files } = createMockApp(['A.md', 'B.md', 'Notes/Source.md']);
		const sourceFile = files.get('Notes/Source.md')!;
		const targetFile = files.get('A.md')!;
		const line = '[[A#Intro]] [[B#Intro]] [Intro](<A.md#Intro>)';

		const matches = getReferenceMatches(app as any, line, sourceFile as any, targetFile as any, 'Intro', []);

		expect(matches.map(match => match.kind)).toEqual(['wikilink', 'markdown-link']);
	});

	it('recognizes and rewrites markdown destinations with escaped greater-than signs', () => {
		const { app, files } = createMockApp(['Target > File.md', 'Notes/Source.md']);
		const sourceFile = files.get('Notes/Source.md')!;
		const targetFile = files.get('Target > File.md')!;
		const content = '[A > B](<./Target \\> File.md#A \\> B>)';

		const matches = getReferenceMatches(app as any, content, sourceFile as any, targetFile as any, 'A > B', []);
		const result = rewriteReferencesInContent(app as any, sourceFile as any, content, {
			file: targetFile as any,
			oldName: 'A > B',
			newName: 'C > D',
			targetIds: []
		});

		expect(matches.map(match => match.kind)).toEqual(['markdown-link']);
		expect(result.count).toBe(1);
		expect(result.data).toBe('[C > D](<./Target \\> File.md#C \\> D>)');
	});

	it('escapes markdown link text when copied or rewritten', () => {
		expect(escapeMarkdownLinkText('A [bracket] \\ path')).toBe('A \\[bracket\\] \\\\ path');
	});

	it('finds and rewrites markdown links whose label contains escaped brackets', () => {
		const { app, files } = createMockApp(['A.md', 'Notes/Source.md']);
		const sourceFile = files.get('Notes/Source.md')!;
		const targetFile = files.get('A.md')!;
		// What the plugin itself generates for a heading named "A [x]":
		// the label is escaped, the destination fragment is raw inside <...>.
		const content = '[A \\[x\\]](<./A.md#A [x]>)';

		const matches = getReferenceMatches(app as any, content, sourceFile as any, targetFile as any, 'A [x]', []);
		const result = rewriteReferencesInContent(app as any, sourceFile as any, content, {
			file: targetFile as any,
			oldName: 'A [x]',
			newName: 'B [y]',
			targetIds: []
		});

		expect(matches.map(match => match.kind)).toEqual(['markdown-link']);
		expect(result.count).toBe(1);
		expect(result.data).toBe('[B \\[y\\]](<./A.md#B [y]>)');
	});

	it('updates an escaped display label that renders as the old heading name', () => {
		const { app, files } = createMockApp(['A.md', 'Notes/Source.md']);
		const sourceFile = files.get('Notes/Source.md')!;
		const targetFile = files.get('A.md')!;
		// Heading "A \ B": label escapes the backslash, destination keeps it raw.
		const content = '[A \\\\ B](<./A.md#A \\ B>)';

		const result = rewriteReferencesInContent(app as any, sourceFile as any, content, {
			file: targetFile as any,
			oldName: 'A \\ B',
			newName: 'Renamed',
			targetIds: []
		});

		expect(result.count).toBe(1);
		expect(result.data).toBe('[Renamed](<./A.md#Renamed>)');
	});

	it('counts duplicate headings from live editor lines', () => {
		const editor = {
			lineCount: () => 4,
			getLine: (line: number) => [
				'# Intro',
				'body',
				'## Intro <a id="intro-a"></a>',
				'## Other'
			][line]
		};

		expect(countMatchingHeadingVisibleText(editor as any, 'Intro')).toBe(2);
	});

	it('parses both block IDs and HTML anchors on the same heading', () => {
		const parsed = parseHeadingLine('## Intro <a id="intro-a"></a> ^intro-b');

		expect(parsed?.visibleText).toBe('Intro');
		expect(parsed?.targets).toEqual([
			{ format: 'html-anchor', id: 'intro-a' },
			{ format: 'obsidian-block', id: 'intro-b' }
		]);
	});

	it('applies active-file rewrites with line edits instead of replacing the whole buffer', () => {
		const { app, files } = createMockApp(['A.md', 'Notes/Source.md']);
		const sourceFile = files.get('Notes/Source.md')!;
		const targetFile = files.get('A.md')!;
		const lines = ['[[A#Intro]]', 'unchanged'];
		const editor = {
			lineCount: () => lines.length,
			getLine: (line: number) => lines[line],
			setLine: vi.fn((line: number, value: string) => {
				lines[line] = value;
			}),
			setValue: vi.fn()
		};

		const count = rewriteReferencesInEditor(app as any, editor as any, sourceFile as any, {
			file: targetFile as any,
			oldName: 'Intro',
			newName: 'Overview',
			targetIds: []
		});

		expect(count).toBe(1);
		expect(lines).toEqual(['[[A#Overview]]', 'unchanged']);
		expect(editor.setLine).toHaveBeenCalledWith(0, '[[A#Overview]]');
		expect(editor.setValue).not.toHaveBeenCalled();
	});

	it('preserves existing line endings while rewriting', () => {
		const { app, files } = createMockApp(['A.md', 'B.md', 'Notes/Source.md']);
		const sourceFile = files.get('Notes/Source.md')!;
		const targetFile = files.get('A.md')!;
		const content = '[[A#Intro]]\r\n[[B#Intro]]\r\n';

		const result = rewriteReferencesInContent(app as any, sourceFile as any, content, {
			file: targetFile as any,
			oldName: 'Intro',
			newName: 'Overview',
			targetIds: []
		});

		expect(result.data).toBe('[[A#Overview]]\r\n[[B#Intro]]\r\n');
	});
});
