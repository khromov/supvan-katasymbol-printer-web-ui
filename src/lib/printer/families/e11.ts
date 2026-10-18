/**
 * E11 label maker (Katasymbol/Supvan E11, printer type 3601). 96-dot head at 8 dots/mm, Bluetooth LE
 * only, the E10's tapes.
 *
 * Ported from G15Print, the code the Katasymbol (com.supvan.katasymbol 1.4.29) and SUPRINT
 * (com.supvan.IPrinterEn 1.5.0) Android apps use for the E11 and E12 ("printing process" 4, always
 * over BLE). Same `7E 5A` frames as the T50/T80, and a job much like the E10's (T15Print):
 *   - one CHECK_DEVICE / START_PRINT for the whole job; every label opens with PageSt and closes
 *     with PageEnd, and only the job's last buffer has PrtEnd;
 *   - the design is the middle 88 dots of the 96-dot head, at 1:1, not turned or mirrored;
 *   - the first and last 2 mm of a label aren't sent: the margins in each buffer header tell the
 *     printer to feed them blank;
 *   - every 4000-byte buffer (up to 332 columns of 12 bytes) is its own LZMA stream, announced by
 *     0x5C(512, frames) and committed by BUF_FULL(0); the printer answers every data frame;
 *   - density only goes in the buffers' page register (no head-rate command, no speed), and the
 *     print position goes to the printer (0x38 / 0x39) instead of moving the dots.
 */
import { sleep } from '../channel';
import { cropRowsCentered, fromBitmap, type Grid } from '../bitmap';
import type { ByteTransport } from '../serial';
import { CMD } from './t5080';
import { FrameChannel, type FrameChannelOptions } from './t5080-bt';
import { t15Compress, t15DataFrames } from './t15';
import {
	PrinterError,
	type Bitmap,
	type LabelSpec,
	type MediaInfo,
	type PrinterDriver,
	type PrinterStatus,
	type PrintOptions
} from '../types';

export const E11_CMD = { ...CMD, STRD_MAT: 0x18, READ_DPI: 0x22, BLT_CONTROL: 0x37, SET_H_SHIFT: 0x38, SET_V_SHIFT: 0x39 } as const;

export const E11_HEAD_DOTS = 96;
/** Rows the apps draw the design into (11 mm, DensityUtil.byDeviceTypeSetLabelHeight), centred on the head. */
export const E11_PRINT_DOTS = 88;
/** BaseDevice concentration 1..7, default 4 (SUPRINT's print settings; written raw into each buffer). */
export const E11_DENSITY = { min: 1, max: 7, default: 4 };
/**
 * What a print position step is multiplied by for 0x38 / 0x39. SUPRINT's editor and Katasymbol's
 * older editors double it, Katasymbol's main (Kata) editor sends it as is; the apps read it back
 * halved (0x24 / 0x26). Unverified on a printer.
 */
const OFFSET_SCALE = 2;
/**
 * BaseDevice print position -9..9, sent to the printer rather than applied to the dots. The dots
 * per step assume the firmware counts dots (the apps show bare numbers).
 */
export const E11_OFFSET = { max: 9, dots: OFFSET_SCALE };
const BUF_LENGTH = 4000;
const MAX_COLUMNS = 332;
const BYTES_PER_COLUMN = E11_HEAD_DOTS / 8;
/**
 * Page register byte 3 bits 0..1 (FirstCut): the editors pass their "first paragraph white space"
 * setting minus one, which is -1 by default.
 */
const FIRST_CUT = 3;

/**
 * Blank millimetres at each end of a label that aren't sent: the editors' paint area is the label
 * length less DensityUtil.getPaintViewMarginBetweenValue, which is 4 mm at any length for the
 * E10/T10/E11 series, centred. The same 2 mm is the margin G15Print gets for continuous tape.
 */
export const E11_END_MARGIN_MM = 2;

/**
 * Place a page on the 96-dot head like G15Print.initImageData: the middle 88 rows of the design,
 * centred, without the `endDots` columns at either end. Column 0 (the design's left edge) prints
 * first and row 0 is dot 0, as on the E10.
 */
