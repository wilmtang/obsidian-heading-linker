import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
	{
		ignores: ['main.js', 'node_modules/**']
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
				sourceType: 'module'
			}
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
			obsidianmd
		},
		rules: {
			'obsidianmd/no-static-styles-assignment': 'error',
			'obsidianmd/no-unsupported-api': 'error',
			'obsidianmd/prefer-active-doc': 'warn',
			'obsidianmd/settings-tab/no-problematic-settings-headings': 'error',
			'@typescript-eslint/no-floating-promises': 'warn',
			'@typescript-eslint/no-misused-promises': [
				'warn',
				{
					checksVoidReturn: {
						arguments: true,
						attributes: true,
						inheritedMethods: true,
						properties: true,
						returns: true,
						variables: true
					}
				}
			]
		}
	}
];
