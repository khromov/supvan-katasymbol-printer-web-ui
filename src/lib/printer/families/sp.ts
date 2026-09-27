/**
 * SP family (SP650 and siblings: thermal-transfer tag/plate printers with a 672-dot head at 11.8 dots/mm).
 * Port of spPrintUtils / spImageEncodeUtils / spImageDataUtils / spPrintFlag and the SP branch of
 * PcEdit.vue createPrintData from KatasymbolEditor.
 *
 * Connection notes (BaseSupVanPrint.checkHid / HidUsbCtrlFunc):
 * - The official app only recognises VID 0x1820 / PID 0x203E (8254) as an SP printer ("SP650").
 *   SP_PRODUCT_NAMES lists the other SP PIDs it knows names for, but getDevType() does not map them.
 * - The SP650 enumerates as TWO HID devices with the same VID/PID and only one of them accepts
 *   writes. The official app walks navigator.hid.getDevices() from last to first and, for each SP
 *   candidate, opens it, sends one INQUIRY_STA (0x12) report and closes it again; the first device
 *   whose sendReport() does not throw is used. See probeSpInterface().
 * - Differences from the T50/T80 family: INQUIRY_STA is 0x12 (0x11 on T50), CHECK_DEVICE is 0x18
 *   (0x12 on T50), BUF_FULL carries no length/speed, buffers are 16 KB with 84 bytes per column,
 *   each buffer is its own LZMA stream, and every command reply is parsed as a status report.
 */
import { CommandChannel, sleep, vendorCommand } from '../channel';
import { cropRowsCentered, fromBitmap, offset, packColumns, rotate, type Grid } from '../bitmap';
import LZMA from '../lzma.js';
import { padReport, type Transport } from '../transport';
import {
	PrinterError,
	type Bitmap,
	type LabelSpec,
	type PrinterDriver,
	type PrinterStatus,
	type PrintOptions,
	type PrintProgress
} from '../types';

export const SP_CMD = {
	/** Mark the transferred buffer as full (ready to print). Value 0. */
	BUF_FULL: 0x10,
	/** Query status. */
	INQUIRY_STA: 0x12,
	/** Start print job. Value = material code. */
	START_PRINT: 0x13,
	STOP_PRINT: 0x14,
	/** Re-scan the device / check it can print. Sent once per job. */
	CHECK_DEVICE: 0x18,
	/** Set material type. Value = material code. */
	SET_MAT: 0x1a,
	/** Read the print head width (for DPI) with plate media loaded. */
	RD_LAB_DPI24: 0x24,
	/** Read the print head width (for DPI) for all other media. */
	RD_LAB_DPI25: 0x25,
	/** Announce an LZMA compressed buffer. Value = compressed length. */
	NEXTFRM_BULK: 0x5c
} as const;

export const SP_VENDOR_ID = 0x1820;
/** The only PID the official app treats as SP (getDevType). */
export const SP_PRODUCT_ID = 0x203e;
/** Names from HidUsbCtrlFunc.getPrinterName (only 0x203E is actually wired up officially). */
export const SP_PRODUCT_NAMES: Record<number, string> = {
	0x2037: 'SP150',
	0x2032: 'SP350',
	0x2033: 'SP650',
	0x203d: 'SP350',
	0x203e: 'SP650',
	0x203f: 'SP650E',
	0x2024: 'SP500',
	0x2025: 'SP300',
	0x2026: 'SP600',
	0x2035: 'SP850',
	0x2034: 'SP750'
};

/** Nominal resolution (getPrinterDPI for PrinterSeriesEnum.SP). The design canvas uses this. */
export const SP_DPMM = 11.8;
/** MaxDotValue: every print canvas is exactly this many dots tall. */
export const SP_HEAD_DOTS = 672;
/** The official print dialog shows 1..9 with 4 preselected, but spImageEncodeUtils always sends `deepness: 4`. */
export const SP_DEFAULT_DENSITY = 4;

/** PaperTypeEnum values that matter for SP. */
export const SP_PAPER = { Continuous: 0, DieCut: 1, Plate: 5 } as const;
/** HoleStyle values used by getSPFrontMargin. */
const HOLE = { Single1: 1, Single2: 2, Double5: 9, Double6: 10, Four3: 13 } as const;

