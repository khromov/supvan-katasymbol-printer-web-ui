/**
 * E12 label maker (Katasymbol/Supvan E12; the firmware calls itself "G15" in RD_DEV_NAME). 96-dot
 * head at 8 dots/mm (12 mm tape), Bluetooth LE only (GATT service FEE7, one characteristic FEC1 for
 * notifications and writes without response).
 *
 * Ported from supvan-e12 (a Python driver tested on a real E12, Bluetooth name T0195A…), which
 * follows the T50 framing from heeen/supvan-cups. The `7E 5A` frames are the T50/T80 ones; the job
 * differs:
 *   - every label is its own job: CHECK_DEVICE, wait idle, START_PRINT(0), wait printing, data,
 *     wait until done;
 *   - 4096-byte buffers (up to 339 columns of 12 bytes) whose first and last 8 columns (1 mm) are
 *     not sent, the margins in the header telling the printer to feed them blank;
 *   - up to 4 buffers per LZMA stream (fewer if it would exceed 4096 bytes), each announced by
 *     0x5C(512, frames) and committed by BUF_FULL(length, speed);
 *   - the printer answers every 512-byte data frame (reply command 0xBB);
 *   - the head's dot 0 and the feed start are on the opposite side from the T10 series: the design
 *     is turned 180 degrees before packing;
 *   - the E12 has no ribbon, yet raises "ribbon end" after every label, so that bit is ignored.
 */
import { sleep } from '../channel';
import { type Grid } from '../bitmap';
import LZMA from '../lzma.js';
import type { ByteTransport } from '../serial';
import { CMD } from './t5080';
import { FrameChannel } from './t5080-bt';
import {
	PrinterError,
	type Bitmap,
	type LabelSpec,
	type MediaInfo,
	type PrinterDriver,
	type PrinterStatus,
	type PrintOptions
} from '../types';

export const E12_CMD = { ...CMD, RD_DEV_NAME: 0x16 } as const;

export const E12_HEAD_DOTS = 96;
export const E12_DENSITY = { min: 1, max: 15, default: 4 };
/** Position offsets in dots. */
export const E12_OFFSET = { max: 9, dots: 1 };
/** Columns (dots along the tape) left blank at each end of a label and not sent. */
export const E12_MARGIN_DOTS = 8;
const BUF_LENGTH = 4096;
const BYTES_PER_COLUMN = E12_HEAD_DOTS / 8;
/** Image bytes the firmware takes per buffer (339 columns). */
const MAX_BUF_DATA = 4074;
const BUFFERS_PER_STREAM = 4;

/**
 * Place a page on the head: the design's rows centred on the 96 dots (cropped or padded), shifted by
 * `dx` dots along the tape and `dy` across it, then turned 180 degrees, so the design's right end
 * prints first and its bottom row lands on dot 0 (as supvan-e12 does with a 90 degree turn of the
 * landscape image and a mirrored head).
 */
export function e12Raster(page: Bitmap, adjust: { dx?: number; dy?: number } = {}): Grid {
	const { width: w, height: h, data } = page;
	const rows = E12_HEAD_DOTS;
	const out = new Uint8Array(rows * w);
	const top = h > rows ? -Math.floor((h - rows) / 2) : (rows - h) >> 1;
	const dx = adjust.dx ?? 0;
	const dy = top + (adjust.dy ?? 0);
	for (let r = 0; r < h; r++) {
		const y = r + dy;
		if (y < 0 || y >= rows) continue;
		for (let c = 0; c < w; c++) {
			const x = c + dx;
			if (x >= 0 && x < w && data[r * w + c]) out[(rows - 1 - y) * w + (w - 1 - x)] = 1;
		}
	}
	return { rows, cols: w, data: out };
}

/** 12 bytes per column, row r in byte r / 8, bit r % 8. */
function columnBytes(g: Grid): Uint8Array {
	const bytes = new Uint8Array(g.cols * BYTES_PER_COLUMN);
	for (let r = 0; r < g.rows; r++)
		for (let c = 0; c < g.cols; c++) if (g.data[r * g.cols + c]) bytes[c * BYTES_PER_COLUMN + (r >> 3)] |= 1 << (r & 7);
	return bytes;
}

