/**
 * T10/T15-series label makers: the Katasymbol/Supvan E10 and the T10, T10A, T11, T12, T10 Plus,
 * T10 Pro and T1. 96-dot head at 8 dots/mm (12 mm tape), Bluetooth only.
 *
 * Ported from the SUPRINT Android app (com.supvan.IPrinterEn 1.5.0): T15Print ("printing process"
 * 15, which every one of these models uses), BasePrint's framing and ImgConverter. The app talks to
 * them over classic Bluetooth (SPP) with the same `7E 5A` frames as the T50/T80, but the job differs:
 *   - the design is drawn into the middle 88 dots of the 96-dot head;
 *   - every 4000-byte buffer (up to 332 columns of 12 bytes) is its own LZMA stream, announced by
 *     0x5C(512, frames) and committed by BUF_FULL(0);
 *   - density goes out as a separate head-rate command (0xC9) before START_PRINT;
 *   - blank columns at the start of the first label are skipped and the tape is pulled back by
 *     PAPER_BACK (0xBA), so printing starts close to the cutter.
 */
import { sleep } from '../channel';
import { cropRowsCentered, fromBitmap, type Grid } from '../bitmap';
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

export const T15_CMD = { ...CMD, RD_DEV_NAME: 0x16, STRD_MAT: 0x18, PAPER_BACK: 0xba, SET_HEADRATE: 0xc9 } as const;

export const T15_HEAD_DOTS = 96;
/** Rows the app draws the design into, centered on the head (T15Print.initImageData scales to 88). */
export const T15_PRINT_DOTS = 88;
export const T15_DENSITY = { min: 1, max: 7, default: 4 };
/** Position offsets in dots, as both apps' print settings allow (BaseDevice position min/max). */
export const T15_OFFSET = { max: 9, dots: 1 };
const BUF_LENGTH = 4000;
const MAX_COLUMNS = 332;
const BYTES_PER_COLUMN = T15_HEAD_DOTS / 8;
/** Columns between the print head and the cutter, which the first label's blank start may use. */
const LEAD_COLUMNS = 48;

/**
 * Argument of the head-rate command (0xC9) for a density of 1..7: ((d - 1) / 10 + 0.8) * 100 in
 * float arithmetic, i.e. 80..140, apparently the print head's heat in percent. SUPRINT sends the
 * density as is to printers with a G in their Bluetooth name; the iOS app never does (10 * d + 70
 * for every name), and on a T0179G… E10 over BLE the raw value made darkness 1 and 7 look the same.
 */
export function t15HeadRate(density: number, deviceName = ''): number {
	if (deviceName.includes('G')) return density;
	const f = Math.fround(Math.fround(Math.fround((density - 1) / 10) + Math.fround(0.8)) * 100);
	return Math.trunc(f);
}

/**
 * Place a page on the 96-dot head like T15Print.initImageData, but at 1:1: the app scales its
 * bitmap to 88 rows, here the middle 88 rows of the design are kept and centered (4 blank rows
 * above and below for 12 mm tape). `left`/`top` shift the design in dots (the app's adjustments).
 */
export function t15Raster(page: Bitmap, adjust: { left?: number; top?: number } = {}): Grid {
	const g = cropRowsCentered(fromBitmap(page), T15_PRINT_DOTS);
	const cols = g.cols;
	const out = new Uint8Array(T15_HEAD_DOTS * cols);
	const top = ((T15_HEAD_DOTS - g.rows) >> 1) + (adjust.top ?? 0);
	const left = adjust.left ?? 0;
	for (let r = 0; r < g.rows; r++) {
		const y = top + r;
		if (y < 0 || y >= T15_HEAD_DOTS) continue;
		for (let c = 0; c < cols; c++) {
			const x = c + left;
			if (x >= 0 && x < cols && g.data[r * cols + c]) out[y * cols + x] = 1;
		}
	}
	return { rows: T15_HEAD_DOTS, cols, data: out };
}

