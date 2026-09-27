/**
 * G family: G11 Pro, G15 Pro, G15M Pro, G18 Pro, G21 (8 dots/mm) and G25, G28 (11.8 dots/mm).
 * Port of gPrintUtils / gImageEncodeUtils / gImageDataUtils / gPrintFlag and of the G branch of
 * PcEdit.vue createPrintData() from KatasymbolEditor.
 *
 * Pipeline per page (all pure functions exported for tests):
 *   gCanvas()      createPrintData: crop the padding off the full label image (plus the sign-label
 *                  and continuous-tape auto-length special cases) -> design canvas + Width/Height in mm
 *   gRaster()      gImageDataUtils.getAllBytes: rotate/offset/rotate into print orientation, clamp
 *                  to the head width
 *   encodeGRaster  gImageEncodeUtils.getEncodeData: column packing, 4000/4096-byte buffers with a
 *                  14-byte header + checksum, one LZMA stream per buffer
 *
 * 8 dots/mm output is byte-identical to the official encoder. The official 11.8 dots/mm path is
 * broken (non-integer array lengths throw a RangeError, and the bytes-per-column header assumes
 * 8 dots/mm), so for G25/G28 this driver keeps the official geometry but uses integer sizes and a
 * consistent bytes-per-column. That part is untested against hardware.
 */
import { CommandChannel, sleep, vendorCommand } from '../channel';
import { cropRowsCentered, offset, packColumns, rotate, type Grid } from '../bitmap';
import LZMA from '../lzma.js';
import type { Transport } from '../transport';
import {
	PrinterError,
	type Bitmap,
	type LabelSpec,
	type MediaInfo,
	type PrinterDriver,
	type PrinterStatus,
	type PrintOptions,
	type PrintProgress
} from '../types';

export const G_CMD = {
	BUF_FULL: 0x10,
	INQUIRY_STA: 0x11,
	CHECK_DEVICE: 0x12,
	START_PRINT: 0x13,
	STOP_PRINT: 0x14,
	RETURN_MAT: 0x30,
	NEXTFRM_BULK: 0x5c
} as const;

/** BUF_FULL second word. gPrintUtils.speed is a constant 60 (the T50 family switches to 20). */
const G_SPEED = 60;

export interface GModel {
	name: string;
	/** Dots per mm (printDPI and gImageEncodeUtils.mFDpiValue agree for every G model). */
	dpmm: number;
	/** gImageEncodeUtils.maxDotValue. */
	headDots: number;
	/** gImageEncodeUtils _bufLength. */
	bufLength: number;
}

const G11: GModel = { name: 'G11 Pro', dpmm: 8, headDots: 96, bufLength: 4000 };
const G18: GModel = { name: 'G18 Pro', dpmm: 8, headDots: 96, bufLength: 4000 };

/** HidUsbCtrlFunc.getDevType + getPrinterName + gImageEncodeUtils per-model constants. */
export const G_MODELS: Record<number, GModel> = {
	8336: G11, // 0x2090
	8342: G11, // 0x2096
	8337: G18, // 0x2091
	8343: G18, // 0x2097
	16392: { ...G18, name: 'CG113' }, // 0x4008, devtype G18 Pro
	16393: { ...G18, name: 'XG116' }, // 0x4009, devtype G18 Pro
	8338: { name: 'G15 Pro', dpmm: 8, headDots: 96, bufLength: 4000 }, // 0x2092
	8339: { name: 'G15M Pro', dpmm: 8, headDots: 96, bufLength: 4000 }, // 0x2093
	8340: { name: 'G21', dpmm: 8, headDots: 176, bufLength: 4096 }, // 0x2094
	8341: { name: 'G28', dpmm: 11.8, headDots: 246, bufLength: 4096 }, // 0x2095
	8344: { name: 'G25', dpmm: 11.8, headDots: 288, bufLength: 4096 } // 0x2098
};

/** gImageDataUtils.gchanrao: wrap-around cable labels, printed rotated by a further 270 degrees. */
export const G_WRAP_LABELS = new Set(['118030', '118031']);
/** PcEdit gbiaoshipai: sign labels, whose printable length is forced to 42 - 2 - 2 mm. */
export const G_SIGN_LABELS = new Set(['118063', '118064']);
/** shareMemery.gAutoLengthMin: minimum page length (mm) the editor uses in auto-length mode. */
export const G_AUTO_LENGTH_MIN_MM = 18;

