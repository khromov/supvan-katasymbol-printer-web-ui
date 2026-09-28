// Compares the KatasymbolEditor catalogs the app uses (src/lib/catalog/<family>.json) with the
// server ones from scripts/download-catalog.mjs (src/lib/catalog/server/<family>.json), so nothing
// is dropped or changed by accident when a family switches over.
// Usage: node scripts/compare-catalog.mjs   (writes src/lib/catalog/server/COMPARISON.md)
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '../src/lib/catalog');
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const EXAMPLES = 12;

/** What each field changes in the app, for the report. */
const IMPACT = {
	size: 'Canvas size and what is printed.',
	PaperType: 'T50/T80: the material bits in every page register (12 = black mark). G: which cut options are offered (0/7 continuous and tube, 1 die-cut). All: die-cut detection.',
	PaperDirection: 'T50/T80: whether the design is rotated 90 degrees onto the head.',
	DieCutGap: 'Die-cut start position (T15) and label info.',
	ShapeType: 'Only the outline drawn in the editor.',
	Padding: 'Only the margin guides in the editor.',
	Name: 'Label names in the picker and search.'
};

const size = (e) => `${e.TapeLength} × ${e.TapeWidth}`;
/** Like labelShape in src/lib/catalog/index.ts: 2 rounded, 3 round, anything else a rectangle. */
const outline = (e) => ({ 2: 'rounded', 3: 'round' })[e.ShapeType] ?? 'rectangle';
const code = (e) => (e.Source?.Type ?? '').replace(/E$/, '');
const pad = (e) => (e.Padding ? `${e.Padding.Top}/${e.Padding.Bottom}/${e.Padding.Left}/${e.Padding.Right}` : '—');
const row = (cells) => `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const more = (n) => (n > EXAMPLES ? `\n\n…and ${n - EXAMPLES} more.` : '');

function compare(family, desktop, server) {
	const out = [`## ${family}`];
	const d = new Map(desktop.map((e) => [String(e.ID), e]));
	const s = new Map(server.map((e) => [String(e.ID), e]));
	const both = [...d.keys()].filter((id) => s.has(id));
	const onlyD = [...d.keys()].filter((id) => !s.has(id));
	const onlyS = [...s.keys()].filter((id) => !d.has(id));
	out.push(table(['KatasymbolEditor', 'Server', 'In both', 'Only KatasymbolEditor', 'Only server'], [[d.size, s.size, both.length, onlyD.length, onlyS.length]]));
	const summary = { family, desktop: d.size, server: s.size, both: both.length, dropped: onlyD.length, added: onlyS.length, changed: {} };

	if (onlyD.length) {
		out.push(`### Only in KatasymbolEditor (would be dropped)`);
		out.push(table(['ID', 'Name', 'Text', 'Size (mm)', 'PaperType'], onlyD.map((id) => d.get(id)).map((e) => [e.ID, e.Name, e.Text, size(e), e.PaperType])));
	}
	if (onlyS.length) {
		out.push(`### Only on the server (would be added)`);
		out.push(table(['ID', 'Name', 'Size (mm)', 'PaperType (server)', 'Printer types'], onlyS.map((id) => s.get(id)).map((e) => [e.ID, e.Name, size(e), `${e.PaperType} (${e.Source.PaperType})`, e.Source.DeviceTypes.join(', ')])));
	}

	const fields = [
		['size', (a) => size(a), (b) => size(b)],
		['PaperType', (a) => a.PaperType, (b) => `${b.PaperType} (server ${b.Source.PaperType})`, (a, b) => a.PaperType === b.PaperType],
		['PaperDirection', (a) => a.PaperDirection, (b) => `${b.PaperDirection} (Rotate ${b.Source.Rotate})`, (a, b) => a.PaperDirection === b.PaperDirection],
		['DieCutGap', (a) => a.DieCutGap, (b) => b.DieCutGap],
		['ShapeType', (a) => outline(a), (b) => outline(b)],
		['Padding', (a) => pad(a), () => 'none (default 1/1/2/2)', (a) => pad(a) === '1/1/2/2'],
		['Name', (a) => [a.Name, a.Text].filter(Boolean).join(' · '), (b) => `${code(b)} · ${b.Text ?? ''}`, (a, b) => a.Name === code(b) && (a.Text ?? '') === (b.Text ?? '')]
	];
	out.push(`### Differences in labels both have`);
	for (const [name, left, right, same = (a, b) => left(a) === right(b)] of fields) {
		const diffs = both.filter((id) => !same(d.get(id), s.get(id)));
		summary.changed[name] = diffs.length;
		out.push(`#### ${name}: ${diffs.length} of ${both.length} differ`);
		out.push(`_${IMPACT[name]}_`);
		if (!diffs.length) continue;
		// Group by the pair of values, most common first, with example IDs.
		const groups = new Map();
		for (const id of diffs) {
			const key = `${left(d.get(id))}\u0000${right(s.get(id))}`;
			groups.set(key, [...(groups.get(key) ?? []), id]);
		}
		const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
		out.push(table(['KatasymbolEditor', 'Server', 'Labels', 'IDs'], rows.slice(0, EXAMPLES).map(([k, ids]) => [...k.split('\u0000'), ids.length, ids.slice(0, 6).join(', ') + (ids.length > 6 ? ', …' : '')])) + more(rows.length));
	}
	const extra = [...new Set(desktop.flatMap((e) => Object.keys(e)))].filter((k) => !['ID', 'Name', 'Text', 'TapeLength', 'TapeWidth', 'PaperDirection', 'PaperType', 'DieCutGap', 'Padding', 'ShapeType'].includes(k));
	if (extra.length) out.push(`KatasymbolEditor fields the server has no counterpart for: ${extra.join(', ')}.`);
	return { text: out.join('\n\n'), summary };
}

const report = [
	'# KatasymbolEditor vs server label catalogs',
	'Generated by `scripts/compare-catalog.mjs` from `src/lib/catalog/*.json` (KatasymbolEditor, used by the app) and `src/lib/catalog/server/*.json` (`scripts/download-catalog.mjs`). Server values are shown after mapping to the app\'s format, with the raw server value in parentheses where the mapping is lossy.'
];
const notes = [];
const summaries = [];
for (const family of ['t5080', 'g', 'tp', 'sp', 't15']) {
	const desktop = read(path.join(dir, `${family}.json`));
	const server = read(path.join(dir, 'server', `${family}.json`));
	if (family === 't15') notes.push(`- **t15**: no KatasymbolEditor catalog; the app uses the server one (${server?.length ?? 0} labels).`);
	else if (!server) notes.push(`- **${family}**: the server has no materials for these printers; only the KatasymbolEditor catalog (${desktop.length} labels).`);
	else {
		const { text, summary } = compare(family, desktop, server);
		report.push(text);
		summaries.push(summary);
	}
}
report.splice(2, 0, notes.join('\n'));
fs.writeFileSync(path.join(dir, 'server', 'COMPARISON.md'), `${report.join('\n\n')}\n`);
for (const s of summaries) {
	const changed = Object.entries(s.changed).map(([k, n]) => `${k} ${n}`).join(', ');
	console.log(`${s.family}: ${s.desktop} KatasymbolEditor, ${s.server} server, ${s.both} shared; ${s.dropped} dropped, ${s.added} added; differing: ${changed}`);
}
console.log(notes.join('\n'));
console.log('wrote src/lib/catalog/server/COMPARISON.md');
