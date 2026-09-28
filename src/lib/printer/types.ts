export type Family = 't5080' | 'sp' | 'tp' | 'tp86a' | 'g' | 't15';

/** 1 byte per pixel, row-major, 1 = black dot. Rendered at the printer's dots-per-mm. */
export interface Bitmap {
	width: number;
	height: number;
	data: Uint8Array;
}

export interface Padding {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

/**
 * A label/consumable, mirroring the official app's MatModel. The design canvas is
 * lengthMm wide by widthMm tall (the app's TapeLength x TapeWidth).
 */
export interface LabelSpec {
	id: string;
	name: string;
	text?: string;
	/** Design width in mm (TapeLength). */
	lengthMm: number;
	/** Design height in mm (TapeWidth). */
	widthMm: number;
	/** 1 = design x axis runs across the print head, 0 = rotated 90 degrees. */
	paperDirection: number;
	/** 0 continuous, 1 die-cut, 12 black mark, 13 black-mark card, 14 ... (family specific). */
	paperType: number;
	gap: number;
	padding: Padding;
	className?: string;
	/** Everything else from the catalog entry, for family drivers that need it. */
	extra?: Record<string, unknown>;
}

export interface PrintOptions {
	/** 1..9 on the T50/T80 family. */
	density: number;
	copies: number;
	/** Horizontal/vertical offset in the official dialog's slider units (4 dots each, -48..48). */
	offsetX?: number;
	offsetY?: number;
	/** Family specific (e.g. SP/TP cut mode). */
	cutType?: number;
	signal?: AbortSignal;
	onProgress?: (p: PrintProgress) => void;
}

export interface PrintProgress {
	phase: 'preparing' | 'checking' | 'sending' | 'printing' | 'finishing' | 'done';
	page: number;
	pages: number;
	message?: string;
}

export interface PrinterStatus {
	raw: Uint8Array;
	busy: boolean;
	printing: boolean;
	bufferFull: boolean;
	pagesPrinted: number;
	/** Errors that block printing. */
	errors: string[];
	/** Non-blocking warnings (low battery, check label remaining...). */
	warnings: string[];
	charging?: boolean;
	coverOpen?: boolean;
	/** Battery voltage and 0..4 bars, when the connection reports them (Bluetooth). */
	batteryVolts?: number;
	batteryLevel?: number;
}

export interface MediaInfo {
	labelId: number;
	paperType?: number;
	gap?: number;
	uuid?: string;
	deviceSerial?: string;
	/** Label size as the printer reports it: across the tape (TapeWidth) and along it (TapeLength). */
	widthMm?: number;
	lengthMm?: number;
	raw: Uint8Array;
}

export interface PrinterDriver {
	readonly family: Family;
	/** Dots per mm. */
	readonly dpmm: number;
	/** Print head width in dots. */
	readonly headDots: number;
	getStatus(): Promise<PrinterStatus>;
	readMedia?(): Promise<MediaInfo | null>;
	print(pages: Bitmap[], label: LabelSpec, opts: PrintOptions): Promise<void>;
	/** Stop whatever the printer is printing (sends STOP only if it reports printing). */
	stop?(): Promise<void>;
	/** Design canvas size (in dots) the driver expects for a label. */
	canvasSize(label: LabelSpec): { width: number; height: number };
}

export class PrinterError extends Error {
	constructor(
		message: string,
		readonly code: string = 'error'
	) {
		super(message);
		this.name = 'PrinterError';
	}
}