// ---------------------------------------------------------------------------------------------
// Status

/** gPrintFlag.Refresh: bytes 1..8 of every reply. */
export interface GFlags {
	BufFull: boolean;
	MatFixErr: boolean;
	MatOver: boolean;
	MatXhErr: boolean;
	OptMatErr: boolean;
	MoPrting: boolean;
	BatLow: boolean;
	ChkMatOk: boolean;
	SysErr: boolean;
	DPISetErr: boolean;
	ComExeSta: boolean;
	MatMoveOut: boolean;
	Cuting: boolean;
	RdLibErr: boolean;
	FileBad: boolean;
	CutEnd: boolean;
	pBuf0Full: boolean;
	pBuf1Full: boolean;
	pBuf2Full: boolean;
	CoverOpen: boolean;
	PowerIn: boolean;
	MatEnd: boolean;
	PrtSta: boolean;
	sDevBusy: boolean;
	LabRwErr: boolean;
	qCutErr: boolean;
	qCutSta: boolean;
	OptErr: boolean;
	FirmwareNeedUpgrade: boolean;
	NeedAuthen: boolean;
	ChargeSta: boolean;
	pPageCnt: number;
	SendData: number;
}

export function parseGFlags(r: Uint8Array): GFlags {
	const b = (i: number) => r[i + 1] ?? 0;
	return {
		BufFull: !!(b(0) & 0x01), // print buffer full
		MatFixErr: !!(b(0) & 0x02), // label cassette not seated (read/write error)
		MatOver: !!(b(0) & 0x04), // optical sensor: labels used up
		MatXhErr: !!(b(0) & 0x08), // wrong label model
		OptMatErr: !!(b(0) & 0x10), // optical sensor sees no label / print cancelled locally
		MoPrting: !!(b(0) & 0x20),
		BatLow: !!(b(0) & 0x40),
		ChkMatOk: !!(b(0) & 0x80), // label check passed
		SysErr: !!(b(1) & 0x01),
		DPISetErr: !!(b(1) & 0x02),
		ComExeSta: !!(b(1) & 0x04), // a USB command is still executing
		MatMoveOut: !!(b(1) & 0x08), // label removed
		Cuting: !!(b(1) & 0x10),
		RdLibErr: !!(b(1) & 0x20),
		FileBad: !!(b(1) & 0x40),
		CutEnd: !!(b(1) & 0x80),
		pBuf0Full: !!(b(2) & 0x01),
		pBuf1Full: !!(b(2) & 0x02),
		pBuf2Full: !!(b(2) & 0x04),
		CoverOpen: !!(b(2) & 0x08),
		PowerIn: !!(b(2) & 0x10), // adapter/USB power present
		MatEnd: !!(b(2) & 0x20), // optical sensor: end of label
		PrtSta: !!(b(2) & 0x40), // printing
		sDevBusy: !!(b(2) & 0x80),
		LabRwErr: !!(b(3) & 0x01), // label read error
		qCutErr: !!(b(3) & 0x02),
		qCutSta: !!(b(3) & 0x0c),
		OptErr: !!(b(3) & 0x10), // improper operation
		FirmwareNeedUpgrade: !!(b(3) & 0x20),
		NeedAuthen: !!(b(3) & 0x40),
		ChargeSta: !!(b(3) & 0x80),
		pPageCnt: b(4) | (b(5) << 8),
		SendData: b(6) | (b(7) << 8)
	};
}

/** gPrintUtils.devCheckErrMsg, in its priority order. All of these stop a print job. */
const G_ERRORS: [keyof GFlags, string][] = [
	['BatLow', 'Low battery, please charge the printer'],
	['MatMoveOut', 'Please install the label roll'],
	['MatXhErr', 'Label not recognized, please replace it'],
	['CoverOpen', 'Cover is open'],
	['MatOver', 'Labels used up, please replace the roll'],
	['MatFixErr', 'Label roll is not installed correctly'],
	['OptMatErr', 'Label roll is not installed correctly'],
	['OptErr', 'Improper operation, printing stopped'],
	['LabRwErr', 'Label (consumable) error']
];