export function e11Raster(page: Bitmap, endDots: number): Grid {
	const g = cropRowsCentered(fromBitmap(page), E11_PRINT_DOTS);
	const cols = g.cols - 2 * endDots;
	if (cols <= 0) throw new PrinterError('The label is shorter than its blank ends', 'empty');
	const out = new Uint8Array(E11_HEAD_DOTS * cols);
	const top = (E11_HEAD_DOTS - g.rows) >> 1;
	for (let r = 0; r < g.rows; r++)
		for (let c = 0; c < cols; c++) if (g.data[r * g.cols + c + endDots]) out[(top + r) * cols + c] = 1;
	return { rows: E11_HEAD_DOTS, cols, data: out };
}

/**
 * Margin fields of the buffer header, in dots (G15Print.initLZMADataB, in Java float arithmetic):
 * continuous tape (the label's paper type 3) gets the end margin times the printer's dots per mm on
 * both sides, die-cut labels whatever the label length leaves around the image, at least 4.
 */
export function e11Margins(lengthMm: number, cols: number, continuous: boolean, dpmm = 8): [number, number] {
	const f = Math.fround(dpmm);
	if (continuous) {
		const m = Math.trunc(Math.fround(E11_END_MARGIN_MM * f));
		return [m, m];
	}
	const span = Math.fround(Math.fround(lengthMm * f) - cols);
	const left = Math.trunc(Math.fround(span / 2));
	const right = Math.trunc(Math.fround(span - left));
	return [Math.max(4, left), Math.max(4, right)];
}

/** 12 bytes per column, row r in byte r / 8, bit r % 8 (ImgConverter.GetAllBytes). */
function columnBytes(g: Grid): Uint8Array {
	const bytes = new Uint8Array(g.cols * BYTES_PER_COLUMN);
	for (let r = 0; r < g.rows; r++)
		for (let c = 0; c < g.cols; c++) if (g.data[r * g.cols + c]) bytes[c * BYTES_PER_COLUMN + (r >> 3)] |= 1 << (r & 7);
	return bytes;
}

export interface E11LabelOptions {
	/** 1..7, the page register's Nodu. */
	density: number;
	/** The job's last label: its last buffer ends the job (PrtEnd). */
	last: boolean;
	/** Left and right margin fields in dots (e11Margins). */
	margins: [number, number];
}

/**
 * One label's print buffers and their LZMA streams (G15Print.initLZMADataB). The 4000-byte buffer
 * is cleared for every label but not between its buffers, so a short last buffer keeps columns of
 * the one before beyond its length; every stream is the whole 4000 bytes.
 */
export function encodeE11Label(g: Grid, opts: E11LabelOptions, compress = t15Compress): { buffers: Uint8Array[]; streams: Uint8Array[] } {
	const density = opts.density & 0xff;
	const [left, right] = opts.margins;
	const bytes = columnBytes(g);
	const buf = new Uint8Array(BUF_LENGTH);
	const buffers: Uint8Array[] = [];
	const streams: Uint8Array[] = [];
	for (let current = 0; current < g.cols; ) {
		const pageStart = current === 0;
		const cols = Math.min(MAX_COLUMNS, g.cols - current);
		const pageEnd = current + cols === g.cols;
		buf.set(bytes.subarray(current * BYTES_PER_COLUMN, (current + cols) * BYTES_PER_COLUMN), 14);
		current += cols;
		// Page register (PAGE_REG_BITS.toByteArray(6)): start/end/job end, cut 0, no paper saving;
		// first cut, density and material 1.
		buf[2] = (pageStart ? 0x02 : 0) | (pageEnd ? 0x04 : 0) | (pageEnd && opts.last ? 0x08 : 0);
		buf[3] = (FIRST_CUT | (density << 2) | (1 << 6)) & 0xff;
		buf[4] = cols & 0xff;
		buf[5] = (cols >> 8) & 0xff;
		buf[6] = BYTES_PER_COLUMN;
		buf[8] = left & 0xff;
		buf[9] = (left >> 8) & 0xff;
		buf[10] = right & 0xff;
		buf[11] = (right >> 8) & 0xff;
		// Checksum: header bytes 2..13 plus the last byte of every full 256-byte block.
		const len = cols * BYTES_PER_COLUMN + 14;
		let sum = 0;
		for (let j = 2; j < 14; j++) sum += buf[j];
		for (let k = 1; k <= Math.floor(len / 256); k++) sum += buf[k * 256 - 1];
		buf[0] = sum & 0xff;
		buf[1] = (sum >> 8) & 0xff;
		buffers.push(buf.slice());
		streams.push(compress(buf));
	}
	return { buffers, streams };
}

