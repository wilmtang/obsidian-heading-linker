import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import HeadingLinkCopierPlugin, {
	buildMigrationPlan,
	renameHeadingReferences
} from '../../main.ts';

interface MockFile {
	path: string;
	name: string;
	basename: string;
	parent: { path: string } | null;
}

class MockEditor {
	lines: string[];
	setLine = vi.fn((line: number, value: string) => {
		this.lines[line] = value;
	});

	constructor(content: string | string[]) {
		this.lines = Array.isArray(content) ? [...content] : content.split('\n');
	}

	getLine(line: number): string {
		return this.lines[line];
	}

	lineCount(): number {
		return this.lines.length;
	}
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

function createVault(initialContent: Record<string, string>) {
	const files = new Map(Object.keys(initialContent).map(path => [path, createFile(path)]));
	const contentByPath = new Map(Object.entries(initialContent));

	function getFileByPath(path: string): MockFile | null {
		return files.get(path) ?? null;
	}

	function byLinkpath(linkpath: string, sourcePath: string): MockFile | null {
		const decodedPath = decodeURIComponent(linkpath);
		const sourceFolder = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
		const candidates = [
			decodedPath,
			decodedPath.endsWith('.md') ? decodedPath : `${decodedPath}.md`,
			decodedPath.replace(/^\.\//, ''),
			decodedPath.replace(/^\.\//, '').endsWith('.md') ? decodedPath.replace(/^\.\//, '') : `${decodedPath.replace(/^\.\//, '')}.md`
		];

		if (decodedPath.startsWith('./') || decodedPath.startsWith('../')) {
			const normalized = `${sourceFolder}/${decodedPath}`
				.split('/')
				.reduce<string[]>((parts, part) => {
					if (!part || part === '.') return parts;
					if (part === '..') {
						parts.pop();
						return parts;
					}
					parts.push(part);
					return parts;
				}, [])
				.join('/');
			candidates.push(normalized.endsWith('.md') ? normalized : `${normalized}.md`);
		}

		for (const candidate of candidates) {
			const direct = getFileByPath(candidate);
			if (direct) return direct;
		}

		const basename = decodedPath.replace(/\.md$/i, '').replace(/^\.\//, '');
		const basenameMatches = [...files.values()].filter(file => file.basename === basename);
		return basenameMatches.length === 1 ? basenameMatches[0] : null;
	}

	return {
		app: {
			metadataCache: {
				getFirstLinkpathDest: (linkpath: string, sourcePath: string) => byLinkpath(linkpath, sourcePath)
			},
			vault: {
				cachedRead: async (file: MockFile) => contentByPath.get(file.path) ?? '',
				getFileByPath,
				getMarkdownFiles: () => [...files.values()],
				process: async (file: MockFile, update: (data: string) => string) => {
					const current = contentByPath.get(file.path) ?? '';
					contentByPath.set(file.path, update(current));
				}
			}
		},
		contentByPath,
		files
	};
}

function createPlugin(): HeadingLinkCopierPlugin {
	const plugin = Object.create(HeadingLinkCopierPlugin.prototype) as HeadingLinkCopierPlugin;
	plugin.settings = {
		pathFormat: 'relative',
		renameScope: 'vault',
		duplicateHeadingTargetFormat: 'obsidian-block'
	};
	return plugin;
}

describe('plugin workflow e2e', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubGlobal('navigator', {
			clipboard: {
				writeText: vi.fn()
			}
		});
	});

	it('copies a duplicate heading link by inserting a stable target in the editor', async () => {
		const plugin = createPlugin();
		const file = createFile('Target.md');
		const editor = new MockEditor([
			'# Same',
			'## Same'
		]);
		const heading = {
			heading: 'Same',
			position: {
				start: { line: 1 },
				end: { line: 1 }
			}
		};

		await plugin.copyHeadingLink(file as any, heading as any, editor as any);

		const updatedLine = editor.lines[1];
		const id = updatedLine.match(/\^([A-Za-z0-9-]+)$/)?.[1];
		expect(id).toMatch(/^same-/);
		expect(editor.setLine).toHaveBeenCalledWith(1, updatedLine);
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`[Same](<./Target.md#^${id}>)`);
	});

	it('escapes both < and > when generating a link for a heading with angle brackets', async () => {
		const plugin = createPlugin();
		const file = createFile('Target.md');
		const editor = new MockEditor(['# A < B > C']);
		const heading = {
			heading: 'A < B > C',
			position: { start: { line: 0 }, end: { line: 0 } }
		};

		await plugin.copyHeadingLink(file as any, heading as any, editor as any);

		expect(navigator.clipboard.writeText).toHaveBeenCalledWith('[A < B > C](<./Target.md#A \\< B \\> C>)');
	});

	it('renames references across an open note and vault files without touching unrelated headings', async () => {
		const { app, contentByPath, files } = createVault({
			'Target.md': '# Intro\n[[Target#Intro]]\n[[Other#Intro]]\n[Intro](<Target.md#Intro>)',
			'Notes.md': '[[Target#Intro]]\n[[Other#Intro]]\n[Intro](<Target.md#Intro>)\n<a href="Target.md#Intro">Intro</a>',
			'Other.md': '# Intro'
		});
		const targetFile = files.get('Target.md')!;
		const targetEditor = new MockEditor(contentByPath.get('Target.md')!);

		targetEditor.setLine(0, '# Overview');
		const result = await renameHeadingReferences(app as any, targetEditor as any, {
			file: targetFile as any,
			oldName: 'Intro',
			newName: 'Overview',
			targetIds: []
		}, app.vault.getMarkdownFiles() as any);

		expect(result.totalLinks).toBe(5);
		expect(result.totalFiles).toBe(2);
		expect(result.failedFiles).toEqual([]);
		expect(targetEditor.lines).toEqual([
			'# Overview',
			'[[Target#Overview]]',
			'[[Other#Intro]]',
			'[Overview](<Target.md#Overview>)'
		]);
		expect(contentByPath.get('Notes.md')).toBe([
			'[[Target#Overview]]',
			'[[Other#Intro]]',
			'[Overview](<Target.md#Overview>)',
			'<a href="Target.md#Overview">Overview</a>'
		].join('\n'));
		expect(contentByPath.get('Other.md')).toBe('# Intro');
	});

	it.each([
		{
			direction: 'block-to-html' as const,
			beforeHeading: '## Intro <a id="intro-web"></a> ^intro-block',
			afterHeading: '## Intro <a id="intro-web"></a> <a id="intro-block"></a>',
			beforeLink: '[Intro](<Target.md#^intro-block>)',
			afterLink: '[Intro](<Target.md#intro-block>)',
			convertedId: 'intro-block'
		},
		{
			direction: 'html-to-block' as const,
			beforeHeading: '## Intro <a id="intro-web"></a> ^intro-block',
			afterHeading: '## Intro ^intro-web ^intro-block',
			beforeLink: '[Intro](<Target.md#intro-web>)',
			afterLink: '[Intro](<Target.md#^intro-web>)',
			convertedId: 'intro-web'
		}
	])('preserves unrelated target markers during $direction migration', async ({
		direction,
		beforeHeading,
		afterHeading,
		beforeLink,
		afterLink,
		convertedId
	}) => {
		const { app } = createVault({
			'Target.md': `${beforeHeading}\n${beforeLink}`
		});

		const plan = await buildMigrationPlan(app as any, direction);
		const headingChange = plan.changes.find(change => change.lineNum === 0);
		const linkChange = plan.changes.find(change => change.lineNum === 1);

		expect(plan.headingChanges).toBe(1);
		expect(plan.linkChanges).toBe(1);
		expect(headingChange?.afterLine).toBe(afterHeading);
		expect(headingChange?.ids).toEqual([convertedId]);
		expect(linkChange?.afterLine).toBe(afterLink);
		expect(linkChange?.ids).toEqual([convertedId]);
	});
});
