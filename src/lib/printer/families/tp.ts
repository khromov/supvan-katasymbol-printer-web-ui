/**
 * TP wire / tube marker printers. Two protocol variants exist in the official app:
 *
 *  - Generic TP (TP76i, PID 0x202c): tp/tpPrintUtils.js + tp/tpImageEncodeUtils.js. Every label is
 *    split into raw (uncompressed) buffers of up to 226 columns, each sent with NEXTFRM_RAW (0x5a).
 *  - TP86A variant (TP86A 0x202f/0x2081, TP80A 0x202e/0x2080; the official code also routes
 *    "TP56" here, but no product id maps to it): tp/tp86APrintUtils.js + tp/tp86AImageEncodeUtils.js.
 *    All 4096-byte buffers of a label are LZMA compressed into ONE stream sent with NEXTFRM_LZMA (0x5c).
 *
 * Both share tpImageDataUtils (raster), tpPrintFlag (status bits), PAGE_REG_BITS.toByteArray(1)
 * (buffer header) and the TP branch of PcEdit.vue createPrintData (canvas composition).
 *
 * Canvas composition (PcEdit.vue createPrintData, TP branch):
 *  - The design is rendered at the printer model's DPI (getPrinterDPI(TP) = 11.3 dots/mm), i.e. the
 *    print preview div of PageLength*11.3 x PageWidth*11.3 px. That is what `canvasSize()` returns.
 *  - The print canvas is floor(PageLength * printDPI + 0.5) columns wide and exactly 144 dots (the
 *    head) tall. printDPI is read from the printer with RD_LAB_DPI (0x22) for the loaded material
 *    (tube / heat-shrink / label calibration), see parseTpPrintDpmm(); it falls back to 11.3.
 *  - The design image is drawn centred horizontally and vertically on that canvas at its own size
 *    (not scaled). Padding.Left/Right are only used for an unused variable there, so padding does
 *    not affect printing. There is no rotation in practice: every TP catalog entry has
 *    PaperDirection 0, so the encoder's rotate(-90) and rotate(90) cancel out.
 *
 * Auto page length: the official editor recomputes Page.PageLength while editing (see
 * tpAutoPageLength) and the print path then just uses that length; so callers pass the resulting
 * length as label.lengthMm and render the design at canvasSize() of that label.
 */
import { CommandChannel, sleep, vendorCommand } from '../channel';
import { cropRowsCentered, fromBitmap, offset, packColumns, rotate, type Grid } from '../bitmap';
import LZMA from '../lzma.js';
import type { Transport } from '../transport';
import {
	PrinterError,
	type Bitmap,
	type LabelSpec,
	type PrinterDriver,
	type PrinterStatus,
	type PrintOptions,
	type PrintProgress
} from '../types';

export const TP_CMD = {
	BUF_FULL: 0x10,
	INQUIRY_STA: 0x11,
	CHECK_DEVICE: 0x12,
	START_PRINT: 0x13,
	STOP_PRINT: 0x14,
	/** Read the feed calibration ("DPI" x100) per material. */
	RD_LAB_DPI: 0x22,
	/** Generic TP: next frame, raw buffer. */
	NEXTFRM_RAW: 0x5a,
	/** TP86A: next frame, LZMA stream. */
	NEXTFRM_LZMA: 0x5c
} as const;

/** Print head height in dots (MaxDotValue). */
export const TP_HEAD_DOTS = 144;
/** getPrinterDPI(PrinterSeriesEnum.TP): the design/render resolution in dots per mm. */
export const TP_DESIGN_DPMM = 11.3;
const BUF_LENGTH = 0x1000;
const BYTES_PER_COLUMN = TP_HEAD_DOTS / 8;
/** Columns per 4096-byte buffer: floor((4096 - 22) / 18) = 226. */
export const TP_BUFFER_COLUMNS = Math.floor((BUF_LENGTH - 22) / BYTES_PER_COLUMN);
/** The official app always sends START_PRINT with store currentPrint.deepness (4, never changed). */
const START_PRINT_DEEPNESS = 4;