const BUF_LENGTH = 0x4000;
const HEADER_LENGTH = 14;
const BYTES_PER_COLUMN = SP_HEAD_DOTS / 8; // 84, "字模宽度"
const MAX_COLUMNS = 194; // per 16 KB buffer

/** JS Number.parseInt applied to a number, exactly as the official code does it (truncates). */
const pint = (x: number) => Number.parseInt(String(x), 10);
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** getSPMaterialTypeCode: continuous 1, die-cut 2, plate 3, anything else 1. */
export function spMaterialCode(paperType: number): number {
	if (paperType == SP_PAPER.Continuous) return 1;
	if (paperType == SP_PAPER.DieCut) return 2;
	if (paperType == SP_PAPER.Plate) return 3;
	return 1;
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export interface SpStatus extends PrinterStatus {
	/** Main CPU status word (mStaReg), bytes 1-2 little endian. */
	mainStatus: number;
	/** Sub CPU status word (fStaReg), bytes 3-4 little endian. */
	subStatus: number;
	/** Bytes 7-8: command specific data (print head width in 0.1 mm for 0x24/0x25). */
	sendData: number;
	/** mStaReg.ComExeSta: main CPU still executing a USB command. */
	commandExecuting: boolean;
	/** fStaReg.sDevBusy. */
	deviceBusy: boolean;
	/** mStaReg.QjgNeedClr: only checked (as a blocking error) before a job starts. */
	needsCleaning: boolean;
	/** Errors devCheckErrMsg() aborts on; checked all through a job. */
	jobErrors: string[];
}

/**
 * Parse a reply (every SP reply uses this layout, handleInquiryStatus):
 * [1..2] mStaReg, [3..4] fStaReg, [5..6] printed page count, [7..8] SendData (all little endian).
 */
export function parseSpStatus(r: Uint8Array): SpStatus {
	const m = (r[1] | (r[2] << 8)) & 0xffff;
	const f = (r[3] | (r[4] << 8)) & 0xffff;
	const mb = (bit: number) => !!(m & (1 << bit));
	const fb = (bit: number) => !!(f & (1 << bit));

	// devCheckErrMsg order; the official app stops at the first one.
	const jobErrors: string[] = [];
	if (mb(5)) jobErrors.push('Ribbon used up');
	if (mb(8)) jobErrors.push('Internal system error');
	if (mb(9)) jobErrors.push('Internal system error (DMA)');
	if (fb(3)) jobErrors.push('Top cover is open');
	if (fb(4)) jobErrors.push('Ribbon used up');
	if (fb(5)) jobErrors.push('Out of labels');
	if (fb(11)) jobErrors.push('Print head fault');
	if (fb(12)) jobErrors.push('Cleaning unit fault');

	// Shown by the official app ("色带出错", ribbon error) without stopping the job.
	const warnings: string[] = [];
	if (!mb(7)) warnings.push('Consumable check not OK (ribbon error)');
	if (mb(4)) warnings.push('Ribbon read error');
	if (mb(6)) warnings.push('Wrong ribbon type');
	if (fb(13)) warnings.push('Print head lowering fault'); // TPHDown: not checked officially

	const needsCleaning = mb(11);
	const errors = [...new Set(jobErrors)];
	if (needsCleaning) errors.push('Cleaning roller needs cleaning');

	return {
		raw: r,
		mainStatus: m,
		subStatus: f,
		bufferFull: mb(0),
		commandExecuting: mb(10),
		needsCleaning,
		busy: mb(10),
		deviceBusy: fb(7),
		coverOpen: fb(3),
		printing: fb(6),
		pagesPrinted: (r[5] | (r[6] << 8)) & 0xffff,
		sendData: (r[7] | (r[8] << 8)) & 0xffff,
		jobErrors,
		errors,
		warnings
	};
}

/** printDPI from a 0x24/0x25 reply: 672 / (head width in mm), falling back to 11.8 outside 11..12. */
export function spDpiFromSendData(sendData: number): number {
	const dpi = 672 / (sendData / 10);
	return dpi > 12 || dpi < 11 || Number.isNaN(dpi) ? SP_DPMM : dpi;
}

// ---------------------------------------------------------------------------------------------
// Canvas composition (PcEdit.vue createPrintData, SP branch)
// ---------------------------------------------------------------------------------------------

/**
 * Build the 672-row print canvas from the full-label design bitmap.
 *
 * The official editor renders the whole label div (TapeLength x TapeWidth at 11.8 px/mm) and then:
 * - PaperDirection 0: canvas width = parseInt((TapeLength - Left - Right + 2) * dpi + 0.5); the design
 *   is drawn at x = -Left * dpi and centered vertically in the 672 rows (larger designs are cropped
 *   around the center).
 * - PaperDirection 1: the design is rotated 270 degrees (counter-clockwise), then a canvas of width
 *   parseInt((TapeWidth - Top - Bottom + 2) * dpi + 0.5) is cut from it at source x = parseInt(Top * dpi),
 *   y = parseInt(Right * dpi). Head dot 0 is the label's right edge (minus Right padding), columns run
 *   down the label from the Top padding.
 *
 * `dpi` is currentPrint.printDPI (the device reported value, normally ~11.8), while the design itself
 * is always rendered at 11.8. Uncovered canvas areas are white. Sub-pixel placement is rounded to the
 * nearest dot (the official canvas blends half-pixel offsets, which can thicken edges by one dot).
 */
export function composeSpCanvas(page: Bitmap, label: LabelSpec, dpi = SP_DPMM): Grid {
	const { top, bottom, left, right } = label.padding;
	const rows = SP_HEAD_DOTS;
	const W = page.width;
	const H = page.height;
	const src = page.data;

	if (label.paperDirection == 0) {
		const cols = pint((label.lengthMm - left - right + 2) * dpi + 0.5);
		if (!(cols > 0)) throw new PrinterError('Label has no printable area', 'label');
		const out = new Uint8Array(rows * cols);
		const ox = Math.round(left * dpi); // drawImage x = -(Padding.Left * DPI)
		const oy = Math.floor((rows - H) / 2); // drawImage y = 336 - img.height / 2
		for (let r = 0; r < rows; r++) {
			const sr = r - oy;
			if (sr < 0 || sr >= H) continue;
			for (let c = 0; c < cols; c++) {
				const sc = c + ox;
				if (sc >= 0 && sc < W) out[r * cols + c] = src[sr * W + sc];
			}
		}
		return { rows, cols, data: out };
	}

	const cols = pint((label.widthMm - top - bottom + 2) * dpi + 0.5);
	if (!(cols > 0)) throw new PrinterError('Label has no printable area', 'label');
	// Rotated design: temp[y][x] = design[x][W - 1 - y], temp is H wide and W tall.
	const sx = pint(top * dpi);
	const sy = pint(right * dpi);
	const out = new Uint8Array(rows * cols);
	for (let r = 0; r < rows; r++) {
		const dc = W - 1 - (sy + r); // design column
		if (dc < 0 || dc >= W) continue;
		for (let c = 0; c < cols; c++) {
			const dr = sx + c; // design row
			if (dr >= 0 && dr < H) out[r * cols + c] = src[dr * W + dc];
		}
	}
	return { rows, cols, data: out };
}

// ---------------------------------------------------------------------------------------------
// Encoding (spImageDataUtils.getAllBytes + spImageEncodeUtils.getEncodeData)
// ---------------------------------------------------------------------------------------------

export interface SpEncodeOptions {
	/** currentPrint.printDPI (device reported, see readDpi). Default 11.8. */
	dpi?: number;
	/** Last label of the whole job (PAGE_REG bit 0x08). */
	printEnd: boolean;
	/** Page contains a barcode (PAGE_REG bit 0x01, "650 only"). */
	hasBarcode?: boolean;
	/** 0..15, default 4 (the official encoder's constant). */
	density?: number;
	/** Print dialog offsets (official slider units, 1 unit = 4 dots). */
	offsetX?: number;
	offsetY?: number;
}

export interface SpEncodedPage {
	/** One LZMA stream per buffer, each sent with one NEXTFRM_BULK / bulk / BUF_FULL round. */
	chunks: Uint8Array[];
	/** Raw 16384-byte buffers before compression (for tests/debugging). */
	buffers: Uint8Array[];
	/** Columns announced to the printer (may differ from the canvas width, see below). */
	columns: number;
	canvasColumns: number;
}

const compress = (buf: Uint8Array): Uint8Array => Uint8Array.from(LZMA.compress(buf, 9) as number[], (b) => b & 0xff);

/** getSPFrontMargin (plate media only), in dots. */
export function spFrontMargin(label: LabelSpec, dpi: number): number {
	const hole = num(label.extra?.HoleStyle);
	const holeW = num(label.extra?.HoleWidth);
	const holeH = num(label.extra?.HoleHeight);
	if (label.paperDirection == 0) {
		// Hole in the leading margin: single left, double left/right, four holes.
		if (hole == HOLE.Single1 || hole == HOLE.Double5 || hole == HOLE.Four3) {
			const fm = pint((label.padding.left - holeW - 1) * dpi + 0.5);
			return fm > 0 ? fm : 1;
		}
		return pint(label.padding.left * dpi + 0.5);
	}
	if (hole == HOLE.Single2 || hole == HOLE.Double6 || hole == HOLE.Four3) {
		const fm = pint((label.padding.top - holeH - 1) * dpi + 0.5);
		return fm > 0 ? fm : 1;
	}
	return pint(label.padding.top * dpi + 0.5);
}

/** Split a composed 672-row canvas into SP print buffers. */
export function encodeSpCanvas(canvas: Grid, label: LabelSpec, opts: SpEncodeOptions): SpEncodedPage {
	const dpi = opts.dpi ?? SP_DPMM;
	const density = (opts.density ?? SP_DEFAULT_DENSITY) & 0x0f;
	const plate = label.paperType == SP_PAPER.Plate;

	// getAllBytes: rotate(-90), offset, rotate(90) (identity apart from the offset), crop, pack.
	let g = rotate(canvas, -90);
	g = offset(g, Math.round((opts.offsetX ?? 0) * 4), Math.round((opts.offsetY ?? 0) * 4));
	g = rotate(g, 90);
	g = cropRowsCentered(g, SP_HEAD_DOTS);
	const { bytes } = packColumns(g);

	// Continuous/die-cut media in direction 0 always send the full label length (TapeLength * dpi,
	// truncated): the canvas is cut or padded with blank columns to fit.
	let remaining = label.paperDirection == 0 && !plate ? pint(label.lengthMm * dpi) : canvas.cols;
	const columns = remaining;
	const mt = spMaterialCode(label.paperType);
	const buffers: Uint8Array[] = [];
	let currentFrame = 0;

	for (let bNum = 0; ; bNum++) {
		const buf = new Uint8Array(BUF_LENGTH);
		let reg = 0;
		if (opts.hasBarcode) reg |= 0x01;
		if (currentFrame === 0) reg |= 0x02; // first buffer of the label
		buf[3] = (mt << 4) | density;
		const last = !(remaining > MAX_COLUMNS);
		if (!last) {
			buf[4] = MAX_COLUMNS;
		} else {
			buf[4] = remaining;
			reg |= 0x04; // last buffer of the label
			if (opts.printEnd) reg |= 0x08; // last buffer of the job
		}
		buf[2] = reg;
		buf[6] = BYTES_PER_COLUMN;
		if (currentFrame === 0 && plate) {
			const front = spFrontMargin(label, dpi);
			buf[8] = front;
			buf[9] = front >> 8;
			// The official code always uses Padding.Right here (getSPBackMargin is unused).
			const back = pint(label.padding.right * dpi + 0.5);
			buf[10] = back;
			buf[11] = back >> 8;
		}

		const start = MAX_COLUMNS * bNum * BYTES_PER_COLUMN;
		const cols = last ? remaining : MAX_COLUMNS;
		const data = bytes.subarray(start, start + cols * BYTES_PER_COLUMN);
		buf.set(data.subarray(0, BUF_LENGTH - HEADER_LENGTH), HEADER_LENGTH);
		if (!last) {
			remaining -= MAX_COLUMNS;
			currentFrame += MAX_COLUMNS;
		}

		// Checksum: header bytes 2..13 plus the last byte of each of the 64 256-byte blocks.
		let sum = 0;
		for (let j = 2; j < HEADER_LENGTH; j++) sum += buf[j];
		for (let k = 0; k < BUF_LENGTH / 256; k++) sum += buf[(k + 1) * 256 - 1];
		buf[0] = sum & 0xff;
		buf[1] = (sum >> 8) & 0xff;
		buffers.push(buf);
		if (last) break;
	}

	return { chunks: buffers.map(compress), buffers, columns, canvasColumns: canvas.cols };
}

/** Compose and encode one label from the full-label design bitmap. */
export function encodeSpPage(page: Bitmap, label: LabelSpec, opts: SpEncodeOptions): SpEncodedPage {
	return encodeSpCanvas(composeSpCanvas(page, label, opts.dpi ?? SP_DPMM), label, opts);
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

export interface SpPrintOptions extends PrintOptions {
	/** PAGE_REG barcode flag, for all pages or per page (official: page contains a barcode item). */
	hasBarcode?: boolean | boolean[];
}

/**
 * Official checkHid() for SP: open, send one INQUIRY_STA report, close. The interface is usable if
 * the write succeeds (the reply is not read). Call it on each same-VID/PID candidate, last first.
 */
export async function probeSpInterface(device: HIDDevice): Promise<boolean> {
	try {
		if (device.opened) await device.close();
		await device.open();
		await device.sendReport(0, padReport(vendorCommand(SP_CMD.INQUIRY_STA)) as Uint8Array<ArrayBuffer>);
		return true;
	} catch {
		return false;
	} finally {
		if (device.opened) await device.close().catch(() => {});
	}
}

export class SpDriver implements PrinterDriver {
	readonly family = 'sp' as const;
	readonly dpmm = SP_DPMM;
	readonly headDots = SP_HEAD_DOTS;
	readonly channel: CommandChannel;
	/** Last printDPI read from the device (currentPrint.printDPI). */
	printDpi = SP_DPMM;

	constructor(transport: Transport) {
		this.channel = new CommandChannel(transport);
	}

	/**
	 * Default semantics: the full label at 11.8 dots/mm, round(lengthMm * 11.8) x round(widthMm * 11.8),
	 * padding included (like the official label div). print() crops the printable area itself.
	 */
	canvasSize(label: LabelSpec) {
		return { width: Math.round(label.lengthMm * this.dpmm), height: Math.round(label.widthMm * this.dpmm) };
	}

	private async cmd(command: number, value = 0) {
		return this.channel.request([vendorCommand(command, value)]);
	}

	private async statusCmd(command: number, value = 0) {
		return parseSpStatus(await this.cmd(command, value));
	}

	async getStatus(): Promise<SpStatus> {
		return this.statusCmd(SP_CMD.INQUIRY_STA);
	}

	/** spPrintUtils.getDpi: 0x24 with plate media, 0x25 otherwise. */
	async readDpi(paperType: number): Promise<number> {
		const s = await this.statusCmd(paperType == SP_PAPER.Plate ? SP_CMD.RD_LAB_DPI24 : SP_CMD.RD_LAB_DPI25);
		this.printDpi = spDpiFromSendData(s.sendData);
		return this.printDpi;
	}

	/** devCheckErrMsg(). */
	private assertJob(s: SpStatus) {
		if (s.jobErrors.length) throw new PrinterError(s.jobErrors[0], 'device');
	}

	async print(pages: Bitmap[], label: LabelSpec, opts: SpPrintOptions) {
		if (!pages.length) throw new PrinterError('Nothing to print', 'empty');
		const { signal, onProgress } = opts;
		const copies = Math.max(1, opts.copies | 0);
		const total = pages.length * copies;
		let warned = '';
		const report = (phase: PrintProgress['phase'], page: number, s?: SpStatus) => {
			const w = s?.warnings.join(', ') ?? warned;
			warned = w;
			onProgress?.({ phase, page, pages: total, message: w || undefined });
		};

		report('preparing', 0);
		// Head resolution, read when the official print dialog opens.
		const dpi = await this.readDpi(label.paperType).catch(() => this.printDpi);
		const barcode = (i: number) => (Array.isArray(opts.hasBarcode) ? !!opts.hasBarcode[i] : !!opts.hasBarcode);
		const encode = (i: number, printEnd: boolean) =>
			encodeSpPage(pages[i], label, { dpi, printEnd, hasBarcode: barcode(i), offsetX: opts.offsetX, offsetY: opts.offsetY });
		const encoded = pages.map((_, i) => encode(i, false));
		// Collated like the official default ("逐份打印"): all pages, then the next copy.
		const sequence: SpEncodedPage[] = [];
		for (let c = 0; c < copies; c++) for (let i = 0; i < pages.length; i++) sequence.push(encoded[i]);
		sequence[total - 1] = encode(pages.length - 1, true);
		const mat = spMaterialCode(label.paperType);
		try {
			await this.runJob(sequence, mat, total, report, signal);
		} catch (e) {
			// stop() only sends STOP_PRINT if the printer reports it is printing.
			if (e instanceof PrinterError && e.code === 'cancelled') await this.stop().catch(() => {});
			throw e;
		}
	}

	private async runJob(
		sequence: SpEncodedPage[],
		mat: number,
		total: number,
		report: (phase: PrintProgress['phase'], page: number, s?: SpStatus) => void,
		signal?: AbortSignal
	) {
		// 1. Check device, 2. wait (500 ms, 21 polls) for the main CPU to finish the command.
		report('checking', 0);
		let s = await this.statusCmd(SP_CMD.CHECK_DEVICE);
		for (let tries = 20; ; tries--) {
			await sleep(500, signal);
			s = await this.getStatus();
			if (!s.commandExecuting) break;
			if (tries <= 0) throw new PrinterError('Device check timed out', 'timeout');
		}
		// 3. Device errors, cleaning roller.
		this.assertJob(s);
		if (s.needsCleaning) throw new PrinterError('Cleaning roller needs cleaning', 'device');
		report('checking', 0, s);

		// 5. Material, 6. start, 7. wait (100 ms, 51 polls) until the printer reports printing.
		s = await this.statusCmd(SP_CMD.SET_MAT, mat);
		s = await this.statusCmd(SP_CMD.START_PRINT, mat);
		for (let tries = 50; ; tries--) {
			await sleep(100, signal);
			s = await this.getStatus();
			if (s.printing) break;
			if (tries <= 0) throw new PrinterError('Failed to start printing', 'start');
		}

		let acknowledged = 0; // currentPrint.num
		for (let p = 0; p < total; p++) {
			const page = sequence[p];
			report('sending', p + 1, s);
			if (p > 0) {
				// handleTransferNext: wait until the previous label has been printed.
				for (;;) {
					this.assertJob(s);
					if (acknowledged !== s.pagesPrinted) break;
					await sleep(100, signal);
					if (!s.printing) throw new PrinterError('Printing was stopped', 'stopped');
					s = await this.getStatus();
				}
				if (s.pagesPrinted > acknowledged && total > acknowledged) acknowledged++;
				await sleep(100, signal);
			}
			s = await this.getStatus();
			let polled = true;

			for (const chunk of page.chunks) {
				// handleTransferStep: only send while the buffer is not full (100 ms, 51 polls).
				for (let tries = 50; ; ) {
					this.assertJob(s);
					if (tries < 0) throw new PrinterError('Status query failed', 'timeout');
					if (polled && !s.bufferFull) break;
					await sleep(100, signal);
					tries--;
					s = await this.getStatus();
					polled = true;
				}
				s = await this.statusCmd(SP_CMD.NEXTFRM_BULK, chunk.length);
				// Not cancellable: once announced, the device expects the stream (the official
				// app also always completes the bulk write and stops at the next command).
				await sleep(100);
				// Deliberate deviation: the official BulkWriteType sends min(ceil(len/65)+1, ceil(len/64))
				// reports, which drops the tail of any stream >= 4225 bytes (dense 16 KB buffers). We send
				// the whole announced stream; for streams <= 4224 bytes this is identical.
				// The reply to the bulk transfer is parsed as a status report as well.
				s = parseSpStatus(await this.channel.request(CommandChannel.chunk(chunk), 10000));
				await sleep(100, signal);
				await this.cmd(SP_CMD.BUF_FULL); // reply ignored by the official code
				await sleep(100, signal);
				polled = false;
			}
		}

		// Wait (500 ms, 101 polls) until the printer stops printing.
		report('printing', Math.min(total, s.pagesPrinted + 1), s);
		for (let tries = 100; ; tries--) {
			s = await this.getStatus();
			if (!s.printing) {
				await this.getStatus(); // printEnd: one last status query
				break;
			}
			this.assertJob(s);
			report('printing', Math.min(total, s.pagesPrinted + 1), s);
			if (tries <= 0) throw new PrinterError('Printer did not finish printing', 'timeout');
			await sleep(500, signal);
		}
		report('done', total, s);
	}

	/** stopPrintManual / waitStopPrintManual (the official loop has no limit; capped at ~30 s here). */
	async stop() {
		let s = await this.getStatus();
		if (!s.printing) return;
		s = await this.statusCmd(SP_CMD.STOP_PRINT);
		for (let tries = 0; tries < 60; tries++) {
			if (s.jobErrors.length || !s.printing) return;
			await sleep(500);
			s = await this.getStatus();
		}
	}
}