/** Flags the official app ignores for G; surfaced as non-blocking warnings only. */
const G_WARNINGS: [keyof GFlags, string][] = [
	['SysErr', 'Printer reported an internal error'],
	['FirmwareNeedUpgrade', 'Printer firmware needs an update'],
	['NeedAuthen', 'Printer requires online authentication']
];

export function parseGStatus(r: Uint8Array): PrinterStatus & { flags: GFlags } {
	const f = parseGFlags(r);
	const errors = [...new Set(G_ERRORS.filter(([k]) => f[k]).map(([, m]) => m))];
	const warnings = G_WARNINGS.filter(([k]) => f[k]).map(([, m]) => m);
	return {
		raw: r,
		busy: f.ComExeSta,
		printing: f.PrtSta,
		bufferFull: f.BufFull,
		pagesPrinted: f.pPageCnt,
		coverOpen: f.CoverOpen,
		charging: f.ChargeSta,
		errors,
		warnings,
		flags: f
	};
}

// ---------------------------------------------------------------------------------------------
// Image preparation (createPrintData G branch)

/**
 * ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh) onto a fresh canvas of canvasW x canvasH
 * (canvas sizes truncate like the DOM's unsigned long conversion). Nearest-neighbour sampling of
 * pixel centres; source pixels outside the image are transparent (white). For whole-pixel
 * offsets and 1:1 scale, as at 8 dots/mm with catalog labels, this is an exact copy.
 */
function drawImage(src: Bitmap, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number, canvasW = dw, canvasH = dh): Bitmap {
	const width = Math.max(0, Math.trunc(canvasW));
	const height = Math.max(0, Math.trunc(canvasH));
	const data = new Uint8Array(width * height);
	if (dw <= 0 || dh <= 0) return { width, height, data };
	const cols = new Int32Array(width).fill(-1);
	for (let x = 0; x < width && x + 0.5 < dw; x++) {
		const s = Math.floor(sx + ((x + 0.5) * sw) / dw);
		if (s >= 0 && s < src.width) cols[x] = s;
	}
	for (let y = 0; y < height && y + 0.5 < dh; y++) {
		const r = Math.floor(sy + ((y + 0.5) * sh) / dh);
		if (r < 0 || r >= src.height) continue;
		const row = r * src.width;
		for (let x = 0; x < width; x++) if (cols[x] >= 0) data[y * width + x] = src.data[row + cols[x]];
	}
	return { width, height, data };
}

/**
 * Snap float noise (within 1e-6 of an integer) to the integer. At 8 dots/mm the official
 * arithmetic is exact, so this changes nothing there; at 11.8 dots/mm it stops products like
 * 12 * 11.8 - 2 * 11.8 = 118.00000000000001 from costing a pixel or adding a blank mm.
 */
const snap = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v);

/** Rightmost black column + 1 (0 for an empty page). */
export function contentRight(page: Bitmap): number {
	for (let x = page.width - 1; x >= 0; x--) for (let y = 0; y < page.height; y++) if (page.data[y * page.width + x]) return x + 1;
	return 0;
}

export interface GCanvasOptions {
	dpmm: number;
	/**
	 * Page "auto length" (Page.IsAutoPageLength, off by default). Only honoured for continuous tape
	 * (paperType 0), like the official app. The printed length becomes the content's right edge.
	 */
	autoLength?: boolean;
	/** Auto length: content right edge in canvas pixels. Defaults to the last black column + 1. */
	contentRight?: number;
	/** The identified label is a sign label (G_SIGN_LABELS): printable length forced to 38 mm. */
	signLabel?: boolean;
}

/** What createPrintData hands to gImageEncodeUtils: the design image plus PrintModel.Width/Height. */
export interface GCanvas {
	image: Bitmap;
	/** PrintModel.Width = tapeLengthS / DPI (may be fractional). */
	widthMm: number;
	/** PrintModel.Height = ceil(tapeWidth / DPI). */
	heightMm: number;
}

/**
 * PcEdit.vue createPrintData(), G branch. `page` is the full label image (padding included, like
 * the official page div): round(lengthMm * dpmm) x round(widthMm * dpmm). The float arithmetic
 * is kept verbatim because it decides the canvas sizes.
 */