/** 12 bytes per column, row r in byte r / 8, bit r % 8 (ImgConverter.GetAllBytes). */
function columnBytes(g: Grid): Uint8Array {
	const bytes = new Uint8Array(g.cols * BYTES_PER_COLUMN);
	for (let r = 0; r < g.rows; r++)
		for (let c = 0; c < g.cols; c++) if (g.data[r * g.cols + c]) bytes[c * BYTES_PER_COLUMN + (r >> 3)] |= 1 << (r & 7);
	return bytes;
}

export interface T15JobOptions {
	/** 1..7; also written into every buffer's page register. */
	density: number;
	/** Die-cut labels (the material type the printer reports is 1 or 129). */
	dieCut?: boolean;
	/** Gap between die-cut labels in mm, from the printer (default 3). */
	paperGap?: number;
	/** 0 (the app's default): cut flag on the last label; 1: never; 2: on every label. */
	cutMode?: number;
	/**
	 * Re-encode a buffer whose stream would start a 128-byte write with what looks like a frame
	 * marker (see avoidFrameMarkers), like the iOS app. Its streams only go out in such writes.
	 */
	avoidFrameMarkers?: boolean;
}

export interface T15Job {
	/** Raw 4000-byte buffers in send order (header + columns). */
	buffers: Uint8Array[];
	/** One LZMA stream per buffer. */
	streams: Uint8Array[];
	/** Buffers of each label. */
	perLabel: number[];
	/** Columns to pull the tape back before the first buffer (PAPER_BACK). */
	backFrames: number;
}

/**
 * LZMA with the Supvan settings (8 KB dictionary, no end marker). SUPRINT itself uses the LZMA SDK
 * 4.x Java encoder, whose match finder picks different matches on some buffers; the streams differ
 * but decode to the same bytes.
 */
export const t15Compress = (buf: Uint8Array): Uint8Array => Uint8Array.from(LZMA.compress(buf, 9) as number[], (b) => b & 0xff);

/**
 * Stream offsets that land 6 bytes into the 2nd, 3rd and 4th 128-byte write of the first data
 * frame, where a frame has its AA <cmd> marker, and the command bytes the iOS app avoids there
 * (T15Transfer @0x1002d851c): it bumps that byte of the buffer, a single dot, and compresses again,
 * apparently so the firmware can't take the write for a new frame.
 */
const MARKER_OFFSETS = [0x7a, 0xfa, 0x17a];
const MARKER_COMMANDS = new Set([0xbb, 0x06, 0xc7, 0x07]);

function avoidFrameMarkers(buf: Uint8Array, stream: Uint8Array, compress: (buf: Uint8Array) => Uint8Array): Uint8Array {
	const hits = MARKER_OFFSETS.filter((i) => stream[i] === 0xaa && MARKER_COMMANDS.has(stream[i + 1]));
	if (!hits.length) return stream;
	for (const i of hits) buf[i] = (buf[i] + 1) & 0xff;
	return compress(buf);
}

/**
 * Encode every label of a job (copies already expanded, in print order) like
 * T15Print.initEncodeData/initLZMAData. As in the app, one 4000-byte buffer is reused for the whole
 * job, so the unused tail of a label's last buffer keeps bytes from earlier buffers.
 */
