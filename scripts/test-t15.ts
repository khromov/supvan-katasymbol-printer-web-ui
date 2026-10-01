// Virtual tests for the E10/T10-series (T15) Bluetooth driver. Every scenario runs the driver
// against scripts/t15-emulator.ts, decodes what the "printer" received and checks it against the
// intended dots.
//
// With --oracle, it is also compared with the SUPRINT app's own print code (scripts/suprint-oracle)
// run against an identical emulator. Given the app's LZMA streams, the driver must write exactly the
// same bytes; with its own encoder (LZMA-JS instead of the app's LZMA SDK 4.x, which sometimes picks
// different matches) the printer must decode exactly the same buffers. That run's writes are then
// recorded as digests in scripts/fixtures/t15-golden.json, which the plain run checks.
//
// Scenarios the oracle can't cover (BLE, which only the iOS app uses, and injected faults) are
// checked by their own assertions instead, plus a few unit checks.
//
//   npx tsx scripts/test-t15.ts                    run the tests
//   npx tsx scripts/test-t15.ts --scenarios <dir>  write the scenarios for the oracle
//   npx tsx scripts/test-t15.ts --oracle <dir>     compare with the oracle's output in <dir> and
//                                                  record new golden digests
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { familyFromBluetoothName, modelNameFromBluetoothName, unsupportedBluetoothModel } from '../src/lib/printer/devices.ts';
import { encodeT15Job, t15Compress, t15HeadRate, t15Raster, T15BtDriver, T15_OFFSET, type T15Link } from '../src/lib/printer/families/t15.ts';
import type { Bitmap, LabelSpec, PrinterStatus } from '../src/lib/printer/types.ts';
import { T15Emulator } from './t15-emulator.ts';

interface PrintScenario {
	kind: 'print';
	name: string;
	device: string;
	lengthMm: number;
	pages: Bitmap[];
	copies?: number;
	density: number;
	cut?: number;
	dieCut?: boolean;
	paperGap?: number;
	/** Print dialog offsets, in dots for these printers (-9..9). */
	offsetX?: number;
	offsetY?: number;
	/** Link to drive (default classic Bluetooth, the one the Android oracle covers). */
	link?: T15Link;
	/** Fault injection: commands the printer ignores, no data frame replies, extra status bits. */
	silent?: number[];
	noAcks?: boolean;
	status?: number[];
	/** The job must fail with this message. */
	expectError?: string;
	/** Leave out of the oracle (behaviour that deliberately differs from the app's). */
	oracle?: false;
	/** Extra checks on what was sent. */
	check?: (o: Outcome) => void;
}
interface MediaScenario {
	kind: 'media';
	name: string;
	device: string;
	/** RETURN_MAT reply payload, from frame byte 10 on. */
	material: Uint8Array;
}
interface StateScenario {
	kind: 'state';
	name: string;
	device: string;
	extra: number[];
	batteryMv: number;
}
type Scenario = PrintScenario | MediaScenario | StateScenario;

// ---- Scenarios ----

/** A 12 mm tape page (96 rows) of `lengthMm`, inked where `ink` says. */
function page(lengthMm: number, ink: (x: number, y: number) => boolean): Bitmap {
	const width = lengthMm * 8;
	const height = 96;
	const data = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (ink(x, y)) data[y * width + x] = 1;
	return { width, height, data };
}
const frame = (from: number) => (x: number, y: number, w: number) => x >= from && x < w - from && (y === 6 || y === 89 || x === from || x === w - from - 1 || (x + y) % 9 === 0);
const framed = (lengthMm: number, from: number) => page(lengthMm, (x, y) => frame(from)(x, y, lengthMm * 8));
const page0 = () => framed(40, 10);
/** Pseudo-random dots from column `from`, which LZMA can't shrink (multi-frame streams). */
function noise(lengthMm: number, from: number, seed: number) {
	let s = seed;
	return page(lengthMm, (x) => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return x >= from && (s & 0x100) !== 0;
	});
}