export function gCanvas(page: Bitmap, label: LabelSpec, o: GCanvasOptions): GCanvas {
	const dpi = o.dpmm;
	const auto = !!o.autoLength && label.paperType === 0;
	let pageLength = label.lengthMm;
	const pageWidth = label.widthMm;
	if (auto) {
		// resizeDivToFitContent: width = min(ceil(max right edge), 200 * dip) px; getWidthInDip: px / dip.
		const right = o.contentRight ?? contentRight(page);
		if (right > 0) pageLength = Math.min(Math.ceil(right), 200 * dpi) / dpi;
	}
	const width = pageLength * dpi;
	const height = pageWidth * dpi;
	const left = label.padding.left * dpi;
	const right = label.padding.right * dpi;
	const top = label.padding.top * dpi;
	const bottom = label.padding.bottom * dpi;

	// Auto length crops from the left padding but keeps the full content width.
	let tapeLengthS = snap(auto ? width : width - left - right);
	const tapeWidth = snap(height - top - bottom);
	const crop = drawImage(page, left, top, tapeLengthS, tapeWidth, tapeLengthS, tapeWidth); // cropImage()

	if (o.signLabel) tapeLengthS = snap((42 - 2 - 2) * dpi);

	// canvas = tapeLengthS x tapeWidth; drawImage(crop, 0, 0, tapeLengthS, tapeWidth); getImageData.
	const image = drawImage(crop, 0, 0, crop.width, crop.height, tapeLengthS, tapeWidth);
	return { image, widthMm: tapeLengthS / dpi, heightMm: Math.ceil(snap(tapeWidth / dpi)) };
}

// ---------------------------------------------------------------------------------------------
// Raster (gImageDataUtils.getAllBytes)

export interface GRasterOptions {
	dpmm: number;
	headDots: number;
	/** Official HorizontalOffset / VerticalOffset slider values (-48..48); shifted by value * 4 dots. */
	offsetX?: number;
	offsetY?: number;
}

/**
 * Returns rows = dots across the print head, cols = print columns along the tape.
 * For PaperDirection 0 (every G catalog label) the two rotations cancel out, so the result is
 * the design image itself (offset applied), plus white rows up to a whole mm, centre-cropped to
 * the head. Wrap labels (118030/118031) come out rotated by 270 degrees.
 */
export function gRaster(c: GCanvas, label: LabelSpec, o: GRasterOptions): Grid {
	let w = snap(c.widthMm * o.dpmm);
	let h = snap(c.heightMm * o.dpmm);
	// Official `new Array(w)` throws on non-integer sizes (which happens at 11.8 dots/mm):
	// fall back to the canvas truncation.
	if (!Number.isInteger(w)) w = Math.trunc(w);
	if (!Number.isInteger(h)) h = Math.trunc(h);
	// Pixel (i, j) is read at ImageData index i * w + j, i.e. with stride w over the canvas data;
	// reads past the end are white. (h is ceil'd to whole mm, so this pads white rows.)
	const data = new Uint8Array(w * h);
	data.set(c.image.data.subarray(0, Math.min(c.image.data.length, w * h)));
	let g: Grid = { rows: h, cols: w, data };

	if (G_WRAP_LABELS.has(String(label.id))) g = rotate(g, 270);
	g = rotate(g, -90); // PrintModel.Rotate 1 -> rotateAngle (1 - 2) * 90
	g = offset(g, Math.round((o.offsetX ?? 0) * 4), Math.round((o.offsetY ?? 0) * 4));
	if (label.paperDirection === 0) g = rotate(g, 90);
	return cropRowsCentered(g, o.headDots);
}

// ---------------------------------------------------------------------------------------------
// Encoding (gImageEncodeUtils.getEncodeData)

export interface GEncodeOptions {
	/** Print density, official 1..9 (default 4). */
	density: number;
	/** Label PaperType: 0 continuous, 1 gap/die-cut, 7 tube. */
	paperType: number;
	/** CutTypeEnum: 0 none, 1 line (dotted separator), 2 half (not sent by G), 3 full cut. */
	cutType?: number;
	/** Last page of the whole job (PAGE_REG PrtEnd). */
	printEnd: boolean;
	bufLength: number;
	/** MatModel.Padding.Left * DPI (float; the header keeps the truncated low byte). */
	marginDots: number;
}

export interface EncodedPage {
	/** One LZMA stream per buffer, each sent with one NEXTFRM_BULK / bulk / BUF_FULL round. */
	chunks: Uint8Array[];
	/** Raw buffers before compression (for tests/debugging). */
	buffers: Uint8Array[];
	columns: number;
	rows: number;
	bytesPerColumn: number;
}