export interface E12BufferOptions {
	/** 0..15 burn level. */
	density: number;
	/** Page register material: 1 die-cut (what supvan-e12 always sends), 0 continuous. */
	mat?: number;
	marginDots?: number;
}

/**
 * Split one label's columns into 4096-byte print buffers (supvan-e12 protocol.split_into_buffers):
 * [0..1] checksum, [2] PageSt 0x02 / PageEnd|PrtEnd 0x0C, [3] density << 2 | mat << 6,
 * [4..5] columns, [6] bytes per column, [8..9]/[10..11] margins, [12] density, [14..] columns.
 */
export function buildE12Buffers(g: Grid, opts: E12BufferOptions): Uint8Array[] {
	const margin = opts.marginDots ?? E12_MARGIN_DOTS;
	const density = Math.max(0, Math.min(15, opts.density | 0));
	const mat = opts.mat ?? 1;
	const bytes = columnBytes(g);
	const printable = g.cols - 2 * margin;
	if (printable <= 0) throw new PrinterError('The label is shorter than its margins', 'empty');
	const maxCols = Math.floor(MAX_BUF_DATA / BYTES_PER_COLUMN);
	const marginField = Math.max(1, Math.min(margin, 900));
	const buffers: Uint8Array[] = [];
	for (let col = 0; col < printable; ) {
		const n = Math.min(maxCols, printable - col);
		const buf = new Uint8Array(BUF_LENGTH);
		buf[2] = (col === 0 ? 0x02 : 0) | (col + n >= printable ? 0x0c : 0);
		buf[3] = ((density << 2) | (mat << 6)) & 0xff;
		buf[4] = n & 0xff;
		buf[5] = (n >> 8) & 0xff;
		buf[6] = BYTES_PER_COLUMN;
		buf[8] = marginField & 0xff;
		buf[9] = marginField >> 8;
		buf[10] = marginField & 0xff;
		buf[11] = marginField >> 8;
		buf[12] = density;
		const start = (margin + col) * BYTES_PER_COLUMN;
		buf.set(bytes.subarray(start, start + n * BYTES_PER_COLUMN), 14);
		// Checksum: header bytes 2..13 plus the last byte of every full 256-byte block.
		const len = n * BYTES_PER_COLUMN + 14;
		let sum = 0;
		for (let j = 2; j < 14; j++) sum += buf[j];
		for (let k = 1; k <= Math.floor(len / 256); k++) sum += buf[k * 256 - 1];
		buf[0] = sum & 0xff;
		buf[1] = (sum >> 8) & 0xff;
		buffers.push(buf);
		col += n;
	}
	return buffers;
}

export const e12Compress = (buf: Uint8Array): Uint8Array => Uint8Array.from(LZMA.compress(buf, 9) as number[], (b) => b & 0xff);

const concat = (buffers: Uint8Array[]) => {
	const all = new Uint8Array(buffers.reduce((n, b) => n + b.length, 0));
	let o = 0;
	for (const b of buffers) {
		all.set(b, o);
		o += b.length;
	}
	return all;
};

/**
 * Pack up to four buffers per LZMA stream, dropping one at a time until the stream fits the
 * printer's 4096-byte receive buffer, and pick the print speed from the average stream size per
 * buffer (supvan-e12 compress_buffers / calc_speed; a label split over several streams prints at 20).
 */
export function chunkE12Buffers(buffers: Uint8Array[], compress = e12Compress): { streams: Uint8Array[]; speed: number } {
	const streams: Uint8Array[] = [];
	for (let i = 0; i < buffers.length; ) {
		let n = Math.min(BUFFERS_PER_STREAM, buffers.length - i);
		let stream = compress(concat(buffers.slice(i, i + n)));
		while (stream.length > BUF_LENGTH && n > 1) {
			n--;
			stream = compress(concat(buffers.slice(i, i + n)));
		}
		streams.push(stream);
		i += n;
	}
	let speed = 20;
	if (streams.length <= 1) {
		const avg = Math.floor(streams.reduce((n, s) => n + s.length, 0) / Math.max(1, buffers.length));
		const steps: [number, number][] = [[3000, 10], [2800, 15], [2500, 20], [2000, 25], [1500, 40], [1000, 45], [500, 55]];
		speed = steps.find(([limit]) => avg > limit)?.[1] ?? 60;
	}
	return { streams, speed };
}