/** UI parameters. */
export const TP_DENSITY = { min: 1, max: 9, default: 4 } as const;
/** Page length limits of the TP editor (shareMemery tpAutoLengthMin / tpAutoLengthMax), mm. */
export const TP_LENGTH_MM = { min: 6, max: 1400 } as const;
/**
 * Cut types offered by the official print dialog for TP (CutTypeEnum; "Full" (3) is hidden for TP).
 * The default is 0 even though the source comment says "default half cut".
 */
export const TP_CUT_TYPES = [
	{ value: 0, label: 'None' },
	{ value: 1, label: 'Line' },
	{ value: 2, label: 'Half cut' }
] as const;
/** TP paper types used by the catalog (PaperTypeEnum + one undocumented value). */
export const TP_PAPER_TYPES: Record<number, string> = {
	0: 'Label tape',
	6: 'Tube',
	7: 'Heat-shrink tube',
	8: 'Marker strip',
	15: 'Unlisted type 15 (catalog entry "Φ4.8")'
};

// ---------------------------------------------------------------------------------------------
// Status (tpPrintFlag + handleInquiryStatus / devCheckErrMsg)
// ---------------------------------------------------------------------------------------------

export interface TpStatus extends PrinterStatus {
	/** mStaReg.ComExeSta: the main CPU is still executing a USB command. */
	commandExecuting: boolean;
	/** fStaReg.sDevBusy. */
	deviceBusy: boolean;
	/** fStaReg.pBuf0Full..pBuf2Full. */
	buffers: [boolean, boolean, boolean];
	cutting: boolean;
	materialOk: boolean;
	/** SendData word (bytes 7..8). */
	sendData: number;
}

/**
 * Parse a TP status report. Byte 1..2 = mStaReg (main CPU / consumables), 3..4 = fStaReg
 * (secondary CPU / system), 5..6 = printed page count, 7..8 = SendData (all little endian).
 * Errors are listed in devCheckErrMsg order (the official app shows the first one).
 */
export function parseTpStatus(r: Uint8Array): TpStatus {
	const m0 = r[1] ?? 0;
	const m1 = r[2] ?? 0;
	const f0 = r[3] ?? 0;
	const f1 = r[4] ?? 0;
	const errors: string[] = [];
	const add = (on: number, msg: string) => {
		if (on && !errors.includes(msg)) errors.push(msg);
	};
	add(f0 & 0x08, 'Top cover is open'); // CoverOpen 上盖打开
	add(f0 & 0x20, 'Ribbon not detected'); // RibEnd 光电检测不到色带
	add(f0 & 0x10, 'Labels used up'); // LabEnd 贴纸用完
	add(f1 & 0x01, 'Label read error'); // LabRwErr 贴纸读取错误
	add(f1 & 0x02, 'Cutter error'); // qCutErr 切刀出错
	add(m1 & 0x02, 'Ribbon error'); // RibRdErr 色带出错
	add(m0 & 0x02, 'No material detected at the entry'); // MatIn 入口检测不到材料
	add(m0 & 0x08, 'Label read error'); // LabRdErr 贴纸读取错误
	add(m1 & 0x08, 'Ribbon is broken'); // RibBreak 色带断带
	add(m1 & 0x01, 'Ribbon used up'); // RibOver 色带用完
	add(m0 & 0x04, 'Labels used up'); // LabOver 贴纸用完
	add(f1 & 0x80, 'Printer needs activation: connect it to the internet and restart it'); // NeedAuthen 请联网后，重新开启打印设备
	const warnings: string[] = [];
	if (m0 & 0x40) warnings.push('Low battery'); // BatLow (not checked by the official app)
	if (m0 & 0x10) warnings.push('Printing was cancelled on the printer'); // PrtCancel (not checked)
	return {
		raw: r,
		bufferFull: !!(m0 & 0x01),
		busy: !!(m1 & 0x04),
		commandExecuting: !!(m1 & 0x04),
		printing: !!(f0 & 0x40),
		deviceBusy: !!(f0 & 0x80),
		coverOpen: !!(f0 & 0x08),
		buffers: [!!(f0 & 0x01), !!(f0 & 0x02), !!(f0 & 0x04)],
		cutting: !!(m1 & 0x10),
		materialOk: !!(m0 & 0x80),
		pagesPrinted: (r[5] ?? 0) | ((r[6] ?? 0) << 8),
		sendData: (r[7] ?? 0) | ((r[8] ?? 0) << 8),
		errors,
		warnings
	};
}