const compress = (buf: Uint8Array): Uint8Array => Uint8Array.from(LZMA.compress(buf, 9), (b) => b & 0xff);

/** PAGE_REG_BITS.toByteArray(deviceType 0). */
function pageRegister(o: { pageStart: boolean; pageEnd: boolean; printEnd: boolean; cut: number; density: number; mat: number }) {
	let b0 = 0;
	if (o.pageStart) b0 |= 0x02;
	if (o.pageEnd) b0 |= 0x04;
	if (o.printEnd) b0 |= 0x08;
	b0 = ((b0 & 0x0f) | (o.cut << 4)) & 0xff;
	const b1 = ((o.mat << 6) | (o.density << 2)) & 0xff;
	return [b0, b1];
}

/** CutTypeEnum -> PAGE_REG Cut bits (Full 1, Line 2, None and anything else 0). */
const cutBits = (cutType = 0) => (cutType === 3 ? 1 : cutType === 1 ? 2 : 0);

export function encodeGRaster(g: Grid, o: GEncodeOptions): EncodedPage {
	const { bytes, bytesPerColumn } = packColumns(g);
	const columns = g.cols;
	const buffers: Uint8Array[] = [];
	if (!columns || !bytesPerColumn) return { chunks: [], buffers, columns, rows: g.rows, bytesPerColumn };
	const maxCols = Math.floor((o.bufLength - 22) / bytesPerColumn);
	const bufferCount = Math.ceil(columns / maxCols);
	const margin = o.marginDots;

	for (let i = 0; i < bufferCount; i++) {
		const last = i === bufferCount - 1;
		const cols = last ? columns - maxCols * i : maxCols;
		const buf = new Uint8Array(o.bufLength);
		const [r0, r1] = pageRegister({
			pageStart: i === 0,
			pageEnd: last,
			printEnd: last && o.printEnd,
			cut: cutBits(o.cutType),
			density: o.density,
			mat: o.paperType
		});
		buf.set(bytes.subarray(maxCols * i * bytesPerColumn, (maxCols * i + cols) * bytesPerColumn), 14);
		buf[2] = r0;
		buf[3] = r1;
		buf[4] = cols & 0xff;
		buf[5] = (cols >> 8) & 0xff;
		buf[6] = bytesPerColumn & 0xff;
		buf[8] = margin === 0 ? 1 : margin & 0xff; // leading margin (dots)
		buf[10] = margin & 0xff;

		// Checksum: header bytes 2..13 plus the last byte of every full 256-byte block.
		const len = ((buf[5] << 8) + buf[4]) * buf[6] + 14;
		let sum = 0;
		for (let j = 2; j < 14; j++) sum += buf[j];
		for (let k = 0; k < Math.floor(len / 256); k++) sum += buf[(k + 1) * 256 - 1];
		buf[0] = sum & 0xff;
		buf[1] = (sum >> 8) & 0xff;
		buffers.push(buf);
	}
	return { chunks: buffers.map(compress), buffers, columns, rows: g.rows, bytesPerColumn };
}

export interface GPageOptions extends GCanvasOptions, GRasterOptions, Omit<GEncodeOptions, 'paperType' | 'marginDots'> {}

/** Full page: label image -> LZMA chunks, as createPrintData + getEncodeData would produce. */
export function encodeGPage(page: Bitmap, label: LabelSpec, o: GPageOptions): EncodedPage {
	const raster = gRaster(gCanvas(page, label, o), label, o);
	return encodeGRaster(raster, { ...o, paperType: label.paperType, marginDots: label.padding.left * o.dpmm });
}

// ---------------------------------------------------------------------------------------------
// Driver

export interface GPrintOptions extends PrintOptions {
	/** Continuous tape only: print length = content extent (official page "auto length", default off). */
	autoLength?: boolean;
}

export interface GDriverOptions {
	/** Defaults from G_MODELS by the transport's product id (8 dots/mm if unknown). */
	dpmm?: number;
	headDots?: number;
	bufLength?: number;
}

export class GDriver implements PrinterDriver {
	readonly family = 'g' as const;
	readonly dpmm: number;
	readonly headDots: number;
	readonly bufLength: number;
	readonly modelName: string;
	readonly channel: CommandChannel;
	/** Last label identified by readMedia() (the official autoIdentifyMat). */
	media: MediaInfo | null = null;