/**
 * INQUIRY_STA reply: status bytes at [14..19] (count at [18..19]), battery millivolts at [24..25].
 * Every error stops the job; "ribbon end" (byte 0 bit 0x20) is ignored, as the E12 has no ribbon.
 */
export function parseE12Status(f: Uint8Array): PrinterStatus {
	const b = f.subarray(14, 20);
	const chain: [boolean, string][] = [
		[!!(b[2] & 0x08), 'Cover is open'],
		[!!(b[3] & 0x01), 'Label tape is not installed'],
		[!!(b[0] & 0x10), 'Label tape is not installed correctly'],
		[!!(b[0] & 0x02), 'No label detected'],
		[!!(b[0] & 0x04), 'Labels used up'],
		[!!(b[0] & 0x08), 'Label not recognized'],
		[!!(b[1] & 0x08), 'Print head is too hot']
	];
	const errors = chain.filter(([on]) => on).map(([, m]) => m);
	const warnings: string[] = [];
	if (b[0] & 0x40) warnings.push('Low battery, please charge');
	const s: PrinterStatus = {
		raw: f,
		bufferFull: !!(b[0] & 0x01),
		busy: !!(b[1] & 0x04),
		printing: !!(b[2] & 0x40),
		coverOpen: !!(b[2] & 0x08),
		charging: !!(b[2] & 0x10),
		pagesPrinted: (b[4] ?? 0) | ((b[5] ?? 0) << 8),
		errors,
		warnings
	};
	if (f.length >= 26) {
		const volts = (f[24] | (f[25] << 8)) / 1000;
		if (volts > 0) {
			s.batteryVolts = volts;
			s.batteryLevel = [3.7, 3.8, 3.9, 3.95].filter((v) => volts > v).length;
		}
	}
	return s;
}

export class E12BtDriver implements PrinterDriver {
	readonly family = 'e12' as const;
	readonly dpmm = 8;
	readonly headDots = E12_HEAD_DOTS;
	readonly channel: FrameChannel;
	/** Loaded tape from the last readMedia. */
	private media: { dieCut: boolean } | null = null;
	/** Compresses print buffers (replaceable for tests). */
	compress = e12Compress;

	constructor(
		transport: ByteTransport,
		/** Bluetooth name, e.g. "T0195A260420I470". */
		readonly deviceName = ''
	) {
		// supvan-e12 waits up to 4 s for every reply and for each data frame's acknowledgement.
		this.channel = new FrameChannel(transport, { acksDataFrames: true, commandTimeoutMs: 4000 });
	}

	canvasSize(label: LabelSpec) {
		return { width: Math.round(label.lengthMm * this.dpmm), height: Math.round(label.widthMm * this.dpmm) };
	}

	async getStatus(): Promise<PrinterStatus> {
		return parseE12Status(await this.channel.command(E12_CMD.INQUIRY_STA));
	}

	/** Poll status until the link carries replies (the first command after connecting may be lost). */
	async handshake(attempts = 6): Promise<PrinterStatus> {
		let last: unknown;
		for (let i = 0; i < attempts; i++) {
			try {
				return parseE12Status(await this.channel.command(E12_CMD.INQUIRY_STA, 0, 0, 1500, false));
			} catch (e) {
				last = e;
				await sleep(300);
			}
		}
		throw last instanceof Error ? last : new PrinterError('Printer did not respond over Bluetooth', 'timeout');
	}

