/**
 * T50/T80 family (T50M, T50M Plus, T50M Pro, T50s, T80M, T80M Pro).
 * Port of t5080PrintUtils / t5080imageEncodeUtils / t5080ImageDataUtils from KatasymbolEditor.
 */
import { CommandChannel, sleep, vendorCommand } from '../channel';
import { cropRowsCentered, fromBitmap, offset, packColumns, rotate, type Grid } from '../bitmap';
import LZMA from '../lzma.js';
import type { Transport } from '../transport';
import {
	PrinterError,
	type Bitmap,
	type LabelSpec,
	type MediaInfo,
	type PrinterDriver,
	type PrinterStatus,
	type PrintOptions
} from '../types';

export const CMD = {
	BUF_FULL: 0x10,
	INQUIRY_STA: 0x11,
	CHECK_DEVICE: 0x12,
	START_PRINT: 0x13,
	STOP_PRINT: 0x14,
	RETURN_MAT: 0x30,
	NEXTFRM_BULK: 0x5c,
	SET_RFID_DATA: 0x5d
} as const;

const BUF_LENGTH = 4096;
/** Index labels are printed upside down by the official app. */
const ROTATE_180_LABELS = new Set(['5414', '5415']);

export function parseT5080Status(r: Uint8Array): PrinterStatus {
	const b = r.subarray(1, 9);
	const errors: string[] = [];
	const warnings: string[] = [];
	if (b[2] & 0x08) errors.push('Label cover is open');
	if (b[0] & 0x10) errors.push('Label roll is not installed correctly');
	if (b[0] & 0x02) errors.push('No label detected');
	if (b[0] & 0x04) errors.push('Out of labels');
	if (b[1] & 0x08) errors.push('Print head is too hot');
	if (b[0] & 0x08) warnings.push('Label not recognized');
	if (b[0] & 0x40) warnings.push('Low battery, please charge');
	if (b[0] & 0x20) warnings.push('Check remaining labels');
	return {
		raw: r,
		bufferFull: !!(b[0] & 0x01),
		busy: !!(b[1] & 0x04),
		printing: !!(b[2] & 0x40),
		coverOpen: !!(b[2] & 0x08),
		charging: !!(b[3] & 0x80),
		pagesPrinted: b[4] | (b[5] << 8),
		errors,
		warnings
	};
}

/** Page register byte pair (PAGE_REG_BITS.toByteArray with deviceType 0). */
function pageRegister(opts: { pageStart: boolean; pageEnd: boolean; printEnd: boolean; density: number; mat: number }) {
	let b0 = 0;
	if (opts.pageStart) b0 |= 0x02;
	if (opts.pageEnd) b0 |= 0x04;
	if (opts.printEnd) b0 |= 0x08;
	const b1 = ((opts.mat << 6) | (opts.density << 2)) & 0xff;
	return [b0 & 0x0f, b1];
}

export interface EncodedPage {
	/** LZMA streams, each sent with one NEXTFRM_BULK/BUF_FULL round. */
	chunks: Uint8Array[];
	/** Raw 4096-byte buffers before compression (for tests/debugging). */
	buffers: Uint8Array[];
	columns: number;
	bytesPerColumn: number;
}

const compress = (buf: Uint8Array): Uint8Array => Uint8Array.from(LZMA.compress(buf, 9) as number[], (b) => b & 0xff);

/** Prepare the column raster exactly like t5080ImageDataUtils.getAllBytes. */
export function t5080Raster(page: Bitmap, label: LabelSpec, headDots: number, opts: Pick<PrintOptions, 'offsetX' | 'offsetY'> = {}): Grid {
	let g = fromBitmap(page);
	if (ROTATE_180_LABELS.has(label.id) || label.className === '索引标签') g = rotate(g, 180);
	g = rotate(g, -90);
	g = offset(g, Math.round((opts.offsetX ?? 0) * 4), Math.round((opts.offsetY ?? 0) * 4));
	if (label.paperDirection === 0) g = rotate(g, 90);
	return cropRowsCentered(g, headDots);
}

export function encodeT5080Page(
	page: Bitmap,
	label: LabelSpec,
	opts: { density: number; headDots: number; printEnd: boolean; offsetX?: number; offsetY?: number }
): EncodedPage {
	const g = t5080Raster(page, label, opts.headDots, opts);
	const { bytes, bytesPerColumn } = packColumns(g);
	const columns = g.cols;
	const maxCols = Math.floor((BUF_LENGTH - 22) / bytesPerColumn);
	const bufferCount = Math.ceil(columns / maxCols);
	const buffers: Uint8Array[] = [];

	for (let i = 0; i < bufferCount; i++) {
		const last = i === bufferCount - 1;
		const cols = last ? columns - maxCols * i : maxCols;
		const buf = new Uint8Array(BUF_LENGTH);
		const reg = pageRegister({
			pageStart: i === 0,
			pageEnd: last,
			printEnd: last && opts.printEnd,
			density: opts.density,
			mat: label.paperType
		});
		buf[2] = reg[0];
		buf[3] = reg[1];
		buf[4] = cols & 0xff;
		buf[5] = (cols >> 8) & 0xff;
		buf[6] = bytesPerColumn & 0xff;
		buf[8] = 1; // leading margin
		buf[10] = 1;
		buf.set(bytes.subarray(maxCols * i * bytesPerColumn, (maxCols * i + cols) * bytesPerColumn), 14);

		// Checksum: header bytes 2..13 plus the last byte of every full 256-byte block.
		const len = cols * bytesPerColumn + 14;
		let sum = 0;
		for (let j = 2; j < 14; j++) sum += buf[j];
		for (let k = 0; k < Math.floor(len / 256); k++) sum += buf[(k + 1) * 256 - 1];
		buf[0] = sum & 0xff;
		buf[1] = (sum >> 8) & 0xff;
		buffers.push(buf);
	}

	// Small pages go out as one LZMA stream holding all buffers; big ones one stream per buffer.
	const separate = buffers.map(compress);
	const total = separate.reduce((n, c) => n + c.length, 0);
	let chunks = separate;
	if (total <= 4000) {
		const all = new Uint8Array(BUF_LENGTH * buffers.length);
		buffers.forEach((b, i) => all.set(b, i * BUF_LENGTH));
		const combined = compress(all);
		if (combined.length <= BUF_LENGTH) chunks = [combined];
	}
	return { chunks, buffers, columns, bytesPerColumn };
}