	/**
	 * `opts` override the per-model constants (G_MODELS, keyed by USB product id). A falsy
	 * headDots (e.g. 0) also falls back to the table.
	 */
	constructor(transport: Transport, opts: GDriverOptions = {}) {
		const m = G_MODELS[transport.productId];
		this.dpmm = opts.dpmm || m?.dpmm || 8;
		this.headDots = opts.headDots || m?.headDots || 96;
		this.bufLength = opts.bufLength || m?.bufLength || (this.headDots <= 96 ? 4000 : 4096);
		this.modelName = m?.name ?? 'G series';
		this.channel = new CommandChannel(transport);
	}

	/**
	 * Canvas the UI renders: the full label, padding included, at this printer's resolution:
	 * round(lengthMm * dpmm) wide x round(widthMm * dpmm) tall, x along the tape. print() crops
	 * label.padding off (Left/Right along the tape, Top/Bottom across it) like createPrintData,
	 * so only the area inside the padding prints. The height across the head is padded with white
	 * to a whole mm, then centre-cropped to headDots. With GPrintOptions.autoLength on continuous
	 * tape, pages may be any width (official cap 200 mm) and the printed length follows the content.
	 */
	canvasSize(label: LabelSpec) {
		return { width: Math.round(label.lengthMm * this.dpmm), height: Math.round(label.widthMm * this.dpmm) };
	}

	private cmd(command: number, value = 0, extra?: number) {
		return this.channel.request([vendorCommand(command, value, extra)]);
	}

	async getStatus() {
		return parseGStatus(await this.cmd(G_CMD.INQUIRY_STA));
	}

	/**
	 * RETURN_MAT (0x30). Reply: bytes 1..8 status flags; bytes 31..32 label serial number (LE);
	 * device serial = ASCII from byte 11, at most 21 bytes (11..31), up to the first NUL. The
	 * catalog id is "118" + serial padded to 3 digits (e.g. 30 -> 118030); serial 0 = no label.
	 */
	async readMedia(): Promise<MediaInfo | null> {
		const r = await this.cmd(G_CMD.RETURN_MAT);
		const sn = r[31] + ((r[32] & 0xff) << 8);
		if (!(sn > 0)) {
			this.media = null;
			return null;
		}
		const chars: string[] = [];
		for (let i = 11; i < 32 && r[i] !== 0; i++) chars.push(String.fromCharCode(r[i]));
		this.media = { labelId: Number(`118${String(sn).padStart(3, '0')}`), deviceSerial: chars.join(''), raw: r };
		return this.media;
	}

	private assertOk(s: PrinterStatus) {
		if (s.errors.length) throw new PrinterError(s.errors.join(', '), 'device');
	}

