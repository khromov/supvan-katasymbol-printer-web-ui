// Virtual tests for the E12 Bluetooth driver.
//
// The print buffers are checked against supvan-e12 (the Python driver tested on a real E12): the
// same designs went through its render_label(rotate=90, fit="none") -> to_columns(mirror=True) ->
// split_into_buffers, and the digests of its buffers are recorded in scripts/fixtures/e12-python.json.
// Whole jobs then run against the emulated printer of scripts/t15-emulator.ts (the E12 answers the
// same frames), which decodes every stream it receives.
//
//   npx tsx scripts/test-e12.ts                 run the tests
//   npx tsx scripts/test-e12.ts --designs <f>   write the designs as JSON for the Python side
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { familyFromBluetoothName, modelNameFromBluetoothName, unsupportedBluetoothModel } from '../src/lib/printer/devices.ts';
import { buildE12Buffers, chunkE12Buffers, E12BtDriver, e12Raster, parseE12Status } from '../src/lib/printer/families/e12.ts';
import type { Bitmap, LabelSpec } from '../src/lib/printer/types.ts';
import { T15Emulator } from './t15-emulator.ts';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? `: ${detail}` : ''}`);
	if (!ok) failures++;
}

/** Deterministic asymmetric design: a border, a diagonal and LCG noise, `rows` tall. */
function design(lengthMm: number, rows: number, seed: number): Bitmap {
	const width = lengthMm * 8;
	const data = new Uint8Array(width * rows);
	let s = seed;
	for (let y = 0; y < rows; y++)
		for (let x = 0; x < width; x++) {
			s = (s * 1103515245 + 12345) >>> 0;
			const edge = x === 10 || x === width - 11 || y === 3 || y === rows - 4;
			const diag = x - 20 === y || (x < 40 && y < 20);
			if (edge || diag || (s >>> 28) === 0) data[y * width + x] = 1;
		}
	return { width, height: rows, data };
}

const DESIGNS = [
	{ name: '12 x 40 mm die-cut, density 4', page: design(40, 96, 1), density: 4 },
	{ name: '12 mm x 100 mm, three buffers, density 7', page: design(100, 96, 2), density: 7 },
	{ name: '9 mm tape centred on the head', page: design(30, 72, 3), density: 4 },
	{ name: '15 mm tape cropped to the head', page: design(30, 120, 4), density: 4 }
];

const designsOut = process.argv.indexOf('--designs');
if (designsOut > 0) {
	const out = DESIGNS.map((d) => ({ width: d.page.width, height: d.page.height, density: d.density, bits: Array.from(d.page.data).join('') }));
	fs.writeFileSync(process.argv[designsOut + 1], JSON.stringify(out));
	process.exit(0);
}

// ---- Buffers vs. supvan-e12 ----

const golden: { buffers: string[] }[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/e12-python.json'), 'utf8'));
DESIGNS.forEach((d, i) => {
	const buffers = buildE12Buffers(e12Raster(d.page), { density: d.density, mat: 1 });
	const got = buffers.map(sha);
	check(`buffers match supvan-e12: ${d.name}`, JSON.stringify(got) === JSON.stringify(golden[i].buffers), `${got.length} vs ${golden[i].buffers.length} buffers`);
});

// ---- Replies captured from a real E12 (T0195A260420I470) ----

const STATUS_IDLE = hex('7e5a16001003551123010000000000000000000000002001f30f');
const MATERIAL = hex('7e5a380010035530780a0000000000000000000000001ddfccda1410809a959dd2e5975d8bac61010c280300000000460552031a040d10010c000003');
{
	const s = parseE12Status(STATUS_IDLE);
	check('idle status', !s.errors.length && !s.printing && !s.busy && !s.bufferFull && s.batteryVolts === 4.083 && s.batteryLevel === 4);
	const ribbon = STATUS_IDLE.slice();
	ribbon[14] = 0x20;
	check('ribbon end is ignored', !parseE12Status(ribbon).errors.length);
	const cover = STATUS_IDLE.slice();
	cover[16] = 0x08;
	check('cover open is an error', parseE12Status(cover).errors.includes('Cover is open'));
}
{
	const emu = new T15Emulator('T0195A260420I470');
	emu.material = MATERIAL.subarray(10);
	const driver = new E12BtDriver(emu, emu.deviceName);
	const m = await driver.readMedia();
	check('material 25004, 12 x 40 mm die-cut, gap 3', m?.labelId === 25004 && m.widthMm === 12 && m.lengthMm === 40 && m.paperType === 1 && m.gap === 3, JSON.stringify(m && { ...m, raw: undefined }));
}

// ---- Device names ----

check('E12 by Bluetooth name', familyFromBluetoothName('T0195A260420I470') === 'e12' && modelNameFromBluetoothName('T0195A260420I470') === 'E12' && !unsupportedBluetoothModel('T0195A260420I470'));
check('E12 by RD_DEV_NAME "G15"', familyFromBluetoothName('G15') === 'e12');
check('E11 still refused', unsupportedBluetoothModel('T0138A123') === 'E11');
check('E10 unchanged', familyFromBluetoothName('T0179G2507010001') === 't15');
check('T50 unchanged', familyFromBluetoothName('T0148B2507018663') === 't5080');

// ---- Chunking ----
{
	const many = Array.from({ length: 6 }, (_, i) => buildE12Buffers(e12Raster(design(40, 96, 10 + i)), { density: 4 })[0]);
	const { streams, speed } = chunkE12Buffers(many);
	check('streams fit 4096 bytes, split labels print at speed 20', streams.every((s) => s.length <= 4096) && streams.length >= 2 && speed === 20);
	const one = chunkE12Buffers(buildE12Buffers(e12Raster(design(40, 96, 1)), { density: 4 }));
	check('one-stream label gets a size-based speed', one.streams.length === 1 && [10, 15, 20, 25, 40, 45, 55, 60].includes(one.speed));
}

// ---- Whole jobs against the emulator ----

/** The emulator ends a job on the first buffer of a stream; the E12 puts several in one. */
class E12Emulator extends T15Emulator {
	private seen = 0;
	async write(data: Uint8Array) {
		await super.write(data);
		while (this.seen < this.buffers.length) {
			const raw = this.buffers[this.seen++];
			for (let o = 0; o < raw.length; o += 4096) if (raw[o + 2] & 0x08) this.printing = false;
		}
	}
}

const label = (lengthMm: number): LabelSpec => ({
	id: '25004',
	name: 'White 12*40mm',
	lengthMm,
	widthMm: 12,
	paperDirection: 0,
	paperType: 1,
	gap: 3,
	padding: { top: 1, bottom: 1, left: 2, right: 2 }
});

for (const copies of [1, 2]) {
	const emu = new E12Emulator('T0195A260420I470');
	const driver = new E12BtDriver(emu, emu.deviceName);
	const pages = [design(40, 96, 1), design(100, 96, 2)];
	await driver.print(pages, label(40), { density: 4, copies });
	const expected = Array.from({ length: copies }, () => pages.flatMap((p) => buildE12Buffers(e12Raster(p), { density: 4, mat: 1 }))).flat();
	const received = emu.buffers.flatMap((raw) => Array.from({ length: raw.length / 4096 }, (_, k) => raw.subarray(k * 4096, (k + 1) * 4096)));
	const starts = emu.events.filter((e) => e.startsWith('cmd 13 ')).length;
	check(
		`job: 2 pages x ${copies}, one START per label, printer decodes every buffer`,
		starts === 2 * copies && received.length === expected.length && received.every((b, i) => sha(b) === sha(expected[i])),
		`${starts} starts, ${received.length}/${expected.length} buffers`
	);
}
{
	const emu = new E12Emulator('T0195A260420I470');
	emu.extra = [0, 0, 0x08, 0];
	const driver = new E12BtDriver(emu, emu.deviceName);
	let error = '';
	await driver.print([design(40, 96, 1)], label(40), { density: 4, copies: 1 }).catch((e) => (error = e.message));
	check('cover open stops the job before START', error === 'Cover is open' && !emu.events.some((e) => e.startsWith('cmd 13 ')), error);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
