// Virtual tests for the T50/T80 USB driver.
//
// The 4096-byte path every model but the T50M uses is the KatasymbolEditor 1.1.1 port: digests of
// its buffers and streams, recorded before the T50M layout was added, are in
// scripts/fixtures/t5080-golden.json, so any change to what those models get shows up here.
//
// The T50M (USB 1820:2070) only SupvanEditor 2.4.24 prints to, a .NET app that can't be run here.
// Its buffers are checked against a transliteration of SupvanEditor's TGenerateBufferList and
// GenerateLZMAData (Supvan.UsbDev.dll, frmLibUsbPrintCrt) written from the IL apart from
// t5080.ts, plus header bytes worked out by hand; whole jobs then run against a minimal emulated
// HID printer that decodes every stream it receives.
//
//   npx tsx scripts/test-t5080.ts            run the tests
//   npx tsx scripts/test-t5080.ts --record   re-record scripts/fixtures/t5080-golden.json (only
//                                            when a change to the 4096-byte path is intended)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findModel } from '../src/lib/printer/devices.ts';
import { packColumns } from '../src/lib/printer/bitmap.ts';
import LZMA from '../src/lib/printer/lzma.js';
import { btChunkT5080Page, buildT5080Buffers, encodeT5080Page, T5080Driver, t5080Raster, T50M_PRODUCT_ID } from '../src/lib/printer/families/t5080.ts';
import type { Transport } from '../src/lib/printer/transport.ts';
import { PrinterError, type Bitmap, type LabelSpec } from '../src/lib/printer/types.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (b: Uint8Array | number[]) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join(' ');
const decompress = (stream: Uint8Array) => Uint8Array.from(LZMA.decompress(stream) as Uint8Array);
const concat = (parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? `: ${detail}` : ''}`);
	if (!ok) failures++;
}

/** Deterministic asymmetric design: a border, a diagonal and LCG noise (about 1 in `sparse` dots). */
function design(width: number, height: number, seed: number, sparse = 16): Bitmap {
	const data = new Uint8Array(width * height);
	let s = seed;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			s = (s * 1103515245 + 12345) >>> 0;
			const edge = x === 0 || x === width - 11 || y === 0 || y === height - 4;
			const diag = x - 20 === y || (x < 40 && y < 20);
			if (edge || diag || s >>> 24 < 256 / sparse) data[y * width + x] = 1;
		}
	return { width, height, data };
}

const label = (id: string, lengthMm: number, widthMm: number, paperDirection: number): LabelSpec => ({
	id,
	name: id,
	lengthMm,
	widthMm,
	paperDirection,
	paperType: 1,
	gap: 3,
	padding: { top: 1, bottom: 1, left: 2, right: 2 }
});

interface Design {
	name: string;
	page: Bitmap;
	label: LabelSpec;
	density: number;
	headDots: number;
	offsetX?: number;
	offsetY?: number;
}

const DESIGNS: Design[] = [
	{ name: '40 x 30 mm die-cut, density 4', page: design(320, 240, 1), label: label('custom', 40, 30, 1), density: 4, headDots: 384 },
	{ name: '48 x 104 mm, 832 columns', page: design(384, 832, 2), label: label('custom', 48, 104, 1), density: 4, headDots: 384 },
	{ name: '48 x 105 mm, 840 columns', page: design(384, 840, 3), label: label('custom', 48, 105, 1), density: 6, headDots: 384 },
	{ name: '50 x 200 mm dense noise cropped to the head, density 7', page: design(400, 1600, 4, 2), label: label('custom', 50, 200, 1), density: 7, headDots: 384 },
	{ name: 'rotated 5414 label, paper direction 0, offsets', page: design(240, 320, 5), label: label('5414', 30, 40, 0), density: 3, headDots: 384, offsetX: 2, offsetY: -3 },
	{ name: 'T80 72 x 60 mm, 576-dot head', page: design(576, 480, 6, 8), label: label('custom', 72, 60, 1), density: 5, headDots: 576 }
];

// ---- The 4096-byte path (every model but the T50M) ----
//
// Digests of the KatasymbolEditor port's buffers, USB LZMA streams and Bluetooth chunks, recorded
// before the T50M layout was added: the existing models must keep getting exactly the same bytes.

interface Golden {
	columns: number;
	bytesPerColumn: number;
	buffers: number;
	buffersSha256: string;
	usb: number[];
	usbSha256: string;
	bt: number[];
	btSpeed: number;
	btSha256: string;
}

function standardDigest(d: Design, printEnd: boolean): Golden {
	const opts = { density: d.density, headDots: d.headDots, printEnd, offsetX: d.offsetX, offsetY: d.offsetY };
	const { buffers, columns, bytesPerColumn } = buildT5080Buffers(d.page, d.label, opts);
	const usb = encodeT5080Page(d.page, d.label, opts);
	const bt = btChunkT5080Page(buffers);
	return {
		columns,
		bytesPerColumn,
		buffers: buffers.length,
		buffersSha256: sha(concat(buffers)),
		usb: usb.chunks.map((c) => c.length),
		usbSha256: sha(concat(usb.chunks)),
		bt: bt.chunks.map((c) => c.length),
		btSpeed: bt.speed,
		btSha256: sha(concat(bt.chunks))
	};
}

const GOLDEN = path.join(import.meta.dirname, 'fixtures/t5080-golden.json');
if (process.argv.includes('--record')) {
	const out: Record<string, Golden> = {};
	for (const d of DESIGNS) for (const printEnd of [false, true]) out[`${d.name}${printEnd ? ', print end' : ''}`] = standardDigest(d, printEnd);
	fs.writeFileSync(GOLDEN, `${JSON.stringify(out, null, '\t')}\n`);
	console.log(`recorded ${path.relative(process.cwd(), GOLDEN)}`);
	process.exit(0);
}
const golden: Record<string, Golden> = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
for (const d of DESIGNS)
	for (const printEnd of [false, true]) {
		const key = `${d.name}${printEnd ? ', print end' : ''}`;
		const got = standardDigest(d, printEnd);
		check(`4096-byte path unchanged: ${key}`, JSON.stringify(got) === JSON.stringify(golden[key]), JSON.stringify(got));
	}

// ---- T50M: SupvanEditor's single 40000-byte buffer ----

/**
 * frmLibUsbPrintCrt::TGenerateBufferList (usbdev.il 68564-69270) for one page, from the IL: black
 * page (page colour 0, so FirstCut 0 and (bufLength - 22) / bpc columns a buffer), CutType 0, no
 * two-colour label and no leading blank columns (GetMarginPrevIndex 0, true of every design here:
 * they all have ink in their first row and column). `bytes` is the column raster, which is shared
 * with the 4096-byte path and so not what this checks.
 */
function supvanEditorBuffers(bytes: Uint8Array, columns: number, bpc: number, o: { bufLength: number; deepness: number; paperType: number; lastImage: boolean }): Uint8Array[] {
	const max = Math.trunc((o.bufLength - 22) / bpc); // local 6
	const bufferCountImage = Math.trunc((columns + max - 1) / max);
	const out: Uint8Array[] = [];
	for (let i = 0; i < bufferCountImage; i++) {
		const pageSt = i === 0 ? 1 : 0;
		const pageEnd = i === bufferCountImage - 1 ? 1 : 0;
		const prtEnd = pageEnd && o.lastImage ? 1 : 0;
		const cnt = pageEnd ? columns - max * i : max; // local 16
		const btBuf = new Uint8Array(o.bufLength); // _btBuf = new byte[_bufLength]
		btBuf[4] = cnt & 0xff;
		btBuf[5] = (cnt >> 8) & 0xff;
		btBuf.set(bytes.subarray(max * i * bpc, (max * i + cnt) * bpc), 14); // GetBytes(240, max * i + 0, cnt), Array.Copy to 14
		// PAGE_REG_BITS { Nodu = Deepness, Mat = PaperType }.ToBtyeArray(0) (usbdev.il 172821)
		let r0 = (pageSt ? 2 : 0) | (pageEnd ? 4 : 0) | (prtEnd ? 8 : 0);
		r0 = (r0 & 15) | ((0 << 4) & 0xff); // Cut 0
		let r1 = o.paperType & 0xff;
		r1 = (r1 << 6) & 0xff;
		r1 |= (o.deepness << 2) & 0xff;
		r1 |= 0 & 3; // FirstCut 0
		btBuf[2] = r0;
		btBuf[3] = r1;
		btBuf[6] = bpc & 0xff;
		btBuf[8] = 1; // GetMarginPrevIndex 0: 1, 0
		btBuf[9] = 0;
		btBuf[10] = 1;
		btBuf[11] = 0;
		// Checksum, all ushort: len = (b5 << 8 + b4) * b6 + 14; sum of bytes 2..13 and of the last byte of each full 256.
		let len = btBuf[5];
		len = (len << 8) & 0xffff;
		len = (len + btBuf[4]) & 0xffff;
		len = (len * btBuf[6]) & 0xffff;
		len = (len + 14) & 0xffff;
		let sum = 0;
		for (let k = 2; k < 14; k++) sum = (sum + btBuf[k]) & 0xffff;
		const blocks = Math.trunc(len / 256);
		for (let k = 0; k < blocks; k++) sum = (sum + btBuf[(k + 1) * 256 - 1]) & 0xffff;
		btBuf[0] = sum & 0xff;
		btBuf[1] = (sum >> 8) & 0xff;
		out.push(btBuf);
	}
	return out;
}

/**
 * GenerateLZMAData (usbdev.il 71038-71142) as TDoPrint drives it: the first min(bufferMAXCount,
 * left) buffers in one stream, one fewer until it fits in _bufLength. Returns the buffers of each
 * stream. With bufferMAXCount 1 a stream that doesn't fit leaves count 0 and loops for ever.
 */
function supvanEditorStreams(buffers: Uint8Array[], bufferMAXCount: number, bufLength: number): Uint8Array[][] {
	const left = buffers.slice();
	const streams: Uint8Array[][] = [];
	while (left.length) {
		let count = Math.min(bufferMAXCount, left.length);
		let data: number[];
		do {
			if (count === 0) throw new Error('SupvanEditor would loop for ever');
			data = LZMA.compress(concat(left.slice(0, count)), 9);
			count--;
		} while (data.length > bufLength);
		streams.push(left.splice(0, count + 1));
	}
	return streams;
}

function supvanEditorPage(d: Design, lastImage: boolean) {
	const g = t5080Raster(d.page, d.label, d.headDots, d);
	const { bytes, bytesPerColumn } = packColumns(g);
	return supvanEditorBuffers(bytes, g.cols, bytesPerColumn, { bufLength: 40000, deepness: d.density, paperType: d.label.paperType, lastImage });
}

for (const d of DESIGNS.slice(0, 5))
	for (const printEnd of [false, true]) {
		const opts = { density: d.density, headDots: d.headDots, printEnd, offsetX: d.offsetX, offsetY: d.offsetY, t50m: true };
		const ours = encodeT5080Page(d.page, d.label, opts);
		const ref = supvanEditorPage(d, printEnd);
		const grouping = supvanEditorStreams(ref, 1, 40000);
		check(
			`T50M buffers match SupvanEditor: ${d.name}${printEnd ? ', print end' : ''}`,
			ours.buffers.length === ref.length && ours.buffers.every((b, i) => same(b, ref[i])),
			`${ours.buffers.length} vs ${ref.length} buffers`
		);
		check(
			`T50M one stream per buffer, each <= 40000 bytes and decoding to it: ${d.name}${printEnd ? ', print end' : ''}`,
			grouping.every((g) => g.length === 1) &&
				ours.chunks.length === ref.length &&
				ours.chunks.every((c, i) => c.length <= 40000 && same(decompress(c), ref[i])),
			ours.chunks.map((c) => c.length).join(', ')
		);
	}

// Header bytes worked out by hand from TGenerateBufferList: 840 columns of 48 bytes, 832 = (40000 -
// 22) / 48 per buffer, so 832 + 8; die-cut (Mat 1 -> 0x40) at density 6 (6 << 2 = 0x18).
{
	const d = DESIGNS[2];
	const { buffers } = buildT5080Buffers(d.page, d.label, { density: 6, headDots: 384, printEnd: true, bufferLength: 40000 });
	const [a, b] = buffers;
	const sum = (buf: Uint8Array, cols: number) => {
		let n = 0;
		for (let k = 2; k < 14; k++) n += buf[k];
		for (let k = 0; k < Math.floor((cols * 48 + 14) / 256); k++) n += buf[(k + 1) * 256 - 1];
		return [n & 0xff, (n >> 8) & 0xff];
	};
	check(
		'T50M header, first buffer: page start, 832 columns, 48 bytes each, margin 1',
		buffers.length === 2 && a.length === 40000 && hex(a.subarray(2, 14)) === '02 58 40 03 30 00 01 00 01 00 00 00' && hex(a.subarray(0, 2)) === hex(sum(a, 832)),
		hex(a.subarray(0, 14))
	);
	check(
		'T50M header, last buffer: page end + print end, 8 columns',
		b.length === 40000 && hex(b.subarray(2, 14)) === '0c 58 08 00 30 00 01 00 01 00 00 00' && hex(b.subarray(0, 2)) === hex(sum(b, 8)),
		hex(b.subarray(0, 14))
	);
	check('T50M buffers are zero after their columns', a.subarray(14 + 832 * 48).every((v) => !v) && b.subarray(14 + 8 * 48).every((v) => !v));
}
{
	// Coin-flip noise (Math.imul keeps the LCG exact), which LZMA can't shrink.
	const page: Bitmap = { width: 384, height: 832, data: new Uint8Array(384 * 832) };
	for (let i = 0, s = 9; i < page.data.length; i++) page.data[i] = (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 31;
	let error: unknown;
	try {
		encodeT5080Page(page, label('custom', 48, 104, 1), { density: 4, headDots: 384, printEnd: true, t50m: true });
	} catch (e) {
		error = e;
	}
	check('T50M: a buffer LZMA cannot fit in 40000 bytes is refused, not retried', error instanceof PrinterError && error.code === 'label', String(error));
}

// ---- Model table ----

{
	const m = findModel(0x2070);
	check('0x2070 is the T50M, a 384-dot T50/T80', m?.name === 'T50M' && m.family === 't5080' && m.dpmm === 8 && m.headDots === 384 && !m.listed);
}

// ---- Whole jobs against an emulated HID printer ----

/**
 * Answers every command with a status report and every NEXTFRM_BULK stream, once all its reports
 * are in, with one more. After each BUF_FULL it reports printing for three polls, the first two
 * with the buffer full, so the driver's waits run.
 */
class FakeT5080 implements Transport {
	readonly vendorId = 0x1820;
	readonly productName = 'emulated T50/T80';
	commands: { cmd: number; value: number; extra: number }[] = [];
	streams: { data: Uint8Array; reports: number }[] = [];
	private listeners = new Set<(d: Uint8Array) => void>();
	private bulk: { length: number; data: number[]; reports: number } | null = null;
	private busyPolls = 0;

	constructor(readonly productId: number) {}

	async sendReport(r: Uint8Array) {
		if (this.bulk) {
			this.bulk.data.push(...r);
			this.bulk.reports++;
			if (this.bulk.data.length >= this.bulk.length) {
				this.streams.push({ data: Uint8Array.from(this.bulk.data.slice(0, this.bulk.length)), reports: this.bulk.reports });
				this.bulk = null;
				this.reply();
			}
			return;
		}
		if (r[0] !== 0xc0 || r[1] !== 0x40) throw new Error(`unexpected report ${hex(r.subarray(0, 16))}`);
		const c = { cmd: r[4], value: (r[2] << 8) | r[3], extra: (r[8] << 8) | r[9] };
		this.commands.push(c);
		if (c.cmd === 0x5c) this.bulk = { length: c.value, data: [], reports: 0 };
		if (c.cmd === 0x10) this.busyPolls = 3;
		this.reply(c.cmd === 0x11);
	}

	private reply(poll = false) {
		const r = new Uint8Array(64);
		if (poll && this.busyPolls > 0) {
			if (this.busyPolls > 1) r[1] |= 0x01; // buffer full
			r[3] |= 0x40; // printing
			this.busyPolls--;
		}
		setTimeout(() => this.listeners.forEach((l) => l(r)), 1);
	}

	onReport(l: (d: Uint8Array) => void) {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	async close() {}
}

check('the driver picks the T50M layout by product id', new T5080Driver(new FakeT5080(T50M_PRODUCT_ID)).t50m && !new T5080Driver(new FakeT5080(0x2073)).t50m);

for (const productId of [T50M_PRODUCT_ID, 0x2073]) {
	const t50m = productId === T50M_PRODUCT_ID;
	const fake = new FakeT5080(productId);
	const driver = new T5080Driver(fake, 384);
	const pages = [DESIGNS[0], DESIGNS[2]];
	const copies = 2;
	await driver.print(pages.map((d) => d.page), label('custom', 48, 105, 1), { density: 4, copies });
	const name = t50m ? 'T50M' : '0x2073';
	// What the printer must decode: every buffer of the job, print end only on the very last.
	const expected = Array.from({ length: copies }, (_, c) =>
		pages.flatMap((d, p) => {
			const opts = { density: 4, headDots: 384, printEnd: c === copies - 1 && p === pages.length - 1, bufferLength: t50m ? 40000 : 4096 };
			return buildT5080Buffers(d.page, label('custom', 48, 105, 1), opts).buffers;
		})
	).flat();
	const received = fake.streams.flatMap((s) => {
		const raw = decompress(s.data);
		const n = t50m ? 40000 : 4096;
		return Array.from({ length: raw.length / n }, (_, k) => raw.subarray(k * n, (k + 1) * n));
	});
	const bulks = fake.commands.filter((c) => c.cmd === 0x5c);
	const fulls = fake.commands.filter((c) => c.cmd === 0x10);
	const starts = fake.commands.filter((c) => c.cmd === 0x13);
	check(
		`${name} job: 2 pages x 2, printer decodes every buffer in order`,
		received.length === expected.length && received.every((b, i) => same(b, expected[i])),
		`${received.length}/${expected.length} buffers`
	);
	check(
		`${name} job: one START (value 1) before the data, every stream announced and confirmed with its length`,
		starts.length === 1 &&
			starts[0].value === 1 &&
			fake.commands.indexOf(starts[0]) < fake.commands.indexOf(bulks[0]) &&
			bulks.length === fake.streams.length &&
			fulls.length === fake.streams.length &&
			fake.streams.every((s, i) => bulks[i].value === s.data.length && fulls[i].value === s.data.length && s.reports === Math.ceil(s.data.length / 64)),
		JSON.stringify(fake.commands.filter((c) => c.cmd !== 0x11))
	);
	// KatasymbolEditor's speed for the other models: 60 when a page is one stream, else 20.
	const speeds = Array.from({ length: copies }, (_, c) =>
		pages.flatMap((d, p) => {
			const printEnd = c === copies - 1 && p === pages.length - 1;
			const { chunks } = encodeT5080Page(d.page, label('custom', 48, 105, 1), { density: 4, headDots: 384, printEnd, t50m });
			return chunks.map(() => (t50m || chunks.length > 1 ? 20 : 60));
		})
	).flat();
	check(
		t50m ? 'T50M job: one 40000-byte buffer per stream, all at speed 20' : '0x2073 job: 4096-byte buffers, speed 60 for one-stream pages and 20 for split ones',
		fake.streams.every((s) => decompress(s.data).length % (t50m ? 40000 : 4096) === 0) &&
			(!t50m || fake.streams.length === expected.length) &&
			fulls.map((c) => c.extra).join() === speeds.join() &&
			speeds.includes(t50m ? 20 : 60),
		`${fulls.map((c) => c.extra).join(', ')} vs ${speeds.join(', ')}`
	);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