/** Battery bars (0..4) and whether to warn, from G15Print.getE11State's one- or two-cell scale. */
function battery(volts: number): { level: number; low: boolean } {
	// The app picks the two-cell scale for names with an A or B, which most E11 names have, though
	// the printer reports one cell (around 4 V); going by the voltage avoids showing 4 bars always.
	if (volts > 5) {
		const level = [6.8, 7.4, 7.6, 7.88].filter((v) => volts > v).length;
		return { level, low: level === 0 };
	}
	const level = [3.7, 3.8, 3.9, 3.95].filter((v) => volts > v).length;
	return { level, low: level === 1 };
}

/**
 * G15Print.devE11CheckErrMsg: what stops a job. While sending, the printer also must not have
 * dropped out of printing.
 */
function printError(s: PrinterStatus, sending: boolean): string | null {
	const b = s.raw.subarray(14, 20);
	if (b[2] & 0x08) return 'Cover is open';
	if (b[3] & 0x01) return 'No label tape installed';
	if (b[0] & 0x02) return 'No label tape installed';
	if (b[0] & 0x04) return 'Labels used up';
	if (b[0] & 0x40) return 'Low battery, please charge';
	if (sending && !s.busy && !s.printing) return 'Printing was stopped on the device';
	return null;
}

/**
 * INQUIRY_STA reply: status bytes at [14..19] (pages printed at [18..19]), battery millivolts at
 * [24..25]. A tape the printer doesn't recognise (bit 0x08 of byte 14, PrinterStateInfo.IsReal) is
 * only a warning: the apps ask before printing on it ("Continue printing"), and the job itself
 * doesn't check it.
 */
export function parseE11Status(f: Uint8Array): PrinterStatus {
	const b = f.subarray(14, 20);
	const s: PrinterStatus = {
		raw: f,
		bufferFull: !!(b[0] & 0x01),
		busy: !!(b[1] & 0x04),
		printing: !!(b[2] & 0x40),
		coverOpen: !!(b[2] & 0x08),
		charging: !!(b[2] & 0x10),
		pagesPrinted: (b[4] ?? 0) | ((b[5] ?? 0) << 8),
		errors: [],
		warnings: []
	};
	const err = printError(s, false);
	if (err) s.errors.push(err);
	if (b[0] & 0x08) s.warnings.push('Label not recognized');
	if (f.length >= 26) {
		// Like the app, round to hundredths of a volt before comparing.
		const volts = Math.round((f[24] | (f[25] << 8)) / 10) / 100;
		if (volts > 0) {
			const { level, low } = battery(volts);
			s.batteryVolts = volts;
			s.batteryLevel = level;
			if (low && !s.errors.length) s.warnings.push('Low battery, please charge');
		}
	}
	return s;
}

export class E11BtDriver implements PrinterDriver {
	readonly family = 'e11' as const;
	readonly dpmm = 8;
	readonly headDots = E11_HEAD_DOTS;
	readonly channel: FrameChannel;
	/** Compresses each print buffer (replaceable for tests). */
	compress = t15Compress;

	constructor(
		transport: ByteTransport,
		/** Bluetooth name, e.g. "T0138A…". */
		readonly deviceName = '',
		channelOptions: FrameChannelOptions = {}
	) {
		// The app waits up to 4 s for every reply and 40 s for each data frame's.
		this.channel = new FrameChannel(transport, { acksDataFrames: true, strictAcks: true, commandTimeoutMs: 4000, ackTimeoutMs: 40000, ...channelOptions });
	}

	canvasSize(label: LabelSpec) {
		return { width: Math.round(label.lengthMm * this.dpmm), height: Math.round(label.widthMm * this.dpmm) };
	}

