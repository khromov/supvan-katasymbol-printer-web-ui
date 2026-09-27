// Extracts the label (consumable) catalogs embedded in the KatasymbolEditor bundle.
// Usage: node scripts/extract-catalog.mjs <path to extracted app.asar>/js/app.<hash>.js
// (extract the asar with `npx @electron/asar extract /Applications/KatasymbolEditor.app/Contents/Resources/app.asar out`)
import fs from 'node:fs';
import path from 'node:path';

const bundle = process.argv[2];
if (!bundle) throw new Error('usage: node scripts/extract-catalog.mjs <app.js>');
const src = fs.readFileSync(bundle, 'utf8');
const outDir = path.join(import.meta.dirname, '../src/lib/catalog');
fs.mkdirSync(outDir, { recursive: true });

const KEEP = [
	'ID', 'Name', 'Text', 'TapeLength', 'TapeWidth', 'PaperDirection', 'PaperType', 'DieCutGap', 'Padding',
	'ShapeType', 'BlackMarkLength', 'BlackMarkHigh', 'BasePaperMargin', 'VCount', 'HCount', 'VSpace', 'HSpace',
	'HoleStyle', 'HoleWidth', 'HoleHeight', 'LabelWidth', 'LabelUlWidth', 'LabelHeight', 'ClassName1', 'BackgroundImg'
];

// Webpack JSON modules look like `abcd:function(A){A.exports=JSON.parse('...')}`.
const re = /([0-9a-f]{4}):function\(A\)\{A\.exports=JSON\.parse\('/g;
const found = [];
let m;
while ((m = re.exec(src))) {
	const start = m.index + m[0].length;
	const end = src.indexOf("')}", start);
	let data;
	try {
		data = JSON.parse(new Function(`return '${src.slice(start, end)}'`)());
	} catch {
		continue;
	}
	const items = Array.isArray(data) ? data : Object.values(data);
	if (items[0]?.TapeWidth === undefined) continue;
	found.push(items.map((it) => Object.fromEntries(KEEP.filter((k) => it[k] !== undefined).map((k) => [k, it[k]]))));
}

// Identify each catalog by characteristic IDs.
const families = { t5080: '5512', sp: '1827', tp: '11001', g: '118001' };
for (const [family, probe] of Object.entries(families)) {
	const cat = found.find((items) => items.some((i) => String(i.ID) === probe));
	if (!cat) {
		console.warn(`no catalog found for ${family}`);
		continue;
	}
	fs.writeFileSync(path.join(outDir, `${family}.json`), JSON.stringify(cat));
	console.log(family, cat.length, 'labels');
}
