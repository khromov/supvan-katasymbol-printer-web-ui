// Downloads the official label (consumable) catalogs from Supvan's template server, the
// GetSystemTemplates call the SUPRINT and Katasymbol Android apps make when choosing a material,
// and trims them to the fields the app reads.
//
// Usage: node scripts/download-catalog.mjs [--offline]
//   Raw responses are cached in catalog-cache/ (git-ignored); --offline rebuilds from that cache.
//
// Writes src/lib/catalog/server/<family>.json for every family the server has materials for, next
// to the KatasymbolEditor catalogs (scripts/extract-catalog.mjs) the app uses; compare the two with
// scripts/compare-catalog.mjs before switching a family over. The E10/T10 series have no
// KatasymbolEditor catalog, so src/lib/catalog/t15.json is built from the server one.
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.supvan.com:8789/api/upload/GetSystemTemplates';
/** The Katasymbol app gets a superset of SUPRINT's materials; both are merged by ID. */
const PACKAGES = ['com.supvan.katasymbol', 'com.supvan.IPrinterEn'];
/** Printer types the apps ask for (DeviceManager / device classes), per family of this app. */
const FAMILIES = {
	// T50M 50, T50M Plus 5001, T50M Pro/T50i 5002, T50S 5003, T50 Plus+ 5004, T50 Max 5005,
	// T80M 8001, T80M Pro 8003, T80 Max 8004, T80 Pro 8312.
	t5080: [50, 5001, 5002, 5003, 5004, 5005, 8001, 8003, 8004, 8312],
	// G11 Pro 71157, G15 Pro 71153, G15 MPro 71154, G18 Pro 8337, G21 8340, G28 8341, G25 8344.
	g: [71157, 71153, 71154, 8337, 8340, 8341, 8344],
	// TP76i 8235, TP80A 8238, TP86A 8239 (the server has no materials for them so far).
	tp: [8235, 8238, 8239],
	// E10 and the T10 series.
	t15: [15]
};

const root = path.join(import.meta.dirname, '..');
const cacheDir = path.join(root, 'catalog-cache');
const outDir = path.join(root, 'src/lib/catalog');
const offline = process.argv.includes('--offline');

async function fetchCatalog(deviceType, packageName) {
	const file = path.join(cacheDir, `${packageName}-${deviceType}.json`);
	if (!offline) {
		const params = new URLSearchParams({
			terminalType: '1',
			deviceType: String(deviceType),
			className1: '',
			className2: '',
			packageName,
			lang: '2', // English
			isMaterial: 'true',
			code: '',
			version: '2',
			md5: ''
		});
		let text;
		for (let attempt = 1; ; attempt++) {
			try {
				const res = await fetch(`${API}?${params}`, { headers: { 'User-Agent': `${packageName}_Android:1.5.0` } });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				text = await res.text();
				break;
			} catch (e) {
				if (attempt >= 3) throw new Error(`${deviceType} ${packageName}: ${e.cause?.code ?? e.message}`);
				await new Promise((r) => setTimeout(r, 1000 * attempt));
			}
		}
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(file, text);
		await new Promise((r) => setTimeout(r, 300));
	}
	const body = JSON.parse(fs.readFileSync(file, 'utf8'));
	// ResultCode -1 is "no templates". Materials carry their material family as DeviceType (5001 for
	// the T50/T80, 118 for the G series), not the printer type asked for; the design templates the
	// server mixes in have isMaterial false.
	return (body.ResultValue ?? []).filter((e) => e.isMaterial);
}

/**
 * A server entry in the KatasymbolEditor catalog format (src/lib/catalog/index.ts), plus the
 * source fields the comparison needs. The formats only partly line up:
 *   - Width/Height are the length along and the width across the tape;
 *   - PaperType 3 is continuous (0 here), 1 die-cut; other codes are kept as they are;
 *   - there is no PaperDirection: for the T50/T80, Rotate 1 matches PaperDirection 1;
 *   - there is no padding, so the app's default for custom labels is used;
 *   - ShapeType 1 is round (3 here), 0 anything else.
 */
function toEntry(e, family, deviceTypes) {
	const entry = {
		ID: String(e.ID),
		Name: e.Name,
		Text: e.Specifications || undefined,
		TapeLength: e.Width,
		TapeWidth: e.Height,
		PaperDirection: family === 't5080' && e.Rotate === 1 ? 1 : 0,
		PaperType: e.PaperType === 3 ? 0 : e.PaperType,
		DieCutGap: e.Gap,
		Padding: { Top: 1, Bottom: 1, Left: 2, Right: 2 },
		ShapeType: e.ShapeType === 1 ? 3 : undefined,
		ClassName1: e.ClassName1 || undefined,
		Source: {
			Type: e.Type || undefined,
			PaperType: e.PaperType,
			Rotate: e.Rotate,
			TailLength: e.TailLength || undefined,
			TailDirection: e.TailDirection || undefined,
			DeviceTypes: deviceTypes
		}
	};
	return JSON.parse(JSON.stringify(entry));
}

/** The UI's E10/T10 list: no source fields, and flag labels include their tail. */
function toT15Entry(entry) {
	const { Source, ...rest } = entry;
	// T15Print.initImageData lengthens the label by the tail for tail directions 3 and 4.
	if (Source.TailLength && (Source.TailDirection === 3 || Source.TailDirection === 4)) rest.TapeLength += Source.TailLength;
	return rest;
}

const byId = (a, b) => a.ID.localeCompare(b.ID, 'en', { numeric: true });

fs.mkdirSync(path.join(outDir, 'server'), { recursive: true });
for (const [family, types] of Object.entries(FAMILIES)) {
	const merged = new Map();
	for (const packageName of PACKAGES) {
		for (const type of types) {
			for (const e of await fetchCatalog(type, packageName)) {
				const id = String(e.ID);
				const hit = merged.get(id);
				if (hit) hit.types.add(type);
				else merged.set(id, { e, types: new Set([type]) });
			}
		}
	}
	const entries = [...merged.values()].map(({ e, types }) => toEntry(e, family, [...types].sort((a, b) => a - b))).sort(byId);
	console.log(`${family}: ${entries.length} materials`);
	if (!entries.length) continue;
	fs.writeFileSync(path.join(outDir, 'server', `${family}.json`), `${JSON.stringify(entries, null, '\t')}\n`);
	if (family === 't15') fs.writeFileSync(path.join(outDir, 't15.json'), `${JSON.stringify(entries.map(toT15Entry), null, '\t')}\n`);
}
