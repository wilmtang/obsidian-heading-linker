import path from 'node:path';

import type {} from '@wdio/types';

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./test/e2e/specs/**/*.e2e.ts'],
	maxInstances: 1,
	logLevel: 'warn',
	cacheDir: path.resolve('.obsidian-cache'),
	capabilities: [{
		browserName: 'obsidian',
		browserVersion: process.env.OBSIDIAN_E2E_VERSION ?? 'latest',
		'wdio:obsidianOptions': {
			installerVersion: process.env.OBSIDIAN_E2E_INSTALLER_VERSION ?? 'earliest',
			plugins: ['.'],
			vault: 'test/e2e/vault'
		}
	}],
	services: ['obsidian'],
	reporters: ['obsidian'],
	mochaOpts: {
		ui: 'bdd',
		timeout: 120000
	}
};
