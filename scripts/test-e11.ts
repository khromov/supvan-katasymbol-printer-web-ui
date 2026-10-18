// Virtual tests for the E11 Bluetooth driver. Every scenario runs the driver against
// scripts/t15-emulator.ts (the E11 answers the same frames), decodes what the "printer" received
// and checks it against the intended dots.
//
// With --oracle, it is also compared with the SUPRINT app's own E11 print code (G15Print, run by
// scripts/suprint-oracle against an identical emulator, called the way the app's editor calls it).
// Given the app's LZMA streams, the driver must write exactly the same bytes; with its own encoder
// the printer must decode exactly the same buffers. That run's writes are then recorded as digests
// in scripts/fixtures/e11-golden.json, which the plain run checks.
//
// Scenarios the oracle can't cover (injected faults, behaviour that deliberately differs from the
// app's) are checked by their own assertions instead, plus a few unit checks.
//
//   npx tsx scripts/test-e11.ts                    run the tests
//   npx tsx scripts/test-e11.ts --scenarios <dir>  write the scenarios for the oracle
//   npx tsx scripts/test-e11.ts --oracle <dir>     compare with the oracle's output in <dir> and
//                                                  record new golden digests
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { familyFromBluetoothName, modelNameFromBluetoothName, unsupportedBluetoothModel } from '../src/lib/printer/devices.ts';
import { E11BtDriver, E11_END_MARGIN_MM, E11_OFFSET, e11Margins, e11Raster, encodeE11Label } from '../src/lib/printer/families/e11.ts';
import { t15Compress } from '../src/lib/printer/families/t15.ts';
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
	/** Continuous tape (the catalog's paper type 3) rather than die-cut labels. */
	continuous?: boolean;
	/** Print dialog offsets (-9..9), which go to the printer doubled. */
	offsetX?: number;
	offsetY?: number;
	/** The printer's READ_DPI answer (dots per mm times 100; 0 for none). */
	dpi?: number;
	/** Fault injection: no data frame replies, extra status bits, drop out of printing after a buffer. */
	noAcks?: boolean;
	status?: number[];
	stopAfterBuffers?: number;
	/** Cancel the job this long after it starts (with the driver's real 40 s acknowledgement wait). */
	cancelAfterMs?: number;
	/** The job must fail with this message. */
	expectError?: string;
	/** Leave out of the oracle (behaviour that deliberately differs from the app's, or faults). */
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
	oracle?: false;
	expect?: Record<string, unknown> | null;
}
interface StateScenario {
	kind: 'state';
	name: string;
	device: string;
	extra: number[];
	batteryMv: number;
	oracle?: false;
	expect?: Record<string, unknown>;
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
/** A frame with diagonals from column `from`, reaching into the blank ends and past the 88-dot band. */
/** Ink only in the 2..3 mm next to each end of the label (inside the part that prints), and a dot in the middle. */
const nearEnds = (lengthMm: number) =>
	page(lengthMm, (x, y) => {
		const w = lengthMm * 8;
		return y >= 8 && y < 88 && ((x >= 16 && x < 24) || (x >= w - 24 && x < w - 16) || (x === w >> 1 && y === 48));
	});
const framed = (lengthMm: number, from: number) =>
	page(lengthMm, (x, y) => {
		const w = lengthMm * 8;
		return x >= from && x < w - from && (y === 2 || y === 6 || y === 89 || x === from || x === w - from - 1 || (x + 2 * y) % 11 === 0);
	});
/** Pseudo-random dots from column `from`, which LZMA can't shrink (multi-frame streams). */
function noise(lengthMm: number, from: number, seed: number) {
	let s = seed;
	return page(lengthMm, (x) => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return x >= from && (s & 0x100) !== 0;
	});
}

