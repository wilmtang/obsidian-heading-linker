import { readFileSync } from 'node:fs';

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

const manifestVersion = readJson('manifest.json').version;
const packageVersion = readJson('package.json').version;

if (manifestVersion !== packageVersion) {
	console.error(`Version mismatch: manifest.json has ${manifestVersion}, package.json has ${packageVersion}.`);
	process.exit(1);
}

console.log(`Version check passed: ${manifestVersion}`);
