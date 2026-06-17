import { execFileSync } from 'node:child_process';

const allowedFiles = new Set([
	'LICENSE',
	'README.md',
	'main.js',
	'manifest.json',
	'package.json',
	'styles.css',
	'versions.json'
]);

const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
	encoding: 'utf8',
	stdio: ['ignore', 'pipe', 'inherit']
});

const [packInfo] = JSON.parse(packOutput);
const packedFiles = packInfo.files.map((file) => file.path).sort();
const unexpectedFiles = packedFiles.filter((file) => !allowedFiles.has(file));
const missingFiles = [...allowedFiles].filter((file) => !packedFiles.includes(file)).sort();

if (unexpectedFiles.length > 0 || missingFiles.length > 0) {
	if (unexpectedFiles.length > 0) {
		console.error(`Unexpected files in npm package:\n${unexpectedFiles.join('\n')}`);
	}
	if (missingFiles.length > 0) {
		console.error(`Expected files missing from npm package:\n${missingFiles.join('\n')}`);
	}
	process.exit(1);
}

console.log(`Package contents OK: ${packedFiles.join(', ')}`);