export class T5080Driver implements PrinterDriver {
	readonly family = 't5080' as const;
	readonly dpmm = 8;
	readonly channel: CommandChannel;

	constructor(
		transport: Transport,
		readonly headDots = 384
	) {
		this.channel = new CommandChannel(transport);
	}

	canvasSize(label: LabelSpec) {
		return { width: Math.round(label.lengthMm * this.dpmm), height: Math.round(label.widthMm * this.dpmm) };
	}

	private async cmd(command: number, value = 0, extra?: number) {
		return this.channel.request([vendorCommand(command, value, extra)]);
	}

	async getStatus() {
		return parseT5080Status(await this.cmd(CMD.INQUIRY_STA));
	}

	async readMedia(): Promise<MediaInfo | null> {
		const r = await this.cmd(CMD.RETURN_MAT);
		const labelId = r[16] | (r[17] << 8);
		const serial = String.fromCharCode(...Array.from(r.subarray(40, 56)).filter((c) => c >= 0x20 && c < 0x7f));
		const uuid = Array.from(r.subarray(1, 8), (b) => b.toString(16).padStart(2, '0')).join('');
		return {
			labelId,
			paperType: r[18],
			widthMm: r[19],
			lengthMm: r[20],
			gap: r[21],
			uuid,
			deviceSerial: serial,
			raw: r
		};
	}

	private assertOk(s: PrinterStatus) {
		if (s.errors.length) throw new PrinterError(s.errors.join(', '), 'device');
	}

	async print(pages: Bitmap[], label: LabelSpec, opts: PrintOptions) {
		const { signal, onProgress } = opts;
		const copies = Math.max(1, opts.copies | 0);
		const total = pages.length * copies;
		const density = Math.min(15, Math.max(0, opts.density | 0));
		const report = (phase: Parameters<NonNullable<PrintOptions['onProgress']>>[0]['phase'], page: number, message?: string) =>
			onProgress?.({ phase, page, pages: total, message });

		report('preparing', 0);
		const encode = (p: Bitmap, printEnd: boolean) =>
			encodeT5080Page(p, label, { density, headDots: this.headDots, printEnd, offsetX: opts.offsetX, offsetY: opts.offsetY });
		const encodedPages = pages.map((p) => encode(p, false));
		const lastPage = encode(pages[pages.length - 1], true);
		const sequence: EncodedPage[] = [];
		for (let i = 0; i < pages.length; i++) for (let c = 0; c < copies; c++) sequence.push(encodedPages[i]);
		sequence[sequence.length - 1] = lastPage;

		// 1. Check device, then wait for the main CPU to finish the USB command.
		report('checking', 0);
		await this.cmd(CMD.CHECK_DEVICE);
		let s: PrinterStatus;
		for (let tries = 20; ; tries--) {
			await sleep(500, signal);
			s = await this.getStatus();
			if (!s.busy) break;
			if (tries <= 0) throw new PrinterError('Printer stayed busy', 'timeout');
		}
		this.assertOk(s);
		if (s.printing) throw new PrinterError('Printer is already printing, try again shortly', 'busy');

		// 2. Start print job.
		await this.cmd(CMD.START_PRINT, 1);

		try {
			for (let p = 0; p < sequence.length; p++) {
				const page = sequence[p];
				const speed = page.chunks.length > 1 ? 20 : 60;
				report('sending', p + 1);
				if (p > 0) {
					// Wait for the previous page to leave the buffer.
					for (;;) {
						s = await this.getStatus();
						this.assertOk(s);
						if (!s.bufferFull) break;
						if (!s.printing) throw new PrinterError('Printing was stopped on the device', 'stopped');
						await sleep(50, signal);
					}
				}
				for (const chunk of page.chunks) {
					for (let tries = 400; ; tries--) {
						s = await this.getStatus();
						this.assertOk(s);
						if (!s.bufferFull) break;
						if (tries <= 0) throw new PrinterError('Printer buffer stayed full', 'timeout');
						await sleep(20, signal);
					}
					await this.cmd(CMD.NEXTFRM_BULK, chunk.length);
					await this.channel.request(CommandChannel.chunk(chunk), 10000);
					await sleep(100, signal);
					await this.cmd(CMD.BUF_FULL, chunk.length, speed);
					await sleep(100, signal);
				}
			}

			// 3. Wait until everything has printed.
			report('printing', total);
			for (let tries = 0; tries < 240; tries++) {
				s = await this.getStatus();
				if (s.errors.length) throw new PrinterError(s.errors.join(', '), 'device');
				report('printing', Math.min(total, s.pagesPrinted + 1));
				if (!s.printing) break;
				await sleep(500, signal);
			}
			report('done', total);
		} catch (e) {
			if (e instanceof PrinterError && e.code === 'cancelled') await this.stop().catch(() => {});
			throw e;
		}
	}

	async stop() {
		const s = await this.getStatus();
		if (s.printing) await this.cmd(CMD.STOP_PRINT);
	}
}