function material(o: { sn: number; type: number; height: number; width: number; gap: number; code?: number[] }) {
	const p = new Uint8Array(48);
	const at = (frameIndex: number, bytes: number[]) => p.set(bytes, frameIndex - 10);
	at(22, [0x04, 0x9a, 0x3b, 0x12, 0xc4, 0x5e, 0x80]);
	at(29, o.code ?? [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
	at(37, [o.sn & 0xff, o.sn >> 8, o.type, o.height, o.width, o.gap]);
	at(43, [0x10, 0x27, 0, 0]);
	at(51, [25, 9, 28, 10, 30, 0]);
	return p;
}

/** E11 names have no known form beyond the prefix; one without A or B keeps the app's one-cell battery scale. */
const E = 'T0138E2507010001';
const W = 'T0216E2507010002';
const SCENARIOS: Scenario[] = [
	{ kind: 'print', name: 'basic', device: E, lengthMm: 40, pages: [framed(40, 0)], density: 4 },
	{ kind: 'print', name: 'long-copies', device: W, lengthMm: 100, pages: [framed(100, 30)], copies: 2, density: 7 },
	{ kind: 'print', name: 'two-pages-copies', device: E, lengthMm: 30, pages: [framed(30, 0), noise(30, 5, 7)], copies: 2, density: 1 },
	{ kind: 'print', name: 'noise-multi-frame', device: E, lengthMm: 60, pages: [noise(60, 0, 42)], density: 5 },
	{ kind: 'print', name: 'continuous', device: E, lengthMm: 50, pages: [framed(50, 4)], density: 3, continuous: true },
	{ kind: 'print', name: 'continuous-over-50', device: E, lengthMm: 51, pages: [framed(51, 4)], density: 3, continuous: true },
	// Labels over 50 mm keep the 2 mm ends too: the ink 2..3 mm from each end must print.
	{ kind: 'print', name: 'ends-over-50', device: E, lengthMm: 60, pages: [nearEnds(60)], density: 4 },
	{ kind: 'print', name: 'ends-continuous-109', device: E, lengthMm: 109, pages: [nearEnds(109)], density: 4, continuous: true },
	{ kind: 'print', name: 'two-full-buffers', device: E, lengthMm: 87, pages: [framed(87, 0)], density: 2 },
	{ kind: 'print', name: 'offsets', device: E, lengthMm: 30, pages: [framed(30, 8)], density: 4, offsetX: 5, offsetY: -4 },
	{ kind: 'print', name: 'dpi-7.9', device: E, lengthMm: 40, pages: [framed(40, 0)], density: 6, dpi: 790 },
	{ kind: 'print', name: 'dpi-7.9-continuous', device: E, lengthMm: 40, pages: [framed(40, 0)], density: 6, dpi: 790, continuous: true },
	{ kind: 'print', name: 'blank', device: E, lengthMm: 22, pages: [page(22, () => false)], density: 4 },
	{ kind: 'print', name: 'cover-open', device: E, lengthMm: 30, pages: [framed(30, 2)], density: 4, status: [0, 0, 0x08, 0], expectError: 'Cover is open', check: sent({ 13: 0 }) },
	{ kind: 'print', name: 'no-tape', device: E, lengthMm: 30, pages: [framed(30, 2)], density: 4, status: [0, 0, 0, 0x01], expectError: 'No label tape installed', check: sent({ 13: 0 }) },
	{ kind: 'print', name: 'low-battery', device: E, lengthMm: 30, pages: [framed(30, 2)], density: 4, status: [0x40, 0, 0, 0], expectError: 'Low battery, please charge', check: sent({ 13: 0 }) },
	{ kind: 'print', name: 'used-up', device: E, lengthMm: 30, pages: [framed(30, 2)], density: 4, status: [0x04, 0, 0, 0], expectError: 'Labels used up', check: sent({ 13: 0 }) },
	// The apps ask before printing on a tape the printer doesn't recognise, then print as usual.
	{ kind: 'print', name: 'unrecognized', device: E, lengthMm: 30, pages: [framed(30, 2)], density: 4, status: [0x08, 0, 0, 0] },
	{ kind: 'media', name: 'media-die-cut', device: E, material: material({ sn: 25004, type: 1, height: 12, width: 40, gap: 3 }) },
	{ kind: 'media', name: 'media-continuous', device: E, material: material({ sn: 25001, type: 0, height: 16, width: 50, gap: 9 }) },
	{ kind: 'media', name: 'media-custom-no-chip', device: E, material: material({ sn: 21930, type: 129, height: 12, width: 30, gap: 2, code: [0, 0, 0, 0, 0, 0, 0, 0] }) },
	{ kind: 'state', name: 'state-ok', device: E, extra: [0, 0, 0, 0], batteryMv: 4083 },
	{ kind: 'state', name: 'state-one-bar', device: E, extra: [0, 0, 0, 0], batteryMv: 3705 },
	{ kind: 'state', name: 'state-low-battery-flag', device: E, extra: [0x40, 0, 0, 0], batteryMv: 3650 },
	{ kind: 'state', name: 'state-cover', device: E, extra: [0, 0, 0x08, 0], batteryMv: 3951 },
	{ kind: 'state', name: 'state-no-tape', device: E, extra: [0, 0, 0, 0x01], batteryMv: 3900 },
	{ kind: 'state', name: 'state-read-error', device: E, extra: [0x02, 0, 0, 0], batteryMv: 3900 },
	{ kind: 'state', name: 'state-used-up-charging', device: E, extra: [0x04, 0, 0x10, 0], batteryMv: 3850 },
	{ kind: 'state', name: 'state-unrecognized', device: E, extra: [0x08, 0, 0, 0], batteryMv: 3990 },
	// The app ignores these bits on the E11 (the E12 driver takes 0x10 and 0x20 as errors).
	{ kind: 'state', name: 'state-ignored-bits', device: E, extra: [0x30, 0x08, 0, 0], batteryMv: 4000 },
	// Not in the oracle: faults, and where the driver deliberately differs from the app.
	{ kind: 'print', name: 'pacing', device: E, lengthMm: 60, pages: [noise(60, 0, 42)], density: 4, oracle: false, check: blePacing },
	{ kind: 'print', name: 'no-acks', device: E, lengthMm: 40, pages: [framed(40, 0)], density: 4, noAcks: true, expectError: 'Printer did not acknowledge the print data', check: stopped },
	{ kind: 'print', name: 'stopped-mid-job', device: E, lengthMm: 40, pages: [framed(40, 0)], copies: 3, density: 4, stopAfterBuffers: 1, expectError: 'Printing was stopped on the device' },
	// Cancel while a data frame waits for its (missing) reply: no 40 s wait, and the job is stopped.
	{ kind: 'print', name: 'cancel-during-ack', device: E, lengthMm: 40, pages: [framed(40, 0)], density: 4, noAcks: true, cancelAfterMs: 1500, expectError: 'Cancelled', check: stopped },
	// The print settings only offer -9..9, so the driver clamps.
	{ kind: 'print', name: 'offset-clamp', device: E, lengthMm: 30, pages: [framed(30, 2)], density: 4, offsetX: 20, offsetY: -30, oracle: false, check: sentAll({ 38: 18, 39: 0x10000 - 18 }) },
	// The app keeps the previous tape (or 25001) for a tape without a chip; the driver reports none.
	{ kind: 'media', name: 'media-no-chip', device: E, material: material({ sn: 25004, type: 1, height: 12, width: 40, gap: 3, code: [0, 0, 0, 0, 0, 0, 0, 0] }), oracle: false, expect: null },
	// The app would show 4 bars for any one-cell voltage on names with an A or B.
	{ kind: 'state', name: 'state-a-name', device: 'T0138A2507010001', extra: [0, 0, 0, 0], batteryMv: 3850, oracle: false, expect: { errors: [], warnings: [], charging: false, batteryLevel: 2 } }
];

const inOracle = (s: Scenario) => s.oracle !== false && (s.kind !== 'print' || (!s.noAcks && !s.stopAfterBuffers && !s.cancelAfterMs));

/** BLE: commands are single 16-byte writes, data frames four 128-byte ones. */
function blePacing(o: Outcome) {
	const bad = o.writes.filter((w) => w.length !== 16 && w.length !== 128);
	if (bad.length) throw new Error(`BLE write of ${bad[0].length} bytes`);
}
/** After a failed transfer the job must be stopped (STOP_PRINT, 0x14). */
function stopped(o: Outcome) {
	if (!o.events.some((e) => e.startsWith('cmd 14'))) throw new Error('printer was not stopped');
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
/** Each command (hex) was sent once, with this (unsigned 16-bit) argument. */
function sentAll(args: Record<string, number>) {
	return (o: Outcome) => {
		for (const [cmd, a] of Object.entries(args)) {
			const got = o.events.filter((e) => e.startsWith(`cmd ${cmd} `));
			if (got.length !== 1 || got[0] !== `cmd ${cmd} ${a} 0`) throw new Error(`command ${cmd}: ${got.join(', ') || 'not sent'}, expected argument ${a}`);
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
	media?: Record<string, unknown> | null;
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
	paperType: s.continuous ? 0 : 1,
	gap: 3,
	padding: { top: 1, bottom: 1, left: 2, right: 2 }
});

/** A printer that drops out of printing after `after` committed buffers (as if stopped on the device). */
class StoppingEmulator extends T15Emulator {
	constructor(
		name: string,
		private after: number
	) {
		super(name);
	}
	async write(data: Uint8Array) {
		await super.write(data);
		if (this.buffers.length >= this.after) this.printing = false;
	}
}

async function run(s: Scenario, compress?: (buf: Uint8Array) => Uint8Array): Promise<Outcome> {
	const emu = s.kind === 'print' && s.stopAfterBuffers ? new StoppingEmulator(s.device, s.stopAfterBuffers) : new T15Emulator(s.device);
	const driver = new E11BtDriver(emu, s.device, s.kind === 'print' && s.cancelAfterMs ? {} : { ackTimeoutMs: 300 });
	if (compress) driver.compress = compress;
	const out: Outcome = { writes: emu.writes, events: emu.events, buffers: emu.buffers };
	if (s.kind === 'print') {
		emu.ackData = !s.noAcks;
		emu.dpi = s.dpi ?? 0;
		if (s.status) emu.extra = s.status;
		const abort = new AbortController();
		const t0 = Date.now();
		const timer = s.cancelAfterMs ? setTimeout(() => abort.abort(), s.cancelAfterMs) : undefined;
		try {
			await driver.print(s.pages, label(s), { density: s.density, copies: s.copies ?? 1, offsetX: s.offsetX, offsetY: s.offsetY, signal: abort.signal });
		} catch (e) {
			if (!s.expectError) throw e;
			out.error = (e as Error).message;
		} finally {
			clearTimeout(timer);
		}
		if (s.cancelAfterMs && Date.now() - t0 > s.cancelAfterMs + 2000) throw new Error(`cancelling took ${Date.now() - t0 - s.cancelAfterMs} ms`);
		if (s.expectError && out.error !== s.expectError) throw new Error(`expected "${s.expectError}", got ${out.error ? `"${out.error}"` : 'no error'}`);
		if (emu.printing) throw new Error('printer still printing after the job');
		s.check?.(out);
	} else if (s.kind === 'media') {
		emu.material = s.material;
		const m = await driver.readMedia();
		out.media = m && { ...m, raw: undefined };
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
	const endDots = E11_END_MARGIN_MM * 8;
	const labels = Array.from({ length: s.copies ?? 1 }, () => s.pages).flat();
	const dpmm = s.dpi && s.dpi >= 700 && s.dpi <= 800 ? s.dpi / 100 : 8;
	const rasters = labels.map((p) => e11Raster(p, endDots));
	const expected = rasters.map((g, i) => encodeE11Label(g, { density: s.density, last: i === labels.length - 1, margins: e11Margins(s.lengthMm, g.cols, !!s.continuous, dpmm) }).buffers);
	const all = expected.flat();
	if (all.length !== o.buffers.length) throw new Error(`printer got ${o.buffers.length} buffers, expected ${all.length}`);
	all.forEach((b, i) => {
		if (hex(b) !== hex(o.buffers[i])) throw new Error(`buffer ${i} differs from the encoder's`);
	});
	let n = 0;
	rasters.forEach((g, li) => {
		const printed: number[][] = [];
		for (let k = 0; k < expected[li].length; k++, n++) {
			const b = o.buffers[n];
			const cols = b[4] | (b[5] << 8);
			if (b[6] !== 12) throw new Error('bytes per column is not 12');
			if ((b[3] & 0x3c) >> 2 !== s.density || !(b[3] & 0x40)) throw new Error(`page register byte 3 is ${b[3].toString(16)}`);
			if (!!(b[2] & 0x02) !== (k === 0) || !!(b[2] & 0x04) !== (k === expected[li].length - 1)) throw new Error(`label ${li} buffer ${k}: page start/end flags ${b[2].toString(16)}`);
			for (let c = 0; c < cols; c++) printed.push(Array.from(b.subarray(14 + c * 12, 26 + c * 12)));
		}
		const page = labels[li];
		if (printed.length !== page.width - 2 * endDots) throw new Error(`label ${li}: ${printed.length} columns printed, expected ${page.width - 2 * endDots}`);
		// Every dot of the design's middle 88 rows, between the blank ends, at the same place on the head.
		for (let x = 0; x < printed.length; x++)
			for (let y = 0; y < 96; y++) {
				const want = y >= 4 && y < 92 ? page.data[y * page.width + x + endDots] : 0;
				const got = (printed[x][y >> 3] >> (y & 7)) & 1;
				if (want !== got) throw new Error(`label ${li}: dot at column ${x}, row ${y} is ${got}, expected ${want}`);
			}
	});
	const last = o.buffers[o.buffers.length - 1];
	if (!(last[2] & 0x08)) throw new Error('last buffer lacks the job-end flag');
	if (o.buffers.slice(0, -1).some((b) => b[2] & 0x08)) throw new Error('job-end flag before the last buffer');
}

// ---- Oracle files ----

function scenarioFile(s: Scenario): string {
	const lines = ['printer e11', `mode ${s.kind}`, `name ${s.device}`];
	if (s.kind === 'print') {
		lines.push(`length ${s.lengthMm}`, 'height 12', `copies ${s.copies ?? 1}`, `density ${s.density}`, `paperType ${s.continuous ? 3 : 1}`);
		lines.push(`shiftH ${s.offsetX ?? 0}`, `shiftV ${s.offsetY ?? 0}`, `dpi ${s.dpi ?? 0}`);
		if (s.status) lines.push(`extra ${s.status.join(',')}`);
		// The whole label, 88 rows tall; the harness cuts the app's own paint margin off its ends.
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
	/** Dots the app's editor takes off a label's length (DensityUtil), for print scenarios. */
	paintDots?: number;
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
		else if (tag === 'PAINT') o.paintDots = Number(kv(line).dots);
	}
	return o;
}

const kv = (s: string) => Object.fromEntries(s.split(' ').slice(1).map((p) => p.split('=')));

/** The app's messages (R.string ids in SUPRINT 1.5.0) as this driver's error texts. */
const LOW_POWER = String(0x7f1003b8);
const MESSAGES: Record<string, string> = {
	[LOW_POWER]: 'Low battery, please charge', // low_power
	[String(0x7f100008)]: 'Cover is open', // Cover_is_open
	[String(0x7f100452)]: 'No label tape installed', // no_material
	[String(0x7f1003ee)]: 'Labels used up', // material_usage
	[String(0x7f100529)]: 'Printing was stopped on the device' // printer_end
};

/** What the app's result line says, in this driver's terms. */
function expectedFromOracle(s: Scenario, result: string): Record<string, unknown> {
	if (s.kind === 'print') {
		const [, ok, msg] = result.split(' ');
		return ok === 'true' ? { result: 'RESULT true 0' } : { error: MESSAGES[msg] ?? `app message ${msg}` };
	}
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
	// getE11State names one problem; with one fault per scenario that is the driver's only error.
	const errors = r.canPrint === 'false' ? [MESSAGES[r.msg]] : [];
	const warnings = [...(r.canPrint === 'true' && r.tip === 'true' && r.msg === LOW_POWER ? ['Low battery, please charge'] : []), ...(r.real === 'false' ? ['Label not recognized'] : [])];
	return { errors, warnings, charging: r.charged === 'true', batteryLevel: Number(r.battery) };
}

function actual(s: Scenario, o: Outcome): Record<string, unknown> | null {
	if (s.kind === 'print') return o.error ? { error: o.error } : { result: 'RESULT true 0' };
	if (s.kind === 'media') {
		const m = o.media;
		return m ? { labelId: m.labelId, paperType: m.paperType, widthMm: m.widthMm, lengthMm: m.lengthMm, gap: m.gap, uuid: m.uuid } : null;
	}
	const st = o.state!;
	return { errors: st.errors, warnings: st.warnings, charging: st.charging, batteryLevel: st.batteryLevel };
}

// ---- Main ----

const GOLDEN = path.join(import.meta.dirname, 'fixtures/e11-golden.json');
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
		'name routing',
		() => {
			const cases: [string, string, string | undefined, string | undefined][] = [
				['T0138A2401010001', 'e11', 'E11', undefined],
				['T0184B2401010001', 'e11', 'E11', undefined],
				['T0227E2401010001', 'e11', 'E11', undefined],
				['E11', 'e11', undefined, undefined],
				['T0195A260420I470', 'e12', 'E12', undefined],
				['T0126E2507010001', 't15', 'E10', undefined],
				['T0053B2408080014', 't5080', undefined, 'E16'],
				['T0148B2507018663', 't5080', 'T50M Pro', undefined]
			];
			for (const [name, family, model, unsupported] of cases) {
				const got = [familyFromBluetoothName(name), modelNameFromBluetoothName(name), unsupportedBluetoothModel(name)];
				if (JSON.stringify(got) !== JSON.stringify([family, model, unsupported])) throw new Error(`${name}: ${JSON.stringify(got)}`);
			}
		}
	],
	[
		'margins',
		() => {
			const got = [e11Margins(40, 288, false), e11Margins(60, 448, false), e11Margins(40, 288, true), e11Margins(109, 840, true), e11Margins(40, 288, false, 7.9), e11Margins(40, 288, true, 7.9), e11Margins(10, 80, false)];
			const want = [[16, 16], [16, 16], [16, 16], [16, 16], [14, 14], [15, 15], [4, 4]];
			if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(JSON.stringify(got));
		}
	],
	[
		'buffer header of a 12 x 40 mm label',
		() => {
			// 288 columns at density 4, the only label of the job.
			const g = e11Raster(framed(40, 0), 16);
			const { buffers } = encodeE11Label(g, { density: 4, last: true, margins: [16, 16] }, () => new Uint8Array(0));
			const h = hex(buffers[0].subarray(2, 14));
			if (buffers.length !== 1 || h !== '0e5320010c00100010000000') throw new Error(`${buffers.length} buffers, header ${h}`);
		}
	],
	[
		'offset range',
		() => {
			if (E11_OFFSET.max !== 9) throw new Error(`offset max ${E11_OFFSET.max}`);
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
			const want = JSON.stringify(s.kind === 'print' ? (s.expectError ? { error: s.expectError } : { result: 'RESULT true 0' }) : s.expect);
			if (JSON.stringify(actual(s, o)) !== want) throw new Error(`unexpected result ${JSON.stringify(actual(s, o))}`);
			console.log(`ok   ${s.name} (${o.writes.length} writes, own checks, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
			continue;
		}
		if (oracleDir) {
			const ref = readOracle(oracleDir, s.name);
			// 0. The blank ends come from the app's editor, not from the driver.
			if (s.kind === 'print' && ref.paintDots !== 2 * E11_END_MARGIN_MM * 8) throw new Error(`the app's paint area is ${ref.paintDots} dots short of the label, the driver drops ${2 * E11_END_MARGIN_MM * 8}`);
			// 1. With the app's LZMA streams, every write must be the app's.
			const strict = await run(s, (buf) => {
				const i = ref.buffers.findIndex((b) => hex(b) === hex(buf));
				if (i < 0) throw new Error("a buffer differs from all of the app's");
				return ref.streams[i];
			});
			for (let i = 0; i < Math.max(ref.writes.length, strict.writes.length); i++) {
				const a = ref.writes[i] ? hex(ref.writes[i]) : '(none)';
				const b = strict.writes[i] ? hex(strict.writes[i]) : '(none)';
				if (a !== b) throw new Error(`write ${i} differs from the app's\n  app:    ${a.slice(0, 96)}\n  driver: ${b.slice(0, 96)}\n  app commands: ${ref.events.join(', ')}\n  driver commands: ${strict.events.join(', ')}`);
			}
			// 2. With LZMA-JS, the printer must decode the app's buffers and see the same commands.
			if (o.buffers.length !== ref.buffers.length || o.buffers.some((b, i) => hex(b) !== hex(ref.buffers[i]))) throw new Error("decoded buffers differ from the app's");
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
