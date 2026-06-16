import { $, browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';

const PLUGIN_ID = 'heading-link-copy';

const DEFAULT_SETTINGS = {
	pathFormat: 'relative',
	renameScope: 'vault',
	duplicateHeadingTargetFormat: 'obsidian-block'
};

type PluginSettings = typeof DEFAULT_SETTINGS;
type VaultContents = Record<string, string>;

async function resetTestVault(files: VaultContents): Promise<void> {
	await obsidianPage.resetVault(files);
	await browser.executeObsidian(async ({ plugins }, settings) => {
		const plugin = plugins.headingLinkCopy as unknown as {
			settings: PluginSettings;
			saveSettings: () => Promise<void>;
		};

		Object.assign(plugin.settings, settings);
		await plugin.saveSettings();
	}, DEFAULT_SETTINGS);
}

async function waitForFileCache(path: string): Promise<void> {
	await browser.waitUntil(async () => browser.executeObsidian(({ app }, filePath) => {
		const file = app.vault.getFileByPath(filePath);

		return Boolean(file && app.metadataCache.getFileCache(file)?.headings?.length);
	}, path), {
		timeout: 5000,
		timeoutMsg: `Timed out waiting for metadata cache for ${path}`
	});
}

async function openFileAtLine(path: string, line: number): Promise<void> {
	await obsidianPage.openFile(path);
	await waitForFileCache(path);
	await browser.executeObsidian(({ app, obsidian }, targetLine) => {
		const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);

		if (!view) {
			throw new Error('Expected an active MarkdownView');
		}

		view.editor.setCursor({ line: targetLine, ch: 0 });
		view.editor.focus();
	}, line);
}

async function getActiveMarkdown(): Promise<string> {
	return browser.executeObsidian(({ app, obsidian }) => {
		const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);

		if (!view) {
			throw new Error('Expected an active MarkdownView');
		}

		return view.getViewData();
	});
}

async function saveActiveMarkdown(): Promise<void> {
	await browser.executeObsidian(async ({ app, obsidian }) => {
		const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);

		if (!view) {
			throw new Error('Expected an active MarkdownView');
		}

		await view.save();
	});
}

async function waitForActiveMarkdown(expected: string): Promise<void> {
	await browser.waitUntil(async () => (await getActiveMarkdown()) === expected, {
		timeout: 5000,
		timeoutMsg: `Timed out waiting for active editor to contain:\n${expected}`
	});
	expect(await getActiveMarkdown()).toBe(expected);
}

async function waitForFile(path: string, expected: string): Promise<void> {
	await browser.waitUntil(async () => (await obsidianPage.read(path)) === expected, {
		timeout: 5000,
		timeoutMsg: `Timed out waiting for ${path} to contain:\n${expected}`
	});
	expect(await obsidianPage.read(path)).toBe(expected);
}

async function renameActiveHeading(newName: string): Promise<void> {
	await browser.executeObsidianCommand(`${PLUGIN_ID}:rename-heading`);

	const modal = await $('.modal-container .modal-content');
	await modal.waitForDisplayed();
	await (await modal.$('input')).setValue(newName);
	await (await modal.$('//button[normalize-space()="Rename"]')).click();
	await modal.waitForDisplayed({ reverse: true });
}