export function encodeT15Job(labels: Grid[], opts: T15JobOptions, compress = t15Compress): T15Job {
	const density = opts.density & 0xff;
	const cutMode = opts.cutMode ?? 0;
	const buf = new Uint8Array(BUF_LENGTH);
	const job: T15Job = { buffers: [], streams: [], perLabel: [], backFrames: 0 };

	labels.forEach((g, n) => {
		const last = n === labels.length - 1;
		const cut = cutMode === 2 ? 2 : cutMode === 0 && last ? 1 : 0;
		const bytes = columnBytes(g);
		const total = g.cols;
		const column = (i: number) => (i >= 0 && i < total ? bytes.subarray(i * BYTES_PER_COLUMN, (i + 1) * BYTES_PER_COLUMN) : null);
		const inked = (i: number) => !!column(i)?.some((b) => b);
		/** ImgConverter.GetNoZeroIndex(0, limit): one before the first inked column, at most limit - 1. */
		const firstInk = (limit: number) => {
			let i = 0;
			while (i < limit && !inked(i)) i++;
			if (i > 0) i--;
			return i >= limit ? limit - 1 : i;
		};

		let current = 0;
		let left = total;
		let count = 0;
		while (current !== total) {
			let skip = 0;
			let pageStart = false;
			let pageEnd = false;
			if (current === 0) {
				pageStart = true;
				if (n === 0) {
					const limit = opts.dieCut ? Math.trunc((6.5 - (opts.paperGap ?? 3)) * 8) : LEAD_COLUMNS;
					skip = firstInk(limit);
					job.backFrames = skip >= limit - 1 ? 0 : limit - skip;
					// The app would loop forever on labels shorter than the skipped start; keep one column.
					skip = Math.max(0, Math.min(skip, total - 1));
					current = skip;
				}
			}
			left -= skip;
			let cols: number;
			if (left > MAX_COLUMNS) {
				left -= MAX_COLUMNS;
				cols = MAX_COLUMNS;
				for (let k = 0; k < cols; k++) {
					const c = column(current);
					if (c) {
						buf.set(c, 14 + k * BYTES_PER_COLUMN);
						current++;
					}
				}
			} else {
				pageEnd = true;
				cols = left;
				for (let k = 0; k < cols; k++) {
					const c = column(current);
					if (c) buf.set(c, 14 + k * BYTES_PER_COLUMN);
					current++;
				}
			}
			// Page register (PAGE_REG_BITS.toByteArray): start/end/job end, cut, density, material 1.
			buf[2] = (pageStart ? 0x02 : 0) | (pageEnd ? 0x04 : 0) | (pageEnd && last ? 0x08 : 0) | ((cut & 7) << 4);
			buf[3] = ((density << 2) | (1 << 4)) & 0xff;
			buf[4] = cols & 0xff;
			buf[5] = (cols >> 8) & 0xff;
			buf[6] = BYTES_PER_COLUMN;
			buf[8] = 1;
			buf[9] = 0;
			buf[10] = 1;
			buf[11] = 0;
			buf[12] = skip & 0xff;
			buf[13] = 0;
			// Checksum: header bytes 2..13 plus the last byte of every full 256-byte block.
			const len = cols * BYTES_PER_COLUMN + 14;
			let sum = 0;
			for (let j = 2; j < 14; j++) sum += buf[j];
			for (let k = 1; k <= Math.floor(len / 256); k++) sum += buf[k * 256 - 1];
			buf[0] = sum & 0xff;
			buf[1] = (sum >> 8) & 0xff;
			let stream = compress(buf);
			if (opts.avoidFrameMarkers) stream = avoidFrameMarkers(buf, stream, compress);
			job.buffers.push(buf.slice());
			job.streams.push(stream);
			count++;
		}
		job.perLabel.push(count);
	});
	return job;
}

/**
 * Data frames of one stream like T15Print.transfer: AA BB <sum LE> <index> <count> <500 bytes>,
 * sum over index..end, behind the 7E 5A FC 01 10 02 header. The app reuses one frame buffer, so the
 * unused end of the last frame repeats the previous frame's bytes (and counts in its checksum).
 */
export function t15DataFrames(stream: Uint8Array): Uint8Array[] {
	const count = Math.ceil(stream.length / 500);
	const inner = new Uint8Array(506);
	inner[0] = 0xaa;
	inner[1] = 0xbb;
	const frames: Uint8Array[] = [];
	for (let i = 0; i < count; i++) {
		inner[4] = i & 0xff;
		inner[5] = count & 0xff;
		inner.set(stream.subarray(i * 500, Math.min(stream.length, (i + 1) * 500)), 6);
		let sum = 0;
		for (let j = 4; j < 506; j++) sum += inner[j];
		inner[2] = sum & 0xff;
		inner[3] = (sum >> 8) & 0xff;
		const f = new Uint8Array(512);
		f.set([0x7e, 0x5a, 0xfc, 0x01, 0x10, 0x02]);
		f.set(inner, 6);
		frames.push(f);
	}
	return frames;
}