	async print(pages: Bitmap[], label: LabelSpec, opts: GPrintOptions) {
		const { signal, onProgress } = opts;
		if (!pages.length) throw new PrinterError('Nothing to print', 'empty');
		const copies = Math.max(1, opts.copies | 0);
		const total = pages.length * copies;
		const report = (phase: PrintProgress['phase'], page: number, message?: string) => onProgress?.({ phase, page, pages: total, message });
		const guard = () => {
			if (signal?.aborted) throw new PrinterError('Cancelled', 'cancelled');
		};

		report('preparing', 0);
		const signLabel = G_SIGN_LABELS.has(String(this.media?.labelId ?? label.id));
		const encode = (p: Bitmap, printEnd: boolean) =>
			encodeGPage(p, label, {
				dpmm: this.dpmm,
				headDots: this.headDots,
				bufLength: this.bufLength,
				autoLength: opts.autoLength,
				signLabel,
				offsetX: opts.offsetX,
				offsetY: opts.offsetY,
				density: Math.min(15, Math.max(0, opts.density | 0)),
				cutType: opts.cutType ?? 0,
				printEnd
			});
		const encoded = pages.map((p) => encode(p, false));
		if (encoded.some((e) => !e.chunks.length)) throw new PrinterError('Nothing to print', 'empty');
		// Collated copies (the official print dialog always enables "print by copy").
		const sequence: EncodedPage[] = [];
		for (let c = 0; c < copies; c++) sequence.push(...encoded);
		sequence[total - 1] = encode(pages[pages.length - 1], true);

		const status = async () => {
			guard();
			return this.getStatus();
		};
		const send = async (command: number, value = 0, extra?: number) => {
			guard();
			return parseGStatus(await this.cmd(command, value, extra));
		};

		// Steps 1-3: device idle?, CHECK_DEVICE, wait until the main CPU finished the USB command.
		report('checking', 0);
		let s = await status();
		if (s.printing) throw new PrinterError('Printer is busy', 'busy');
		await send(G_CMD.CHECK_DEVICE);
		let budget = 20; // waitComOkNum, shared by both waits
		const waitFor = async (cond: (s: PrinterStatus) => boolean, message: string) => {
			for (;;) {
				if (budget < 0) throw new PrinterError(s.errors.length ? `${message}: ${s.errors.join(', ')}` : message, 'timeout');
				await sleep(500, signal);
				budget--;
				s = await status();
				if (cond(s)) return;
			}
		};
		await waitFor((s) => !s.busy, 'Device check timed out');
		this.assertOk(s);

		// Steps 4-5: START_PRINT, wait until the printer reports printing.
		await send(G_CMD.START_PRINT, 0);
		try {
			await waitFor((s) => s.printing, 'Start print command timed out');
			let fromInquiry = true;

			for (let p = 0; p < sequence.length; p++) {
				report('sending', p + 1);
				if (p > 0) {
					// handleTransferNext: wait for the previous page to leave the buffer.
					await sleep(100, signal);
					for (;;) {
						this.assertOk(s);
						if (!s.bufferFull) break;
						if (!s.printing) throw new PrinterError('Printing was stopped', 'stopped');
						await sleep(50, signal);
						s = await status();
						fromInquiry = true;
					}
					await sleep(100, signal);
				}
				const chunks = sequence[p].chunks;
				for (let c = 0; c < chunks.length; c++) {
					const chunk = chunks[c];
					// Step 6: transfer only right after a status query that shows a free buffer.
					for (let tries = 50; ; tries--) {
						this.assertOk(s);
						if (tries < 0) throw new PrinterError('Status query failed (printer buffer stayed full)', 'timeout');
						if (fromInquiry && !s.bufferFull) break;
						await sleep(100, signal);
						s = await status();
						fromInquiry = true;
					}
					s = await send(G_CMD.NEXTFRM_BULK, chunk.length);
					fromInquiry = false;
					this.assertOk(s);
					// Step 7: the LZMA stream as consecutive 64-byte reports, one reply at the end.
					await sleep(100, signal);
					guard();
					s = parseGStatus(await this.channel.request(CommandChannel.chunk(chunk), 10000));
					this.assertOk(s);
					// Step 8: BUF_FULL(length, speed).
					await sleep(100, signal);
					s = await send(G_CMD.BUF_FULL, chunk.length, G_SPEED);
					if (c < chunks.length - 1) await sleep(100, signal);
				}
			}

			// Step 10 (waitNewPrint): up to 20 polls, 500 ms apart, until all but the last page printed.
			report('printing', total);
			await sleep(100, signal);
			for (let n = 20; ; n--) {
				s = await status();
				this.assertOk(s);
				report('printing', Math.min(total, s.pagesPrinted + 1));
				if (s.pagesPrinted >= total - 1 || total === 1 || !s.printing || n <= 0) break;
				await sleep(500, signal);
			}
			// Steps 11/13 (printEnd/closePrint): poll every 500 ms until the printer stops printing.
			for (let tries = 0; ; tries++) {
				s = await status();
				if (!s.printing) break;
				if (tries >= 600) throw new PrinterError('Timed out waiting for the printer to finish', 'timeout');
				report('finishing', Math.min(total, s.pagesPrinted + 1));
				await sleep(500, signal);
			}
			this.assertOk(s);
			report('done', total);
		} catch (e) {
			// Never leave the printer mid-job ('busy' means the running job is not ours).
			if (!(e instanceof PrinterError && e.code === 'busy')) await this.stop().catch(() => {});
			throw e;
		}
	}

	/** Manual stop (steps 14/15/12): STOP_PRINT if printing, then poll up to 20 x 200 ms. */
	async stop() {
		let s = await this.getStatus();
		if (!s.printing) return;
		await this.cmd(G_CMD.STOP_PRINT);
		for (let i = 0; i < 20 && s.printing; i++) {
			await sleep(200);
			s = await this.getStatus();
		}
	}
}