/**
 * RD_LAB_DPI reply (tpPrintUtils/tp86APrintUtils handleNotify CMD_RD_LAB_DPI): three calibrations
 * x100 at bytes 1..2 (tube), 3..4 (label tape), 5..6 (heat-shrink tube). Uses the catalog PaperType.
 * Returns undefined for other paper types: the official app then keeps the previous job's value
 * (undefined on the first print, which breaks its canvas); callers fall back to TP_DESIGN_DPMM.
 */
export function parseTpPrintDpmm(r: Uint8Array, paperType: number): number | undefined {
	const word = (i: number) => (r[i] ?? 0) + ((r[i + 1] ?? 0) << 8);
	let dpi: number;
	if (paperType === 0) dpi = word(3) / 100;
	else if (paperType === 6) dpi = word(1) / 100;
	else if (paperType === 7) dpi = word(5) / 100;
	else if (paperType === 8) dpi = 11.606;
	else return undefined;
	if (dpi < 11 || dpi > 12.8) dpi = 11.8;
	return dpi;
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

/** getTPMaterialTypeCode(): material code for CHECK_DEVICE and the TP86A buffer header. */
export function tpMaterialCode(paperType: number, tapeWidthMm: number | string): number {
	const w = Number.parseInt(String(tapeWidthMm));
	switch (paperType) {
		case 7: // ShrinkTube
			return w <= 6 ? 7 : w <= 9 ? 8 : w <= 12 ? 9 : 7;
		case 6: // Tube
			return w <= 5 ? 4 : w <= 7 ? 5 : 6;
		case 5: // Plate
		case 8: // MarkerTap (mapped to Plate)
			return 10;
		default: // Label
			return w === 6 ? 1 : w === 9 ? 2 : w === 12 ? 3 : 1;
	}
}

/** CutType (print dialog value) to the page register Cut field: Half->1, Line->2, None/Full->0. */
export function tpCutBits(cutType: number | string | undefined): number {
	const c = Number(cutType ?? 0);
	return c === 2 ? 1 : c === 1 ? 2 : 0;
}

/** PAGE_REG_BITS.toByteArray(1) (the deviceType != 0 layout). */
function pageRegister(pageStart: boolean, pageEnd: boolean, printEnd: boolean, cut: number, mat: number, density: number) {
	let b0 = 0;
	if (pageStart) b0 |= 0x02;
	if (pageEnd) b0 |= 0x04;
	if (printEnd) b0 |= 0x08;
	b0 = ((b0 & 0x0f) | (cut << 4)) & 0xff;
	const b1 = ((((mat & 0xff) << 4) & 0xff) | density) & 0xff;
	return [b0, b1] as const;
}

/** Fill header bytes 4..13 and the checksum (bytes 0..1) of a buffer holding `cols` columns. */
function finishBuffer(buf: Uint8Array, cols: number, reg: readonly [number, number]) {
	buf[2] = reg[0];
	buf[3] = reg[1];
	buf[4] = cols & 0xff;
	buf[5] = (cols >> 8) & 0xff;
	buf[6] = BYTES_PER_COLUMN;
	buf[8] = 1;
	buf[10] = 1;
	// Checksum: header bytes 2..13 plus the last byte of every full 256-byte block.
	const len = ((buf[5] << 8) + buf[4]) * buf[6] + 14;
	let sum = 0;
	for (let j = 2; j < 14; j++) sum += buf[j];
	for (let k = 0; k < Math.floor(len / 256); k++) sum += buf[(k + 1) * 256 - 1];
	buf[0] = sum & 0xff;
	buf[1] = (sum >> 8) & 0xff;
}

/**
 * Compose the print canvas like PcEdit.vue createPrintData (TP): floor(lengthMm * printDpmm + 0.5)
 * columns x 144 rows with the design bitmap centred on it (clipped if larger). A bitmap that is
 * already that size is used as is.
 */
export function tpComposeCanvas(page: Bitmap, lengthMm: number, printDpmm: number): Bitmap {
	const width = Math.floor(lengthMm * printDpmm + 0.5);
	const height = TP_HEAD_DOTS;
	if (page.width === width && page.height === height) return page;
	const data = new Uint8Array(width * height);
	const x0 = Math.round((width - page.width) / 2);
	const y0 = Math.round((height - page.height) / 2);
	for (let y = 0; y < page.height; y++) {
		const ty = y + y0;
		if (ty < 0 || ty >= height) continue;
		for (let x = 0; x < page.width; x++) {
			const tx = x + x0;
			if (tx >= 0 && tx < width && page.data[y * page.width + x]) data[ty * width + tx] = 1;
		}
	}
	return { width, height, data };
}

export interface TpRasterOptions {
	/** Official print dialog offsets (-48..48); multiplied by 4 dots like the official code. */
	offsetX?: number;
	offsetY?: number;
	/** Catalog PaperDirection (0 for every TP label). */
	paperDirection?: number;
}

/** tpImageDataUtils.getAllBytes with Rotate = 1 (rotateAngle -90) and OverturnType 0. */
export function tpRaster(canvas: Bitmap, opts: TpRasterOptions = {}): Grid {
	let g = fromBitmap(canvas);
	g = rotate(g, -90);
	g = offset(g, Math.round((opts.offsetX ?? 0) * 4), Math.round((opts.offsetY ?? 0) * 4));
	if ((opts.paperDirection ?? 0) === 0) g = rotate(g, 90);
	return cropRowsCentered(g, TP_HEAD_DOTS);
}

export interface TpEncodeOptions extends TpRasterOptions {
	/** Print density 1..9 (low nibble of header byte 3). */
	density: number;
	/** Official CutType value (0 none, 1 line, 2 half cut). */
	cutType: number;
	/** Last label of the job (PrtEnd bit). */
	printEnd: boolean;
	/** Generic TP: header "Mat" nibble = the print dialog PaperType. */
	paperType: number;
	/** TP86A: header "Mat" nibble = tpMaterialCode(paperType, tapeWidthMm). */
	tapeWidthMm: number;
}

export interface TpEncodedLabel {
	/** Generic TP: raw buffers, each 14 + columns*18 bytes, sent one per NEXTFRM_RAW round. */
	buffers: Uint8Array[];
	columns: number;
}

export interface Tp86aEncodedLabel {
	/** The single LZMA stream sent with NEXTFRM_LZMA. */
	stream: Uint8Array;
	/** The full 4096-byte buffers before compression. */
	buffers: Uint8Array[];
	columns: number;
}

/** Column bytes of the canvas; `columns` is the canvas width (ImgWidth), like the official code. */
function rasterBytes(canvas: Bitmap, o: TpRasterOptions) {
	const { bytes } = packColumns(tpRaster(canvas, o));
	return { bytes, columns: canvas.width };
}

/** tpImageEncodeUtils.getEncodeData for one composed W x 144 canvas. */
export function encodeTpLabel(canvas: Bitmap, o: TpEncodeOptions): TpEncodedLabel {
	const { bytes, columns } = rasterBytes(canvas, o);
	const cut = tpCutBits(o.cutType);
	const buffers: Uint8Array[] = [];
	let remaining = columns;
	for (let n = 0; ; n++) {
		const last = remaining <= TP_BUFFER_COLUMNS;
		const cols = last ? remaining : TP_BUFFER_COLUMNS;
		if (!last) remaining -= TP_BUFFER_COLUMNS;
		const start = TP_BUFFER_COLUMNS * n * BYTES_PER_COLUMN;
		const data = bytes.subarray(Math.min(start, bytes.length), Math.min(bytes.length, start + cols * BYTES_PER_COLUMN));
		const buf = new Uint8Array(BUF_LENGTH);
		buf.set(data, 14);
		finishBuffer(buf, cols, pageRegister(n === 0, last, last && o.printEnd, cut, o.paperType, o.density));
		buffers.push(buf.slice(0, 14 + data.length));
		if (last) break;
	}
	return { buffers, columns };
}

const compress = (buf: Uint8Array): Uint8Array => Uint8Array.from(LZMA.compress(buf, 9) as number[], (b) => b & 0xff);

/** tp86AImageEncodeUtils.getEncodeData for one composed W x 144 canvas (Copies = 1). */
export function encodeTp86aLabel(canvas: Bitmap, o: TpEncodeOptions): Tp86aEncodedLabel {
	const { bytes, columns } = rasterBytes(canvas, o);
	const cut = tpCutBits(o.cutType);
	const mat = tpMaterialCode(o.paperType, o.tapeWidthMm);
	const count = Math.floor((columns + TP_BUFFER_COLUMNS - 1) / TP_BUFFER_COLUMNS);
	const buffers: Uint8Array[] = [];
	for (let i = 0; i < count; i++) {
		const last = i === count - 1;
		const cols = last ? columns - TP_BUFFER_COLUMNS * i : TP_BUFFER_COLUMNS;
		const start = TP_BUFFER_COLUMNS * i * BYTES_PER_COLUMN;
		const buf = new Uint8Array(BUF_LENGTH);
		buf.set(bytes.subarray(Math.min(start, bytes.length), Math.min(bytes.length, start + cols * BYTES_PER_COLUMN)), 14);
		finishBuffer(buf, cols, pageRegister(i === 0, last, last && o.printEnd, cut, mat, o.density));
		buffers.push(buf);
	}
	// The official loop meant to shrink the batch until it fits 4096 bytes, but tests
	// `sendData.Length` (undefined), so the whole label always goes out as one stream.
	const all = new Uint8Array(BUF_LENGTH * buffers.length);
	buffers.forEach((b, i) => all.set(b, i * BUF_LENGTH));
	return { stream: buffers.length ? compress(all) : new Uint8Array(0), buffers, columns };
}

/**
 * Editor auto length (PcEdit.vue refreshPageSize/editAutoSizeH for TP): `contentRightMm` is the
 * right edge of the right-most object. Returns the new page length, or `current` when the result
 * would exceed the TP maximum (the editor then leaves the length unchanged).
 */
export function tpAutoPageLength(contentRightMm: number | null, paddingRightMm: number, current: number): number {
	if (contentRightMm === null) return TP_LENGTH_MM.min;
	const max = Math.trunc(contentRightMm);
	if (max <= TP_LENGTH_MM.min) return TP_LENGTH_MM.min;
	const len = max + paddingRightMm + 1;
	return len > TP_LENGTH_MM.max ? current : len;
}

// ---------------------------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------------------------

type Phase = PrintProgress['phase'];

abstract class TpFamilyDriver implements PrinterDriver {
	abstract readonly family: 'tp' | 'tp86a';
	readonly dpmm = TP_DESIGN_DPMM;
	readonly headDots = TP_HEAD_DOTS;
	readonly channel: CommandChannel;
	/** printDPI used for the last job (dots per mm along the feed). */
	lastPrintDpmm = TP_DESIGN_DPMM;
	protected lastStatus: TpStatus | null = null;
	private job: { ctl: AbortController; done: Promise<void> } | null = null;

	constructor(protected readonly transport: Transport) {
		this.channel = new CommandChannel(transport);
	}

	/**
	 * Design bitmap size: the official print preview div, PageLength x PageWidth at 11.3 dots/mm.
	 * print() centres it on the 144-dot print canvas (see tpComposeCanvas).
	 */
	canvasSize(label: LabelSpec) {
		return { width: Math.round(label.lengthMm * this.dpmm), height: Math.round(label.widthMm * this.dpmm) };
	}

	protected cmd(command: number, value = 0) {
		return this.channel.request([vendorCommand(command, value)]);
	}

	protected async query(command: number = TP_CMD.INQUIRY_STA, value = 0): Promise<TpStatus> {
		const s = parseTpStatus(await this.cmd(command, value));
		this.lastStatus = s;
		return s;
	}

	/** While a job runs this returns the job's latest status instead of interleaving a request. */
	async getStatus(): Promise<TpStatus> {
		if (this.job && this.lastStatus) return this.lastStatus;
		return this.query();
	}

	/** RD_LAB_DPI: feed calibration for the given catalog PaperType (see parseTpPrintDpmm). */
	async readPrintDpmm(paperType: number): Promise<number | undefined> {
		return parseTpPrintDpmm(await this.cmd(TP_CMD.RD_LAB_DPI), paperType);
	}

	protected assertOk(s: TpStatus) {
		if (s.errors.length) throw new PrinterError(s.errors.join(', '), 'device');
	}

	/**
	 * Bulk data. The TP firmware does not answer bulk transfers (the official TP code writes them
	 * with BulkWriteType(..., false) and never waits for a reply, unlike T50/SP/G), so the reports
	 * are written directly. An unexpected reply would be dropped by CommandChannel (no waiter).
	 */
	protected async bulk(data: Uint8Array) {
		await this.channel.send(CommandChannel.chunk(data));
	}

	/**
	 * The official cmdbuffull check first runs `first` ms after the bulk write started and then
	 * retries every `step` ms until all reports went out; resolve at that moment.
	 */
	protected async waitBulkCheck(t0: number, first: number, step: number, signal: AbortSignal) {
		const elapsed = Date.now() - t0;
		const k = elapsed <= first ? 0 : Math.ceil((elapsed - first) / step);
		const wait = t0 + first + k * step - Date.now();
		if (wait > 0) await sleep(wait, signal);
	}

	protected abstract encode(canvas: Bitmap, opts: TpEncodeOptions): Uint8Array[] | Uint8Array;
	/** Condition checkPrtSta waits for after START_PRINT. */
	protected abstract started(s: TpStatus): boolean;
	/** Transfer all labels (steps 6..10 of the official state machine). */
	protected abstract transfer(
		seq: (Uint8Array[] | Uint8Array)[],
		signal: AbortSignal,
		report: (phase: Phase, page: number) => void
	): Promise<void>;

	async print(pages: Bitmap[], label: LabelSpec, opts: PrintOptions): Promise<void> {
		if (!pages.length) return;
		if (this.job) throw new PrinterError('A print job is already running', 'busy');
		if (opts.signal?.aborted) throw new PrinterError('Cancelled', 'cancelled');
		const ctl = new AbortController();
		const onAbort = () => ctl.abort();
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		const done = this.run(pages, label, opts, ctl.signal);
		this.job = { ctl, done: done.catch(() => {}) };
		try {
			await done;
		} finally {
			this.job = null;
			opts.signal?.removeEventListener('abort', onAbort);
		}
	}

	private async run(pages: Bitmap[], label: LabelSpec, opts: PrintOptions, signal: AbortSignal) {
		const copies = Math.max(1, opts.copies | 0);
		const total = pages.length * copies;
		const density = Math.min(15, Math.max(0, opts.density | 0));
		const cutType = Number(opts.cutType ?? 0) | 0;
		const report = (phase: Phase, page: number) => opts.onProgress?.({ phase, page, pages: total });

		report('preparing', 0);
		try {
			// 0. printDPI: the official app reads RD_LAB_DPI when the print dialog opens.
			let printDpmm = TP_DESIGN_DPMM;
			try {
				printDpmm = (await this.readPrintDpmm(label.paperType)) ?? TP_DESIGN_DPMM;
				await sleep(100, signal);
			} catch (e) {
				if (e instanceof PrinterError && e.code === 'cancelled') throw e;
			}
			this.lastPrintDpmm = printDpmm;

			// Encode. The official print loop is collated (anyPrint): every page, then again per copy.
			const base = {
				density,
				cutType,
				paperType: label.paperType,
				tapeWidthMm: label.widthMm,
				paperDirection: label.paperDirection,
				offsetX: opts.offsetX,
				offsetY: opts.offsetY
			};
			const canvases = pages.map((p) => tpComposeCanvas(p, label.lengthMm, printDpmm));
			const encoded = canvases.map((c) => this.encode(c, { ...base, printEnd: false }));
			const seq: (Uint8Array[] | Uint8Array)[] = [];
			for (let c = 0; c < copies; c++) for (let i = 0; i < pages.length; i++) seq.push(encoded[i]);
			seq[seq.length - 1] = this.encode(canvases[pages.length - 1], { ...base, printEnd: true });

			// 1. CHECK_DEVICE with (material code << 8) + CutType.
			report('checking', 0);
			const mat = tpMaterialCode(label.paperType, label.widthMm);
			let s = await this.query(TP_CMD.CHECK_DEVICE, ((mat << 8) + cutType) & 0xffff);

			// 2. waitComOk: poll every 500 ms until the main CPU finished the command (21 polls max).
			for (let left = 20; ; ) {
				await sleep(500, signal);
				left--;
				s = await this.query();
				if (!s.commandExecuting) break;
				if (left < 0) throw new PrinterError('Device check timed out', 'timeout');
			}

			// 3./4. Check errors, start printing.
			this.assertOk(s);
			s = await this.query(TP_CMD.START_PRINT, START_PRINT_DEEPNESS << 8);

			// 5. checkPrtSta: poll every 500 ms (21 polls max).
			for (let left = 20; ; ) {
				await sleep(500, signal);
				left--;
				s = await this.query();
				if (this.started(s)) break;
				if (left < 0) {
					const why = s.errors.length ? `: ${s.errors.join(', ')}` : '';
					throw new PrinterError(`Failed to start printing${why}`, 'device');
				}
			}

			// 6.-10. Data.
			await this.transfer(seq, signal, report);

			// 11./12. waitNewPrint: poll every 500 ms until the printer stops printing (301 polls max).
			await sleep(100, signal);
			report('printing', total);
			for (let left = 300; ; ) {
				s = await this.query();
				report('printing', Math.min(total, s.pagesPrinted + 1));
				this.assertOk(s);
				if (!s.printing) {
					await this.query(); // printEnd step: one last status query
					break;
				}
				if (left <= 0) throw new PrinterError('Timed out waiting for printing to finish', 'timeout');
				await sleep(500, signal);
				left--;
			}
			report('done', total);
		} catch (e) {
			// Never leave the printer mid-job ('busy' means the running job is not ours).
			if (!(e instanceof PrinterError && e.code === 'busy')) await this.stopNow().catch(() => {});
			throw e;
		}
	}

	/** Official stopPrintManual/waitStopPrintManual. */
	private async stopNow() {
		let s = await this.query();
		if (!s.printing) return;
		s = await this.query(TP_CMD.STOP_PRINT, 0);
		for (let i = 0; i < 50 && s.printing && !s.errors.length; i++) {
			await sleep(500);
			s = await this.query();
		}
	}

	/** Cancel the running job (it sends STOP_PRINT), or stop the printer if it is printing. */
	async stop() {
		if (this.job) {
			this.job.ctl.abort();
			await this.job.done;
			return;
		}
		await this.stopNow();
	}

	/** Shared by both variants: wait between labels (handleNotify BUF_FULL -> handleTransferNext). */
	protected async waitNextLabel(signal: AbortSignal, report: (phase: Phase, page: number) => void, total: number) {
		await sleep(100 + 20, signal);
		for (;;) {
			const s = await this.query();
			report('sending', Math.min(total, s.pagesPrinted + 1));
			this.assertOk(s);
			if (!s.bufferFull) break;
			await sleep(500, signal);
		}
		await sleep(100, signal);
	}
}

/** Generic TP (TP76i): raw 226-column buffers, NEXTFRM_RAW. */
export class TpDriver extends TpFamilyDriver implements PrinterDriver {
	readonly family = 'tp' as const;

	protected encode(canvas: Bitmap, o: TpEncodeOptions) {
		return encodeTpLabel(canvas, o).buffers;
	}

	protected started(s: TpStatus) {
		return s.printing;
	}

	protected async transfer(seq: (Uint8Array[] | Uint8Array)[], signal: AbortSignal, report: (phase: Phase, page: number) => void) {
		let s = this.lastStatus!;
		for (let li = 0; li < seq.length; li++) {
			const buffers = seq[li] as Uint8Array[];
			if (li > 0) await this.waitNextLabel(signal, report, seq.length);
			report('sending', li + 1);
			for (let bi = 0; bi < buffers.length; bi++) {
				// handleTransferStep: send only while BufFull is clear, polling every 2 ms (51 retries).
				let left = 50;
				if (bi > 0) {
					await sleep(10, signal);
					this.assertOk(s);
					await sleep(2, signal);
					left--;
				}
				for (;;) {
					s = await this.query();
					this.assertOk(s);
					if (left < 0) throw new PrinterError('Printer buffer stayed full', 'timeout');
					if (!s.bufferFull) break;
					await sleep(2, signal);
					left--;
				}
				const buf = buffers[bi];
				s = await this.query(TP_CMD.NEXTFRM_RAW, buf.length);
				this.assertOk(s);
				await sleep(10, signal);
				const t0 = Date.now();
				await this.bulk(buf);
				await this.waitBulkCheck(t0, 100, 10, signal);
				await sleep(10, signal);
				await this.cmd(TP_CMD.BUF_FULL, 0); // reply content is ignored by the official code
			}
		}
	}
}

/** TP86A / TP80A: one LZMA stream per label, NEXTFRM_LZMA. */
export class Tp86aDriver extends TpFamilyDriver implements PrinterDriver {
	readonly family = 'tp86a' as const;

	protected encode(canvas: Bitmap, o: TpEncodeOptions) {
		return encodeTp86aLabel(canvas, o).stream;
	}

	protected started(s: TpStatus) {
		return !s.commandExecuting;
	}

	protected async transfer(seq: (Uint8Array[] | Uint8Array)[], signal: AbortSignal, report: (phase: Phase, page: number) => void) {
		let s = this.lastStatus!;
		for (let li = 0; li < seq.length; li++) {
			const stream = seq[li] as Uint8Array;
			if (li > 0) {
				await this.waitNextLabel(signal, report, seq.length);
				s = this.lastStatus!;
			}
			report('sending', li + 1);
			if (stream.length > BUF_LENGTH) console.warn(`[tp86a] label ${li + 1}: LZMA stream is ${stream.length} bytes (> 4096)`);
			// handleTransferStep -> sendMatrix -> cmdbuffull
			this.assertOk(s);
			s = await this.query(TP_CMD.NEXTFRM_LZMA, stream.length & 0xffff);
			this.assertOk(s);
			await sleep(100, signal);
			const t0 = Date.now();
			await this.bulk(stream);
			await this.waitBulkCheck(t0, 50, 200, signal);
			await sleep(100, signal);
			await this.cmd(TP_CMD.BUF_FULL, stream.length & 0xffff); // reply content is ignored
		}
	}
}