/** Battery bars (0..4) and whether to warn, from T15Print.getState's one- or two-cell scale. */
function battery(volts: number, twoCell: boolean): { level: number; low: boolean } {
	if (twoCell) {
		if (volts > 5 && volts <= 6.8) return { level: 0, low: true };
		if (volts > 6.8 && volts <= 7.4) return { level: 1, low: false };
		if (volts > 7.4 && volts <= 7.6) return { level: 2, low: false };
		if (volts > 7.6 && volts <= 7.88) return { level: 3, low: false };
		return { level: 4, low: false };
	}
	if (volts > 2 && volts <= 3.7) return { level: 0, low: false };
	if (volts > 3.7 && volts <= 3.8) return { level: 1, low: true };
	if (volts > 3.8 && volts <= 3.9) return { level: 2, low: false };
	if (volts > 3.9 && volts <= 3.95) return { level: 3, low: false };
	return { level: 4, low: false };
}

/** Two-cell battery scale for names with A, B or D in them (T15Print.getState). */
const twoCellBattery = (name: string) => /[ABD]/.test(name);

/**
 * INQUIRY_STA reply: status bytes at [14..19], battery millivolts at [24..25]. Errors follow
 * T15Print.getState's else-if chain; every one of them stops the app from printing.
 */
export function parseT15Status(f: Uint8Array, deviceName = ''): PrinterStatus {
	const b = f.subarray(14, 20);
	const errors: string[] = [];
	const warnings: string[] = [];
	const chain: [boolean, string][] = [
		[!!(b[0] & 0x10), 'Label tape is not installed'],
		[!!(b[0] & 0x40), 'Low battery, please charge'],
		[!!(b[2] & 0x08), 'Cover is open'],
		[!!(b[0] & 0x02) || !!(b[3] & 0x01), 'No label detected'],
		[!!(b[0] & 0x04), 'Labels used up']
	];
	const printing = !!(b[2] & 0x40);
	const hit = printing ? undefined : chain.find(([on]) => on);
	if (hit) errors.push(hit[1]);
	if (b[0] & 0x08) warnings.push('Label not recognized');
	const s: PrinterStatus = {
		raw: f,
		bufferFull: !!(b[0] & 0x01),
		busy: !!(b[1] & 0x04),
		printing,
		coverOpen: !!(b[2] & 0x08),
		charging: !!(b[2] & 0x10),
		pagesPrinted: b[4] | (b[5] << 8),
		errors,
		warnings
	};
	if (f.length >= 26) {
		// Like the app, round to hundredths of a volt before comparing.
		const volts = Math.round((f[24] | (f[25] << 8)) / 10) / 100;
		if (volts > 0) {
			const { level, low } = battery(volts, twoCellBattery(deviceName));
			s.batteryVolts = volts;
			s.batteryLevel = level;
			if (low && !errors.length) warnings.push('Low battery, please charge');
		}
	}
	return s;
}

/**
 * T15Print.devCheckErrMsg: what stops a job. Before the job only the label and cover checks
 * apply; while sending, the printer also must not have dropped out of printing.
 */
function printError(s: PrinterStatus, running: boolean): string | null {
	const b = s.raw.subarray(14, 20);
	if (b[2] & 0x08) return 'Cover is open';
	if (b[3] & 0x01) return 'No label detected';
	if (b[0] & 0x02) return 'No label detected';
	if (b[0] & 0x04) return 'Labels used up';
	if (b[0] & 0x10) return 'Label tape is not installed';
	if (running && !s.busy && !s.printing) return 'Printing was stopped on the device';
	return null;
}

/**
 * How each link is driven. Classic Bluetooth follows SUPRINT (Android), BLE the iOS app, the only
 * official client that reaches these printers over BLE: it retries only status requests, waits up
 * to 6 s for the printer, and sends each data frame as four 128-byte writes 10 ms apart. Both apps
 * abort a transfer when a data frame gets no reply.
 */
const LINKS = {
	spp: { channel: { acksDataFrames: true, strictAcks: true }, polls: 20, pollMs: 100 },
	ble: { channel: { acksDataFrames: true, strictAcks: true, commandTimeoutMs: 4000 }, polls: 30, pollMs: 200 }
} as const;

export type T15Link = keyof typeof LINKS;

export class T15BtDriver implements PrinterDriver {
	readonly family = 't15' as const;
	readonly dpmm = 8;
	readonly headDots = T15_HEAD_DOTS;
	readonly channel: FrameChannel;
	/** Loaded tape from the last readMedia (T15Print.getMaterial's type and paperGap). */
	private media: { dieCut: boolean; gap: number } | null = null;
	/** Compresses each print buffer (replaceable for tests). */
	compress = t15Compress;