	/**
	 * Loaded tape (RETURN_MAT), laid out like the T10 series': UUID [22..28], code [29..36], serial
	 * (the catalog ID) [37..38], type [39], width [40], length [41] and gap [42] in mm.
	 */
	async readMedia(): Promise<MediaInfo | null> {
		const f = await this.channel.command(E12_CMD.RETURN_MAT, 0, 0, undefined, false);
		if (f.length < 43) return null;
		const hex = (from: number, len: number) => Array.from(f.subarray(from, from + len), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
		const type = f[39];
		const dieCut = type === 1 || type === 129;
		this.media = { dieCut };
		const gap = f[42];
		return {
			labelId: f[37] | (f[38] << 8),
			paperType: dieCut ? 1 : 0,
			gap: gap > 8 ? 3 : gap,
			uuid: hex(22, 7),
			widthMm: f[40],
			lengthMm: f[41],
			raw: f
		};
	}

	private assertOk(s: PrinterStatus) {
		if (s.errors.length) throw new PrinterError(s.errors.join(', '), 'device');
	}

	/** Poll status every `ms` until `done`, failing on any printer error. */
	private async waitFor(done: (s: PrinterStatus) => boolean, what: string, polls: number, ms: number, signal?: AbortSignal) {
		let s: PrinterStatus | undefined;
		for (let i = 0; i < polls; i++) {
			if (signal?.aborted) throw new PrinterError('Cancelled', 'cancelled');
			s = await this.getStatus();
			this.assertOk(s);
			if (done(s)) return s;
			await sleep(ms, signal);
		}
		throw new PrinterError(`Timed out waiting for ${what}`, 'timeout');
	}

	async print(pages: Bitmap[], label: LabelSpec, opts: PrintOptions) {
		const { signal, onProgress } = opts;
		if (!pages.length) throw new PrinterError('Nothing to print', 'empty');
		const copies = Math.max(1, opts.copies | 0);
		const total = pages.length * copies;
		const density = Math.min(E12_DENSITY.max, Math.max(E12_DENSITY.min, Math.round(opts.density) || E12_DENSITY.default));
		const report = (phase: Parameters<NonNullable<PrintOptions['onProgress']>>[0]['phase'], page: number) =>
			onProgress?.({ phase, page, pages: total });

		report('preparing', 0);
		const clamp = (v = 0) => Math.max(-E12_OFFSET.max, Math.min(E12_OFFSET.max, Math.round(v)));
		const dieCut = this.media ? this.media.dieCut : label.paperType !== 0;
		const jobs = pages.map((p) =>
			chunkE12Buffers(buildE12Buffers(e12Raster(p, { dx: clamp(opts.offsetX), dy: clamp(opts.offsetY) }), { density, mat: dieCut ? 1 : 0 }), this.compress)
		);

		// Collated copies; like supvan-e12, every label is a job of its own.
		for (let n = 0; n < total; n++) {
			const { streams, speed } = jobs[n % pages.length];
			report('checking', n + 1);
			await this.channel.command(E12_CMD.CHECK_DEVICE);
			await this.waitFor((s) => !s.busy && !s.printing, 'the printer to be ready', 60, 100, signal);

			await this.channel.command(E12_CMD.START_PRINT, 0);
			try {
				await this.waitFor((s) => s.printing, 'the printer to start', 60, 100, signal);
				report('sending', n + 1);
				for (const stream of streams) {
					await this.waitFor((s) => !s.bufferFull, 'buffer space', 500, 20, signal);
					await this.channel.sendChunk(stream, signal);
					await sleep(20, signal);
					await this.channel.command(E12_CMD.BUF_FULL, stream.length, speed);
				}
				report('printing', n + 1);
				await this.waitFor((s) => !s.printing && !s.busy && !s.bufferFull, 'the label to print', 1200, 100, signal);
			} catch (e) {
				await this.stop().catch(() => {});
				throw e;
			}
		}
		report('done', total);
	}

	/** STOP if printing, then poll every 20 ms (up to 50 times) until it stops. */
	async stop() {
		let s = await this.getStatus();
		if (!s.printing) return;
		await this.channel.command(E12_CMD.STOP_PRINT);
		for (let i = 0; i < 50 && s.printing; i++) {
			await sleep(20);
			s = await this.getStatus();
		}
	}
}