	/**
	 * Send a command and wait for its reply. Over BLE the app never retries; only status requests
	 * are retried here, so a late reply can't make START or BUF_FULL run twice.
	 */
	private cmd(command: number, a = 0, b = 0, timeoutMs?: number) {
		return this.channel.command(command, a, b, timeoutMs, command === E11_CMD.INQUIRY_STA);
	}

	async getStatus(): Promise<PrinterStatus> {
		return parseE11Status(await this.cmd(E11_CMD.INQUIRY_STA));
	}

	/** Poll status until the link carries replies (the first command after connecting may be lost). */
	async handshake(attempts = 6): Promise<PrinterStatus> {
		let last: unknown;
		for (let i = 0; i < attempts; i++) {
			try {
				return parseE11Status(await this.channel.command(E11_CMD.INQUIRY_STA, 0, 0, 1500, false));
			} catch (e) {
				last = e;
				await sleep(300);
			}
		}
		throw last instanceof Error ? last : new PrinterError('Printer did not respond over Bluetooth', 'timeout');
	}

	/**
	 * Loaded tape (G15Print.getE11Material): UUID [22..28], code [29..36], serial (the catalog ID)
	 * [37..38], type [39], width [40] (at most 15) and length [41] in mm, gap [42]. The app then has
	 * the printer read the tape again (STRD_MAT), without looking at the reply.
	 */
	async readMedia(): Promise<MediaInfo | null> {
		const f = await this.cmd(E11_CMD.RETURN_MAT);
		await this.cmd(E11_CMD.STRD_MAT, 0, 0, 1000).catch(() => {});
		if (f.length < 43) return null;
		const hex = (from: number, len: number) => Array.from(f.subarray(from, from + len), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
		const labelId = f[37] | (f[38] << 8);
		// A tape without a chip reads as an all-zero code; the app then keeps the tape it had (or
		// 25001), unless the serial is the custom-tape code 21930. Keep whatever label is chosen.
		if (hex(29, 8).startsWith('0000000000000') && labelId !== 21930) return null;
		const type = f[39];
		const dieCut = type === 1 || type === 129;
		const gap = f[42];
		return {
			labelId,
			paperType: dieCut ? 1 : 0,
			gap: gap > 8 ? 3 : gap,
			uuid: hex(22, 7),
			widthMm: Math.min(15, f[40]),
			lengthMm: f[41],
			raw: f
		};
	}

	/** Dots per mm the printer reports (CMD_READ_DPI, hundredths at [22..23]); 8 unless 7.00..8.00. */
	private async readDpi(): Promise<number> {
		const f = await this.cmd(E11_CMD.READ_DPI).catch(() => null);
		const v = f && f.length >= 24 ? f[22] | (f[23] << 8) : 0;
		return v >= 700 && v <= 800 ? v / 100 : 8;
	}

	/** Poll every 20 ms until the printer has room for a buffer, failing on any printer error. */
	private async waitForBuffer(signal?: AbortSignal) {
		for (;;) {
			await sleep(20, signal);
			const s = await this.getStatus();
			const err = printError(s, true);
			if (err) throw new PrinterError(err, err.startsWith('Printing was stopped') ? 'stopped' : 'device');
			if (!s.bufferFull) return;
		}
	}

	/** One stream (G15Print.transfer): announce it, each frame as four 128-byte writes 50 ms apart, then BUF_FULL(0). */
	private async transfer(stream: Uint8Array, signal?: AbortSignal) {
		const frames = t15DataFrames(stream);
		await this.cmd(E11_CMD.NEXTFRM_BULK, 512, frames.length);
		await this.channel.sendFrames(frames, { pieceSize: 128, pauseMs: 50 }, signal);
		await sleep(20, signal);
		await this.cmd(E11_CMD.BUF_FULL, 0);
	}

	async print(pages: Bitmap[], label: LabelSpec, opts: PrintOptions) {
		const { signal, onProgress } = opts;
		if (!pages.length) throw new PrinterError('Nothing to print', 'empty');
		const copies = Math.max(1, opts.copies | 0);
		const total = pages.length * copies;
		const density = Math.min(E11_DENSITY.max, Math.max(E11_DENSITY.min, Math.round(opts.density) || E11_DENSITY.default));
		const report = (phase: Parameters<NonNullable<PrintOptions['onProgress']>>[0]['phase'], page: number) =>
			onProgress?.({ phase, page, pages: total });
		const clamp = (v = 0) => Math.max(-E11_OFFSET.max, Math.min(E11_OFFSET.max, Math.round(v)));

		report('preparing', 0);
		const endDots = E11_END_MARGIN_MM * this.dpmm;
		const rasters = pages.map((p) => e11Raster(p, endDots));
		const continuous = label.paperType === 0;

		// 1. Like the editors: read the tape, BLT control (0x37), then the print position; none of
		//    them check the replies.
		report('checking', 0);
		await this.readMedia().catch(() => null);
		await this.cmd(E11_CMD.BLT_CONTROL).catch(() => {});
		await this.cmd(E11_CMD.SET_H_SHIFT, clamp(opts.offsetX) * OFFSET_SCALE).catch(() => {});
		await this.cmd(E11_CMD.SET_V_SHIFT, clamp(opts.offsetY) * OFFSET_SCALE).catch(() => {});

		// 2. G15Print.doPrint: not while printing; CHECK_DEVICE, then up to 6 s for the printer to be
		//    idle (stopping a job it is still running), the error checks and the dot pitch.
		let s = await this.getStatus();
		if (s.printing) throw new PrinterError('The printer is busy', 'busy');
		await this.cmd(E11_CMD.CHECK_DEVICE);
		for (let i = 0; i < 60; i++) {
			await sleep(100, signal);
			s = await this.getStatus();
			if (s.printing) await this.cmd(E11_CMD.STOP_PRINT).catch(() => {});
			if (!s.busy) break;
		}
		if (s.busy) throw new PrinterError('Timed out waiting for the printer to be ready', 'timeout');
		const err = printError(s, false);
		if (err) throw new PrinterError(err, 'device');
		const dpmm = await this.readDpi();

		// 3. START_PRINT(0) and up to 6 s for the printer to report printing.
		await this.cmd(E11_CMD.START_PRINT, 0);
		try {
			for (let i = 0; i < 60; i++) {
				await sleep(100, signal);
				s = await this.getStatus();
				if (s.printing) break;
			}
			if (!s.printing) throw new PrinterError('Printer did not start printing', 'timeout');

			// 4. Collated copies (the apps' "copy print"). The app asks for status before each label (for
			//    a dot pitch change the E11 doesn't report), then sends every buffer once there's room.
			const encoded = new Map<number, Uint8Array[]>();
			for (let n = 0; n < total; n++) {
				const page = n % pages.length;
				const last = n === total - 1;
				report('sending', n + 1);
				await this.getStatus();
				const key = last ? -1 : page;
				let streams = encoded.get(key);
				if (!streams) {
					const g = rasters[page];
					streams = encodeE11Label(g, { density, last, margins: e11Margins(label.lengthMm, g.cols, continuous, dpmm) }, this.compress).streams;
					encoded.set(key, streams);
				}
				for (const stream of streams) {
					await this.waitForBuffer(signal);
					await this.transfer(stream, signal);
				}
			}

			// 5. Up to 8 s (16 polls, 500 ms apart) for the printer to finish, failing on any error
			//    (labels used up among them); the app reports success if it is still printing then.
			report('printing', total);
			for (let i = 0; i < 16; i++) {
				await sleep(500, signal);
				s = await this.getStatus();
				const err = printError(s, false);
				if (err) throw new PrinterError(err, 'device');
				report('printing', Math.min(total, s.pagesPrinted + 1));
				if (!s.printing) break;
			}
			report('done', total);
		} catch (e) {
			await this.stop().catch(() => {});
			throw e;
		}
	}

	/** G15Print.stopPrint: STOP if printing, then poll every 20 ms (up to 50 times) until idle. */
	async stop() {
		let s = await this.getStatus();
		if (!s.printing) return;
		await this.cmd(E11_CMD.STOP_PRINT);
		for (let i = 0; i < 50 && (s.printing || s.busy); i++) {
			await sleep(20);
			s = await this.getStatus();
		}
	}
}