	constructor(
		transport: ByteTransport,
		/**
		 * Bluetooth name (e.g. "T0126…"), or over classic Bluetooth the RD_DEV_NAME reply (e.g.
		 * "E10pro"): picks the battery scale, the head rate and how data frames are written.
		 */
		readonly deviceName = '',
		readonly link: T15Link = 'spp'
	) {
		this.channel = new FrameChannel(transport, LINKS[link].channel);
	}

	canvasSize(label: LabelSpec) {
		return { width: Math.round(label.lengthMm * this.dpmm), height: Math.round(label.widthMm * this.dpmm) };
	}

	/**
	 * Send a command and wait for its reply. SUPRINT retries every command once (BasePrint.sendCmd);
	 * over BLE only status requests are retried, so a late reply can't make START or BUF_FULL run
	 * twice.
	 */
	private cmd(command: number, a = 0, b = 0, timeoutMs?: number) {
		const retry = this.link === 'spp' || command === T15_CMD.INQUIRY_STA;
		return this.channel.command(command, a, b, timeoutMs, retry);
	}

	async getStatus(): Promise<PrinterStatus> {
		return parseT15Status(await this.cmd(T15_CMD.INQUIRY_STA), this.deviceName);
	}

	/** Poll status until the link carries replies (the first command after connecting is often lost). */
	async handshake(attempts = 6): Promise<PrinterStatus> {
		let last: unknown;
		for (let i = 0; i < attempts; i++) {
			try {
				return parseT15Status(await this.channel.command(T15_CMD.INQUIRY_STA, 0, 0, 1500, false), this.deviceName);
			} catch (e) {
				last = e;
				await sleep(300);
			}
		}
		throw last instanceof Error ? last : new PrinterError('Printer did not respond over Bluetooth', 'timeout');
	}

