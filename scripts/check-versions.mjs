import { readFileSync } from 'node:fs';

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

const manifest = readJson('manifest.json');
const manifestVersion = manifest.version;
const packageVersion = readJson('package.json').version;

if (manifestVersion !== packageVersion) {
	console.error(`Version mismatch: manifest.json has ${manifestVersion}, package.json has ${packageVersion}.`);
	process.exit(1);
}

const versions = readJson('versions.json');
const mappedMinAppVersion = versions[manifestVersion];

if (!mappedMinAppVersion) {
	console.error(`versions.json is missing an entry for plugin version ${manifestVersion}.`);
	process.exit(1);
}

if (mappedMinAppVersion !== manifest.minAppVersion) {
	console.error(`versions.json maps ${manifestVersion} to minAppVersion ${mappedMinAppVersion}, but manifest.json declares ${manifest.minAppVersion}.`);
	process.exit(1);
}

console.log(`Version check passed: ${manifestVersion} (minAppVersion ${manifest.minAppVersion})`);