describe('Heading Linker in Obsidian', () => {
	it('loads the plugin and opens a registered command modal', async () => {
		await resetTestVault({
			'Target.md': '# Intro'
		});
		await obsidianPage.openFile('Target.md');

		const pluginLoaded = await browser.executeObsidian(({ app }, pluginId) => (
			(app as unknown as { plugins: { enabledPlugins: Set<string> } }).plugins.enabledPlugins.has(pluginId)
		), PLUGIN_ID);

		expect(pluginLoaded).toBe(true);

		await browser.executeObsidianCommand(`${PLUGIN_ID}:convert-heading-link-target-format`);

		const modal = await $('.modal-container .modal-content');
		await modal.waitForDisplayed();

		const modalText = await modal.getText();

		expect(modalText).toContain('Dry run a vault-wide conversion before applying changes.');
		expect(modalText).toContain('Apply changes');

		await (await modal.$('//button[normalize-space()="Close"]')).click();
		await modal.waitForDisplayed({ reverse: true });
	});

	it('copies duplicate heading links by adding a stable block id', async () => {
		await resetTestVault({
			'Target.md': [
				'# Same',
				'## Same'
			].join('\n')
		});
		await openFileAtLine('Target.md', 1);

		await browser.executeObsidianCommand(`${PLUGIN_ID}:copy-markdown-link`);

		await browser.waitUntil(async () => /^# Same\n## Same \^same-[a-z0-9]{6}$/.test(await getActiveMarkdown()), {
			timeout: 5000,
			timeoutMsg: 'Timed out waiting for copy command to add a stable block id'
		});
		expect(await getActiveMarkdown()).toMatch(/^# Same\n## Same \^same-[a-z0-9]{6}$/);
	});

	it('renames a heading and updates links in other notes without touching unrelated same-name headings', async () => {
		await resetTestVault({
			'Target.md': [
				'# Intro',
				'Body',
				'[[Target#Intro]]',
				'[[Other#Intro]]',
				'[Intro](<Target.md#Intro>)'
			].join('\n'),
			'References.md': [
				'# Links',
				'[[Target#Intro]]',
				'[[Target#Intro|Intro]]',
				'[[Other#Intro]]',
				'[Intro](<Target.md#Intro>)',
				'<a href="Target.md#Intro">Intro</a>'
			].join('\n'),
			'Nested/Local.md': [
				'[[Target#Intro]]',
				'[Intro](<../Target.md#Intro>)'
			].join('\n'),
			'Other.md': [
				'# Intro',
				'[[Target#Intro]]'
			].join('\n')
		});
		await openFileAtLine('Target.md', 0);

		await renameActiveHeading('Overview');

		const expectedTarget = [
			'# Overview',
			'Body',
			'[[Target#Overview]]',
			'[[Other#Intro]]',
			'[Overview](<Target.md#Overview>)'
		].join('\n');
		await waitForActiveMarkdown(expectedTarget);
		await saveActiveMarkdown();
		await waitForFile('Target.md', expectedTarget);
		await waitForFile('References.md', [
			'# Links',
			'[[Target#Overview]]',
			'[[Target#Overview|Overview]]',
			'[[Other#Intro]]',
			'[Overview](<Target.md#Overview>)',
			'<a href="Target.md#Overview">Overview</a>'
		].join('\n'));
		await waitForFile('Nested/Local.md', [
			'[[Target#Overview]]',
			'[Overview](<../Target.md#Overview>)'
		].join('\n'));
		await waitForFile('Other.md', [
			'# Intro',
			'[[Target#Overview]]'
		].join('\n'));
	});

	it('renames stable-id aliases in other notes while preserving the target id', async () => {
		await resetTestVault({
			'Target.md': [
				'# Same',
				'## Same ^same-id'
			].join('\n'),
			'References.md': [
				'[[Target#^same-id|Same]]',
				'[[Target#^same-id]]',
				'[Same](<Target.md#^same-id>)',
				'<a href="Target.md#same-id">Same</a>',
				'[[Other#^same-id|Same]]'
			].join('\n'),
			'Other.md': [
				'# Same ^same-id',
				'[[Other#^same-id|Same]]'
			].join('\n')
		});
		await openFileAtLine('Target.md', 1);

		await renameActiveHeading('Specific Same');

		const expectedTarget = [
			'# Same',
			'## Specific Same ^same-id'
		].join('\n');
		await waitForActiveMarkdown(expectedTarget);
		await saveActiveMarkdown();
		await waitForFile('Target.md', expectedTarget);
		await waitForFile('References.md', [
			'[[Target#^same-id|Specific Same]]',
			'[[Target#^same-id]]',
			'[Specific Same](<Target.md#^same-id>)',
			'<a href="Target.md#same-id">Specific Same</a>',
			'[[Other#^same-id|Same]]'
		].join('\n'));
		await waitForFile('Other.md', [
			'# Same ^same-id',
			'[[Other#^same-id|Same]]'
		].join('\n'));
	});
});