	/**
	 * Loaded tape (T15Print.getMaterial): skipped while the printer is busy. The app asks the
	 * printer to read the label again (STRD_MAT) after every read; the iOS app doesn't need a reply.
	 */
	async readMedia(): Promise<MediaInfo | null> {
		const s = await this.getStatus();
		if (s.busy) return null;
		const f = await this.channel.command(T15_CMD.RETURN_MAT, 0, 0, undefined, false);
		const hex = (from: number, len: number) => Array.from(f.subarray(from, from + len), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
		const type = f[39] ?? 0;
		const gap = f[42] ?? 0;
		const media = { dieCut: type === 1 || type === 129, gap: gap > 8 ? 3 : gap };
		this.media = media;
		await this.channel.command(T15_CMD.STRD_MAT, 0, 0, 1000, false).catch(() => {});
		return {
			labelId: (f[37] ?? 0) | ((f[38] ?? 0) << 8),
			paperType: media.dieCut ? 1 : 0,
			gap: media.gap,
			uuid: hex(22, 7),
			widthMm: Math.min(15, f[40] ?? 0),
			lengthMm: f[41] ?? 0,
			raw: f
		};
	}

	/**
	 * One stream (T15Print.transfer): announce the frames, send them, then BUF_FULL(0). Over BLE each
	 * frame goes out as four 128-byte writes 10 ms apart (iOS). Over classic Bluetooth, names with an
	 * E get the same with 50 ms pauses between the writes, others one 512-byte write (SUPRINT).
	 */
	private async transfer(stream: Uint8Array, signal?: AbortSignal) {
		const frames = t15DataFrames(stream);
		await this.channel.command(T15_CMD.NEXTFRM_BULK, 512, frames.length, undefined, false);
		const pacing = this.link === 'ble' ? { pieceSize: 128 } : this.deviceName.includes('E') ? { pieceSize: 128, pauseMs: 50 } : { pieceSize: 512 };
		await this.channel.sendFrames(frames, pacing, signal);
		await sleep(50, signal);
		await this.cmd(T15_CMD.BUF_FULL, 0);
	}

	async print(pages: Bitmap[], label: LabelSpec, opts: PrintOptions) {
		const { signal, onProgress } = opts;
		const copies = Math.max(1, opts.copies | 0);
		const total = pages.length * copies;
		const density = Math.min(T15_DENSITY.max, Math.max(T15_DENSITY.min, Math.round(opts.density) || T15_DENSITY.default));
		const report = (phase: Parameters<NonNullable<PrintOptions['onProgress']>>[0]['phase'], page: number) =>
			onProgress?.({ phase, page, pages: total });
		const { polls, pollMs } = LINKS[this.link];

		report('preparing', 0);
		// Offsets are in dots here, within the apps' -9..9.
		const clamp = (v = 0) => Math.max(-T15_OFFSET.max, Math.min(T15_OFFSET.max, Math.round(v)));
		const rasters = pages.map((p) => t15Raster(p, { left: clamp(opts.offsetX), top: clamp(opts.offsetY) }));
		// Collated copies, like the app with "copy print" on.
		const labels: Grid[] = [];
		for (let c = 0; c < copies; c++) labels.push(...rasters);
		// Like the app, the loaded tape decides die-cut and gap; without a reading, the chosen label.
		const dieCut = this.media ? this.media.dieCut : label.paperType === 1 || label.paperType === 2;
		const paperGap = this.media ? this.media.gap : label.gap || 3;
		const job = encodeT15Job(labels, { density, dieCut, paperGap, cutMode: opts.cutType ?? 0, avoidFrameMarkers: this.link === 'ble' }, this.compress);

		// 1. Wait for the printer to be idle (the apps go on regardless), then check it can print.
		report('checking', 0);
		let s: PrinterStatus | undefined;
		for (let i = 0; i < polls; i++) {
			await sleep(pollMs, signal);
			s = await this.getStatus();
			if (!s.busy) break;
		}
		const err = s && printError(s, false);
		if (err) throw new PrinterError(err, 'device');

		// 2. Density and start. Neither app minds a missing reply to the density command.
		const headRate = t15HeadRate(density, this.link === 'spp' ? this.deviceName : '');
		await this.cmd(T15_CMD.SET_HEADRATE, headRate).catch(() => {});
		await this.cmd(T15_CMD.START_PRINT, 0);
		try {
			for (let i = 0; i < polls; i++) {
				await sleep(pollMs, signal);
				s = await this.getStatus();
				if (s.printing) break;
			}
			if (!s?.printing) throw new PrinterError('Printer did not start printing', 'timeout');
			// Neither app checks the reply to PAPER_BACK either.
			await this.cmd(T15_CMD.PAPER_BACK, job.backFrames).catch(() => {});

			// 3. Every 20 ms: status, then the next buffer once the printer has room.
			let n = 0;
			for (let label = 0; label < job.perLabel.length; label++) {
				report('sending', label + 1);
				for (let k = 0; k < job.perLabel[label]; k++, n++) {
					for (;;) {
						await sleep(20, signal);
						s = await this.getStatus();
						const err = printError(s, true);
						if (err) throw new PrinterError(err, err.startsWith('Printing was stopped') ? 'stopped' : 'device');
						if (!s.bufferFull) break;
					}
					await this.transfer(job.streams[n], signal);
				}
			}

			// 4. Wait for the printer to finish (100 ms polls).
			report('printing', total);
			for (let tries = 0; ; tries++) {
				await sleep(100, signal);
				s = await this.getStatus();
				if (s.raw[14] & 0x10) throw new PrinterError('Install the label tape correctly', 'device');
				report('printing', Math.min(total, s.pagesPrinted + 1));
				if (!s.printing && !s.busy) break;
				if (tries >= 1200) throw new PrinterError('Printer did not finish printing', 'timeout');
			}
			report('done', total);
		} catch (e) {
			await this.stop().catch(() => {});
			throw e;
		}
	}

	/** stopPrint: STOP if printing, then poll every 20 ms (up to 50 times) until it stops. */
	async stop() {
		let s = await this.getStatus();
		if (!s.printing) return;
		await this.cmd(T15_CMD.STOP_PRINT);
		for (let i = 0; i < 50 && s.printing; i++) {
			await sleep(20);
			s = await this.getStatus();
		}
	}
}