function material(o: { sn: number; type: number; height: number; width: number; gap: number }) {
	const p = new Uint8Array(48);
	const at = (frameIndex: number, bytes: number[]) => p.set(bytes, frameIndex - 10);
	at(22, [0x04, 0x9a, 0x3b, 0x12, 0xc4, 0x5e, 0x80]);
	at(29, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
	at(37, [o.sn & 0xff, o.sn >> 8, o.type, o.height, o.width, o.gap]);
	at(43, [0x10, 0x27, 0, 0]);
	at(51, [25, 9, 28, 10, 30, 0]);
	return p;
}

const E = 'T0126E2507010001';
const SCENARIOS: Scenario[] = [
	{ kind: 'print', name: 'basic', device: E, lengthMm: 40, pages: [framed(40, 10)], density: 4 },
	{ kind: 'print', name: 'long-copies-no-e', device: 'T0010A2409000001', lengthMm: 100, pages: [framed(100, 60)], copies: 2, density: 7 },
	{ kind: 'print', name: 'two-pages-cut-2', device: E, lengthMm: 30, pages: [framed(30, 0), noise(30, 5, 7)], copies: 2, density: 1, cut: 2 },
	{ kind: 'print', name: 'noise-multi-frame', device: 'T0071E2311020003', lengthMm: 60, pages: [noise(60, 0, 42)], density: 5 },
	{ kind: 'print', name: 'die-cut-offsets', device: E, lengthMm: 40, pages: [framed(40, 0)], density: 6, dieCut: true, paperGap: 2, offsetX: 8, offsetY: -4 },
	{ kind: 'print', name: 'blank', device: E, lengthMm: 30, pages: [page(30, () => false)], density: 3 },
	{ kind: 'print', name: 'two-full-buffers', device: E, lengthMm: 83, pages: [framed(83, 0)], density: 2 },
	{ kind: 'print', name: 'g-name-density', device: 'T0126G2507010001', lengthMm: 20, pages: [framed(20, 3)], density: 5 },
	{ kind: 'print', name: 'no-cut', device: E, lengthMm: 25, pages: [framed(25, 4)], copies: 2, density: 4, cut: 1 },
	{ kind: 'media', name: 'media-die-cut', device: E, material: material({ sn: 25001, type: 1, height: 12, width: 40, gap: 3 }) },
	{ kind: 'media', name: 'media-continuous', device: E, material: material({ sn: 15001, type: 0, height: 16, width: 0, gap: 9 }) },
	{ kind: 'state', name: 'state-ok', device: E, extra: [0, 0, 0, 0], batteryMv: 3705 },
	{ kind: 'state', name: 'state-low-battery-flag', device: E, extra: [0x40, 0, 0, 0], batteryMv: 3900 },
	{ kind: 'state', name: 'state-cover-unrecognized', device: 'T0126A2507010001', extra: [0x08, 0, 0x08, 0], batteryMv: 7700 },
	{ kind: 'state', name: 'state-empty', device: 'T0010B2409000001', extra: [0x10, 0, 0, 0], batteryMv: 7500 },
	{ kind: 'state', name: 'state-no-label', device: 'T0126D2507010001', extra: [0, 0, 0, 0x01], batteryMv: 7000 },
	{ kind: 'state', name: 'state-used-up-charging', device: E, extra: [0x04, 0, 0x10, 0], batteryMv: 3951 },
	{ kind: 'state', name: 'state-one-bar', device: E, extra: [0, 0, 0, 0], batteryMv: 3805 },
	{ kind: 'state', name: 'state-2v', device: E, extra: [0, 0, 0, 0], batteryMv: 2000 },
	// Not in the Android oracle: BLE (as the iOS app drives it) and fault handling.
	{ kind: 'print', name: 'ble-basic', link: 'ble', device: E, lengthMm: 40, pages: [framed(40, 10)], density: 4, check: blePacing },
	{ kind: 'print', name: 'ble-noise', link: 'ble', device: 'T0071E2311020003', lengthMm: 60, pages: [noise(60, 0, 42)], copies: 2, density: 5, check: blePacing },
	{ kind: 'print', name: 'ble-no-acks', link: 'ble', device: E, lengthMm: 40, pages: [framed(40, 10)], density: 4, noAcks: true, expectError: 'Printer did not acknowledge the print data', check: stopped },
	{ kind: 'print', name: 'spp-no-acks', device: E, lengthMm: 40, pages: [framed(40, 10)], density: 4, noAcks: true, expectError: 'Printer did not acknowledge the print data', check: stopped },
	// A real T0179G… E10 printed darkness 1 and 7 alike with SUPRINT's raw G-name value; BLE uses iOS's.
	{ kind: 'print', name: 'ble-g-name-density', link: 'ble', device: 'T0179G260517J505', lengthMm: 30, pages: [framed(30, 2)], density: 4, check: sentWith('c9', 110) },
	{ kind: 'print', name: 'ble-silent-density', link: 'ble', device: E, lengthMm: 30, pages: [framed(30, 2)], density: 3, silent: [0xc9, 0xba], check: sent({ c9: 1, ba: 1 }) },
	{ kind: 'print', name: 'spp-silent-density', device: E, lengthMm: 30, pages: [framed(30, 2)], density: 3, silent: [0xc9, 0xba], check: sent({ c9: 2, ba: 2 }) },
	{ kind: 'print', name: 'cover-open', device: E, lengthMm: 30, pages: [framed(30, 2)], density: 4, status: [0, 0, 0x08, 0], expectError: 'Cover is open', check: sent({ 13: 0 }) },
	// The app would take any offset; the print settings only offer -9..9, so the driver clamps.
	{ kind: 'print', name: 'offset-clamp', device: E, lengthMm: 30, pages: [framed(30, 12)], density: 4, offsetX: 20, offsetY: -30, oracle: false }
];

/** In the oracle: classic Bluetooth without faults. */
const inOracle = (s: Scenario) => s.kind !== 'print' || (s.oracle !== false && (s.link ?? 'spp') === 'spp' && !s.silent && !s.noAcks && !s.status && !s.expectError);

/** BLE: commands are single 16-byte writes, data frames four 128-byte ones. */
function blePacing(o: Outcome) {
	const bad = o.writes.filter((w) => w.length !== 16 && w.length !== 128);
	if (bad.length) throw new Error(`BLE write of ${bad[0].length} bytes`);
}
/** After a failed transfer the job must be stopped (STOP_PRINT, 0x14). */
function stopped(o: Outcome) {
	if (!o.events.some((e) => e.startsWith('cmd 14'))) throw new Error('printer was not stopped');
}
/** A command (hex) was sent once, with this argument. */
function sentWith(cmd: string, a: number) {
	return (o: Outcome) => {
		const got = o.events.filter((e) => e.startsWith(`cmd ${cmd} `));
		if (got.length !== 1 || got[0] !== `cmd ${cmd} ${a} 0`) throw new Error(`command ${cmd}: ${got.join(', ') || 'not sent'}, expected argument ${a}`);
	};
}
/** How often each command (hex) was sent. */
function sent(counts: Record<string, number>) {
	return (o: Outcome) => {
		for (const [cmd, n] of Object.entries(counts)) {
			const got = o.events.filter((e) => e.startsWith(`cmd ${cmd} `)).length;
			if (got !== n) throw new Error(`command ${cmd} sent ${got} times, expected ${n}`);
		}
	};
}

// ---- Running the driver ----

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const digest = (writes: Uint8Array[]) => createHash('sha256').update(writes.map(hex).join('\n')).digest('hex');

interface Outcome {
	writes: Uint8Array[];
	events: string[];
	buffers: Uint8Array[];
	media?: Record<string, unknown>;
	state?: PrinterStatus;
	/** The error the job failed with. */
	error?: string;
}

const label = (s: PrintScenario): LabelSpec => ({
	id: 'test',
	name: 'test',
	lengthMm: s.lengthMm,
	widthMm: 12,
	paperDirection: 0,
	paperType: s.dieCut ? 1 : 0,
	gap: s.paperGap ?? 3,
	padding: { top: 1, bottom: 1, left: 2, right: 2 }
});

async function run(s: Scenario, compress?: (buf: Uint8Array) => Uint8Array): Promise<Outcome> {
	const emu = new T15Emulator(s.device);
	const driver = new T15BtDriver(emu, s.device, s.kind === 'print' ? s.link : 'spp');
	if (compress) driver.compress = compress;
	const out: Outcome = { writes: emu.writes, events: emu.events, buffers: emu.buffers };
	if (s.kind === 'print') {
		emu.silent = new Set(s.silent);
		emu.ackData = !s.noAcks;
		if (s.status) emu.extra = s.status;
		try {
			await driver.print(s.pages, label(s), { density: s.density, copies: s.copies ?? 1, cutType: s.cut, offsetX: s.offsetX, offsetY: s.offsetY });
		} catch (e) {
			if (!s.expectError) throw e;
			out.error = (e as Error).message;
		}
		if (s.expectError && out.error !== s.expectError) throw new Error(`expected "${s.expectError}", got ${out.error ? `"${out.error}"` : 'no error'}`);
		if (emu.printing) throw new Error('printer still printing after the job');
		s.check?.(out);
	} else if (s.kind === 'media') {
		emu.material = s.material;
		const m = await driver.readMedia();
		out.media = { ...m, raw: undefined };
	} else {
		emu.extra = s.extra;
		emu.batteryMv = s.batteryMv;
		out.state = await driver.getStatus();
	}
	driver.channel.dispose();
	return out;
}

/** Rebuild what each label prints from the decoded buffers and compare it with the intended dots. */
function checkPrinted(s: PrintScenario, o: Outcome) {
	const clamp = (v = 0) => Math.max(-T15_OFFSET.max, Math.min(T15_OFFSET.max, v));
	const adjust = { left: clamp(s.offsetX), top: clamp(s.offsetY) };
	const labels = Array.from({ length: s.copies ?? 1 }, () => s.pages).flat();
	const rasters = labels.map((p) => t15Raster(p, adjust));
	const job = encodeT15Job(rasters, { density: s.density, dieCut: s.dieCut, paperGap: s.paperGap ?? 3, cutMode: s.cut ?? 0, avoidFrameMarkers: s.link === 'ble' });
	if (job.buffers.length !== o.buffers.length) throw new Error(`printer got ${o.buffers.length} buffers, expected ${job.buffers.length}`);
	job.buffers.forEach((b, i) => {
		if (hex(b) !== hex(o.buffers[i])) throw new Error(`buffer ${i} differs from the encoder's`);
	});
	let n = 0;
	rasters.forEach((g, li) => {
		const printed: number[][] = [];
		let skip = 0;
		for (let k = 0; k < job.perLabel[li]; k++, n++) {
			const b = o.buffers[n];
			const cols = b[4] | (b[5] << 8);
			if (k === 0) skip = b[12];
			if (b[6] !== 12) throw new Error('bytes per column is not 12');
			for (let c = 0; c < cols; c++) printed.push(Array.from(b.subarray(14 + c * 12, 26 + c * 12)));
		}
		if (li > 0 && skip) throw new Error('only the first label may skip columns');
		if (printed.length !== g.cols - skip) throw new Error(`label ${li}: ${printed.length} columns printed, expected ${g.cols - skip}`);
		for (let x = 0; x < g.cols; x++) {
			for (let y = 0; y < 96; y++) {
				const want = g.data[y * g.cols + x];
				const got = x < skip ? 0 : (printed[x - skip][y >> 3] >> (y & 7)) & 1;
				if (want !== got) throw new Error(`label ${li}: dot at column ${x}, row ${y} is ${got}, expected ${want}`);
			}
		}
		// Rows outside the middle 88 must stay blank without a vertical offset.
		if (!adjust.top) for (let x = 0; x < printed.length; x++) if (printed[x][0] & 0x0f || printed[x][11] & 0xf0) throw new Error('ink outside the 88-dot band');
	});
	const last = o.buffers[o.buffers.length - 1];
	if (!(last[2] & 0x08)) throw new Error('last buffer lacks the job-end flag');
	if (o.buffers.slice(0, -1).some((b) => b[2] & 0x08)) throw new Error('job-end flag before the last buffer');
}

// ---- Oracle files ----

function scenarioFile(s: Scenario): string {
	const lines = [`mode ${s.kind}`, `name ${s.device}`];
	if (s.kind === 'print') {
		lines.push(`length ${s.lengthMm}`, 'height 12', `copies ${s.copies ?? 1}`, `density ${s.density}`, `cut ${s.cut ?? 0}`);
		lines.push(`dieCut ${s.dieCut ? 1 : 0}`, `paperGap ${s.paperGap ?? 3}`, `adjustLeft ${s.offsetX ?? 0}`, `adjustTop ${s.offsetY ?? 0}`, 'threshold 204');
		// The app draws its bitmap scaled into the 88-dot band; give it exactly those 88 rows.
		for (const p of s.pages) {
			let bits = '';
			for (let y = 4; y < 92; y++) for (let x = 0; x < p.width; x++) bits += p.data[y * p.width + x] ? '1' : '0';
			lines.push(`page ${p.width} 88 ${bits}`);
		}
	} else if (s.kind === 'media') {
		lines.push(`material ${hex(s.material)}`);
	} else {
		lines.push(`extra ${s.extra.join(',')}`, `battery ${s.batteryMv}`);
	}
	return `${lines.join('\n')}\n`;
}

interface Oracle {
	result: string;
	writes: Uint8Array[];
	events: string[];
	buffers: Uint8Array[];
	/** The app's LZMA stream for each buffer. */
	streams: Uint8Array[];
}

function readOracle(dir: string, name: string): Oracle {
	const text = fs.readFileSync(path.join(dir, `${name}.out`), 'utf8');
	const o: Oracle = { result: '', writes: [], events: [], buffers: [], streams: [] };
	for (const line of text.split('\n')) {
		const [tag, ...rest] = line.split(' ');
		const value = rest.join(' ');
		if (tag === 'W') o.writes.push(Buffer.from(value, 'hex'));
		else if (tag === 'B') o.buffers.push(Buffer.from(value, 'hex'));
		else if (tag === 'L') o.streams.push(Buffer.from(value, 'hex'));
		else if (tag === 'E') o.events.push(value);
		else if (tag === 'RESULT' || tag === 'MEDIA' || tag === 'STATE') o.result = `${tag} ${value}`;
	}
	return o;
}

const kv = (s: string) => Object.fromEntries(s.split(' ').slice(1).map((p) => p.split('=')));

/** The app's getState messages (R.string ids in SUPRINT 1.5.0) as this driver's error texts. */
const LOW_POWER = String(0x7f1003b8);
const STATE_MESSAGES: Record<string, string> = {
	[String(0x7f1003e7)]: 'Label tape is not installed', // material_not_installed
	[LOW_POWER]: 'Low battery, please charge', // low_power
	[String(0x7f100008)]: 'Cover is open', // Cover_is_open
	[String(0x7f100452)]: 'No label detected', // no_material
	[String(0x7f1003ee)]: 'Labels used up' // material_usage
};

/** What the app's result line says, in this driver's terms. */
function expectedFromOracle(s: Scenario, result: string): Record<string, unknown> {
	if (s.kind === 'print') return { result };
	const r = kv(result);
	if (s.kind === 'media')
		return {
			labelId: Number(r.sn),
			paperType: r.type === '1' || r.type === '129' ? 1 : 0,
			widthMm: Number(r.height),
			lengthMm: Number(r.width),
			gap: Number(r.gap),
			uuid: r.uuid
		};
	const errors = r.canPrint === 'false' ? [STATE_MESSAGES[r.msg]] : [];
	const warnings = [...(r.real === 'false' ? ['Label not recognized'] : []), ...(r.canPrint === 'true' && r.tip === 'true' && r.msg === LOW_POWER ? ['Low battery, please charge'] : [])];
	return { errors, warnings, charging: r.charged === 'true', batteryLevel: Number(r.battery) };
}

function actual(s: Scenario, o: Outcome): Record<string, unknown> {
	if (s.kind === 'print') return o.error ? { error: o.error } : { result: 'RESULT true 0' };
	if (s.kind === 'media') {
		const m = o.media!;
		return { labelId: m.labelId, paperType: m.paperType, widthMm: m.widthMm, lengthMm: m.lengthMm, gap: m.gap, uuid: m.uuid };
	}
	const st = o.state!;
	return { errors: st.errors, warnings: st.warnings, charging: st.charging, batteryLevel: st.batteryLevel };
}

// ---- Main ----

const GOLDEN = path.join(import.meta.dirname, 'fixtures/t15-golden.json');
const args = process.argv.slice(2);
const flag = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const scenarioDir = flag('--scenarios');
if (scenarioDir) {
	fs.mkdirSync(scenarioDir, { recursive: true });
	const oracled = SCENARIOS.filter(inOracle);
	for (const s of oracled) fs.writeFileSync(path.join(scenarioDir, `${s.name}.txt`), scenarioFile(s));
	console.log(`wrote ${oracled.length} scenarios to ${scenarioDir}`);
	process.exit(0);
}

const oracleDir = flag('--oracle');
const golden: Record<string, { writes: number; sha256: string; expect: Record<string, unknown> }> = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : {};
const only = flag('--only');
let failed = 0;

// ---- Unit checks ----

const UNITS: [string, () => void][] = [
	[
		'frame-marker workaround',
		() => {
			// A stream with AA BB where the 2nd 128-byte write of the first frame starts its marker.
			const marked = new Uint8Array(600);
			marked[0x7a] = 0xaa;
			marked[0x7b] = 0xbb;
			const clean = new Uint8Array(600);
			const page = t15Raster(page0(), {});
			let calls = 0;
			const job = encodeT15Job([page], { density: 4, avoidFrameMarkers: true }, () => (calls++ ? clean : marked));
			if (calls !== 2 || job.streams[0] !== clean) throw new Error('marked stream was not re-encoded once');
			const plain = encodeT15Job([page], { density: 4 }, () => marked);
			if (job.buffers[0][0x7a] !== ((plain.buffers[0][0x7a] + 1) & 0xff)) throw new Error('buffer byte 0x7a was not bumped');
			if (job.buffers[0].some((b, i) => i !== 0x7a && b !== plain.buffers[0][i])) throw new Error('more than one byte changed');
			let n = 0;
			encodeT15Job([page], { density: 4, avoidFrameMarkers: true }, () => (n++, clean));
			if (n !== 1) throw new Error('clean stream was re-encoded');
		}
	],
	[
		'name routing',
		() => {
			const cases: [string, string, string | undefined, string | undefined][] = [
				['T0126E2507010001', 't15', 'E10', undefined],
				['T0079A2401010001', 't15', 'A10 Plus', undefined],
				['T0141B2401010001', 't15', 'A10 Pro', undefined],
				['T0140A2401010001', 't15', 'T10 Pro', undefined],
				['T0053B2408080014', 't5080', undefined, 'E16'],
				['T0138A2401010001', 't5080', undefined, 'E11'],
				['T0148B2507018663', 't5080', 'T50M Pro', undefined],
				// RD_DEV_NAME over classic Bluetooth, as a T0179G… E10 answers it.
				['E10pro', 't15', undefined, undefined],
				['E16', 't5080', undefined, 'E16']
			];
			for (const [name, family, model, unsupported] of cases) {
				const got = [familyFromBluetoothName(name), modelNameFromBluetoothName(name), unsupportedBluetoothModel(name)];
				if (JSON.stringify(got) !== JSON.stringify([family, model, unsupported])) throw new Error(`${name}: ${JSON.stringify(got)}`);
			}
		}
	],
	[
		'head rate',
		() => {
			const got = [1, 2, 3, 4, 5, 6, 7].map((d) => t15HeadRate(d));
			if (got.join() !== '80,90,100,110,120,130,140') throw new Error(got.join());
		}
	]
];
for (const [name, check] of UNITS) {
	if (only && name !== only) continue;
	try {
		check();
		console.log(`ok   unit: ${name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL unit: ${name}: ${(e as Error).message}`);
	}
}

// ---- Scenarios ----

for (const s of SCENARIOS) {
	if (only && s.name !== only) continue;
	const t0 = Date.now();
	try {
		const o = await run(s);
		if (s.kind === 'print' && !o.error) checkPrinted(s, o);
		let note = '';
		if (!inOracle(s)) {
			const want = JSON.stringify(s.kind === 'print' && s.expectError ? { error: s.expectError } : { result: 'RESULT true 0' });
			if (JSON.stringify(actual(s, o)) !== want) throw new Error(`unexpected result ${JSON.stringify(actual(s, o))}`);
			console.log(`ok   ${s.name} (${o.writes.length} writes, own checks, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
			continue;
		}
		if (oracleDir) {
			const ref = readOracle(oracleDir, s.name);
			// 1. With the app's LZMA streams, every write must be the app's.
			let n = 0;
			const strict = await run(s, (buf) => {
				if (hex(buf) !== hex(ref.buffers[n] ?? new Uint8Array())) throw new Error(`buffer ${n} differs from the app's`);
				return ref.streams[n++];
			});
			for (let i = 0; i < Math.max(ref.writes.length, strict.writes.length); i++) {
				const a = ref.writes[i] ? hex(ref.writes[i]) : '(none)';
				const b = strict.writes[i] ? hex(strict.writes[i]) : '(none)';
				if (a !== b) throw new Error(`write ${i} differs from the app's\n  app:    ${a.slice(0, 96)}\n  driver: ${b.slice(0, 96)}\n  app commands: ${ref.events.join(', ')}\n  driver commands: ${strict.events.join(', ')}`);
			}
			// 2. With LZMA-JS, the printer must decode the app's buffers and see the same commands.
			if (o.buffers.length !== ref.buffers.length || o.buffers.some((b, i) => hex(b) !== hex(ref.buffers[i]))) throw new Error('decoded buffers differ from the app\'s');
			const commands = (e: string[]) => e.map((c) => (c.startsWith('cmd 5c') ? 'cmd 5c' : c)).join(', ');
			if (commands(o.events) !== commands(ref.events)) throw new Error(`commands differ from the app's\n  app:    ${commands(ref.events)}\n  driver: ${commands(o.events)}`);
			const same = o.buffers.filter((b, i) => hex(t15Compress(b)) === hex(ref.streams[i])).length;
			if (o.buffers.length) note = `, ${same}/${o.buffers.length} LZMA streams identical to the app's`;
			golden[s.name] = { writes: o.writes.length, sha256: digest(o.writes), expect: expectedFromOracle(s, ref.result) };
		}
		const g = golden[s.name];
		if (!g) throw new Error('no golden digest (run with --oracle)');
		if (g.writes !== o.writes.length || g.sha256 !== digest(o.writes)) throw new Error(`writes differ from the recorded ones (${o.writes.length} writes, recorded ${g.writes})`);
		const want = JSON.stringify(g.expect);
		const got = JSON.stringify(actual(s, o));
		if (want !== got) throw new Error(`result differs from the app's\n  app:    ${want}\n  driver: ${got}`);
		console.log(`ok   ${s.name} (${o.writes.length} writes${note}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${s.name}: ${(e as Error).message}`);
	}
}
if (oracleDir && !only && !failed) {
	fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
	fs.writeFileSync(GOLDEN, `${JSON.stringify(golden, null, '\t')}\n`);
	console.log(`recorded golden digests in ${path.relative(process.cwd(), GOLDEN)}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
