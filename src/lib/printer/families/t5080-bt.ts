/**
 * T50/T80 printers over classic Bluetooth (SPP/RFCOMM, via Web Serial in the browser).
 *
 * Ported from the Katasymbol Android app (com.supvan.katasymbol 1.4.29): BluetoothUtils,
 * BasePrint.sendCmd/sendCmdStartTrans/transferSplitData and T50PlusPrint.doPrint/transfer.
 * The print buffers are the same 4096-byte LZMA-compressed buffers as over USB; only the framing,
 * pacing and a few command arguments differ:
 *   - every command/reply is a "7E 5A" frame (not the USB C0 40 vendor frame);
 *   - data goes as 512-byte frames (500 payload bytes) announced by 0x5C(512, packets);
 *   - START_PRINT takes 0, and the app waits for the printing bit before sending data;
 *   - up to 8 buffers per LZMA chunk, speed n*6+3 or 51 (see btChunkT5080Page).
 */
import { sleep } from '../channel';
import { buildT5080Buffers, btChunkT5080Page, parseT5080Status, CMD } from './t5080';
import type { ByteTransport } from '../serial';
import {
	PrinterError,
	type Bitmap,
	type LabelSpec,
	type MediaInfo,
	type PrinterDriver,
	type PrinterStatus,
	type PrintOptions
} from '../types';

export const BT_CMD = { ...CMD, READ_REV: 0x17, RD_DEV_NAME: 0x16, READ_FWVER: 0xc5 } as const;

const sum16 = (b: Uint8Array, from: number, to: number) => {
	let s = 0;
	for (let i = from; i < to; i++) s += b[i];
	return s & 0xffff;
};

/** 16-byte command frame: 7E 5A 0C 00 10 01 AA <cmd> <sum LE> 00 01 <a LE16> <b LE16>. */
export function btCommandFrame(cmd: number, a = 0, b = 0): Uint8Array {
	const f = new Uint8Array(16);
	f.set([0x7e, 0x5a, 0x0c, 0x00, 0x10, 0x01, 0xaa, cmd & 0xff, 0, 0, 0x00, 0x01, a & 0xff, (a >> 8) & 0xff, b & 0xff, (b >> 8) & 0xff]);
	const s = sum16(f, 10, 16);
	f[8] = s & 0xff;
	f[9] = s >> 8;
	return f;
}

/**
 * Split an LZMA stream into 512-byte data frames:
 * 7E 5A FC 01 10 02 | AA BB <sum LE> <index> <count> <500 data bytes>, sum over index..end.
 * The app leaves stale bytes in the last frame's unused tail; we zero-fill it (the printer takes
 * the real length from BUF_FULL).
 */
export function btDataFrames(stream: Uint8Array): Uint8Array[] {
	const count = Math.ceil(stream.length / 500);
	const frames: Uint8Array[] = [];
	for (let i = 0; i < count; i++) {
		const f = new Uint8Array(512);
		f.set([0x7e, 0x5a, 0xfc, 0x01, 0x10, 0x02, 0xaa, 0xbb]);
		f[10] = i & 0xff;
		f[11] = count & 0xff;
		f.set(stream.subarray(i * 500, Math.min(stream.length, (i + 1) * 500)), 12);
		const s = sum16(f, 10, 512);
		f[8] = s & 0xff;
		f[9] = s >> 8;
		frames.push(f);
	}
	return frames;
}

export interface FrameChannelOptions {
	/** Default true (classic Bluetooth); false for BLE. */
	acksDataFrames?: boolean;
	/** Reply timeout for commands (default 2000 ms like the app over SPP; the app uses 4 s on BLE). */
	commandTimeoutMs?: number;
}

/**
 * Request/response channel over the Bluetooth byte stream. Replies are reassembled from the
 * length field (u16 LE at [2..3], plus 4) and matched to their request by the echoed command
 * byte at [7]. Like the app, input left over from earlier exchanges is discarded before each
 * write.
 */
export class FrameChannel {
	private pending = new Uint8Array(0);
	private frames: Uint8Array[] = [];
	private wake: (() => void) | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private unsubscribe: () => void;
	debug = false;
	/** Where debug lines go (defaults to console.debug). */
	log: (line: string) => void = (line) => console.debug(line);
	/**
	 * Whether the printer answers every 512-byte data frame. It does over classic Bluetooth, where
	 * the app reads one reply per frame; over BLE it doesn't (BasePrint.transferSplitData never
	 * waits there), so waiting would stall each frame for the full timeout.
	 */
	readonly acksDataFrames: boolean;
	readonly commandTimeoutMs: number;

	constructor(
		readonly transport: ByteTransport,
		opts: FrameChannelOptions = {}
	) {
		this.acksDataFrames = opts.acksDataFrames ?? true;
		this.commandTimeoutMs = opts.commandTimeoutMs ?? 2000;
		this.unsubscribe = transport.onData((chunk) => this.receive(chunk));
	}

	dispose() {
		this.unsubscribe();
	}

	private receive(chunk: Uint8Array) {
		const buf = new Uint8Array(this.pending.length + chunk.length);
		buf.set(this.pending);
		buf.set(chunk, this.pending.length);
		let i = 0;
		for (;;) {
			while (i + 1 < buf.length && !(buf[i] === 0x7e && buf[i + 1] === 0x5a)) i++;
			if (i + 4 > buf.length) break;
			const total = (buf[i + 2] | (buf[i + 3] << 8)) + 4;
			if (total < 8 || total > 2048) {
				i++; // not a plausible frame header; resync
				continue;
			}
			if (i + total > buf.length) break;
			const frame = buf.slice(i, i + total);
			if (this.debug) this.log(`<- ${hexs(frame.subarray(0, 32))}${frame.length > 32 ? ` … (${frame.length} bytes)` : ''}`);
			this.frames.push(frame);
			i += total;
		}
		this.pending = buf.slice(i);
		this.wake?.();
	}

	/** Drop received but unclaimed input (the app's clear()). */
	private clear() {
		this.frames = [];
		this.pending = new Uint8Array(0);
	}

	private async write(data: Uint8Array) {
		if (this.debug) this.log(`-> ${hexs(data.subarray(0, 16))}${data.length > 16 ? ` … (${data.length} bytes)` : ''}`);
		await this.transport.write(data);
	}

	/** Wait for the first frame accepted by `match` (others are dropped); null on timeout. */
	private async next(match: (f: Uint8Array) => boolean, timeoutMs: number): Promise<Uint8Array | null> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			while (this.frames.length) {
				const f = this.frames.shift()!;
				if (match(f)) return f;
			}
			const left = deadline - Date.now();
			if (left <= 0) return null;
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, left);
				this.wake = () => {
					clearTimeout(t);
					resolve();
				};
			});
			this.wake = null;
		}
	}

	private serialize<T>(run: () => Promise<T>): Promise<T> {
		const p = this.queue.then(run, run);
		this.queue = p.catch(() => {});
		return p;
	}

	/** Send a command and wait for the reply echoing it. Retries once, like BasePrint.sendCmd. */
	command(cmd: number, a = 0, b = 0, timeoutMs = this.commandTimeoutMs, retry = true): Promise<Uint8Array> {
		return this.serialize(async () => {
			for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
				this.clear();
				await this.write(btCommandFrame(cmd, a, b));
				await sleep(10);
				const reply = await this.next((f) => f[7] === cmd, timeoutMs);
				if (reply) return reply;
			}
			throw new PrinterError('Printer did not respond over Bluetooth', 'timeout');
		});
	}

	/**
	 * Send one LZMA chunk: 0x5C(512, packets), then each 512-byte frame as 4 writes of 128 bytes
	 * about 10 ms apart, as T50PlusPrint.transfer does. Over classic Bluetooth one reply per frame
	 * is read (and ignored); over BLE the printer sends none.
	 */
	sendChunk(stream: Uint8Array, signal?: AbortSignal): Promise<void> {
		return this.serialize(async () => {
			const frames = btDataFrames(stream);
			this.clear();
			await this.write(btCommandFrame(CMD.NEXTFRM_BULK, 512, frames.length));
			await sleep(10);
			await this.next((f) => f[7] === CMD.NEXTFRM_BULK, this.commandTimeoutMs);
			await this.writeFrames(frames, 128, 0, signal);
		});
	}

	/**
	 * Send already announced data frames, each as `pieceSize` writes 10 ms apart (plus `pauseMs`
	 * before every piece after the first, like BasePrint.transferSplitData), reading one reply per
	 * frame where the link acknowledges them.
	 */
	sendFrames(frames: Uint8Array[], opts: { pieceSize: number; pauseMs?: number }, signal?: AbortSignal): Promise<void> {
		return this.serialize(() => this.writeFrames(frames, opts.pieceSize, opts.pauseMs ?? 0, signal));
	}

	private async writeFrames(frames: Uint8Array[], pieceSize: number, pauseMs: number, signal?: AbortSignal) {
		for (const f of frames) {
			if (signal?.aborted) throw new PrinterError('Cancelled', 'cancelled');
			this.clear();
			for (let o = 0; o < f.length; o += pieceSize) {
				if (o && pauseMs) await sleep(pauseMs);
				await this.write(f.subarray(o, o + pieceSize));
				await sleep(10);
			}
			if (this.acksDataFrames) await this.next(() => true, 2000);
		}
	}
}

const hexs = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join(' ');

/** Status block of a reply frame ([14..21]) in the USB report layout (bytes 1..8). */
function asUsbReport(frame: Uint8Array): Uint8Array {
	const r = new Uint8Array(64);
	r.set(frame.subarray(14, 22), 1);
	return r;
}

/** Battery bars (0..4) from the INQUIRY voltage, using the app's one- or two-cell scale. */
function batteryLevel(volts: number): number {
	const steps = volts < 5 ? [3.7, 3.8, 3.9, 3.95] : [6.8, 7.4, 7.6, 7.88];
	return steps.filter((s) => volts > s).length;
}

/** The app's devCheckErrMsg for Bluetooth printing: every one of these aborts the job. */
function btPrintErrors(s: PrinterStatus): string | null {
	const b = s.raw.subarray(1, 9);
	if (b[1] & 0x08) return 'Print head is too hot';
	if (b[2] & 0x08) return 'Label cover is open';
	if (b[0] & 0x10) return 'Label roll is not installed correctly';
	if (b[0] & 0x20) return 'Check remaining labels';
	if (b[0] & 0x02) return 'No label detected';
	if (b[0] & 0x08) return 'Label not recognized';
	if (b[0] & 0x04) return 'Out of labels';
	return null;
}

export class T5080BtDriver implements PrinterDriver {
	readonly family = 't5080' as const;
	readonly dpmm = 8;
	readonly channel: FrameChannel;

	constructor(
		transport: ByteTransport,
		readonly headDots = 384,
		channelOptions: FrameChannelOptions = {}
	) {
		this.channel = new FrameChannel(transport, channelOptions);
	}

	canvasSize(label: LabelSpec) {
		return { width: Math.round(label.lengthMm * this.dpmm), height: Math.round(label.widthMm * this.dpmm) };
	}

	async getStatus(): Promise<PrinterStatus> {
		const f = await this.channel.command(BT_CMD.INQUIRY_STA);
		const s = parseT5080Status(asUsbReport(f));
		if (f.length >= 26) {
			const volts = (f[24] | (f[25] << 8)) / 1000;
			if (volts > 0) {
				s.batteryVolts = volts;
				s.batteryLevel = batteryLevel(volts);
			}
		}
		return s;
	}

	/** Label info (RETURN_MAT). Data starts at [22], i.e. USB report offset + 21. */
	async readMedia(): Promise<MediaInfo | null> {
		const f = await this.channel.command(BT_CMD.RETURN_MAT, 0, 0, undefined, false);
		const at = (usbOffset: number) => f[usbOffset + 21] ?? 0;
		const labelId = at(16) | (at(17) << 8);
		const uuidBytes: number[] = [];
		for (let i = 1; i <= 7 && at(i); i++) uuidBytes.push(at(i));
		const gap = at(21);
		return {
			labelId,
			paperType: at(18),
			lengthMm: at(19),
			widthMm: at(20),
			gap: gap > 8 ? 3 : gap,
			uuid: uuidBytes.map((b) => b.toString(16).padStart(2, '0')).join('').padEnd(14, '0'),
			raw: f
		};
	}

	/**
	 * Wait until the link carries replies. The first command after opening the RFCOMM channel is
	 * often lost or answered late while the connection settles, so poll status a few times.
	 */
	async handshake(attempts = 6): Promise<PrinterStatus> {
		let last: unknown;
		for (let i = 0; i < attempts; i++) {
			try {
				const f = await this.channel.command(BT_CMD.INQUIRY_STA, 0, 0, 1500, false);
				const s = parseT5080Status(asUsbReport(f));
				return s;
			} catch (e) {
				last = e;
				await sleep(300);
			}
		}
		throw last instanceof Error ? last : new PrinterError('Printer did not respond over Bluetooth', 'timeout');
	}

	/** Bluetooth device name, e.g. "T0148B2507018663" (RD_DEV_NAME 0x16). */
	async readDeviceName(): Promise<string> {
		const f = await this.channel.command(BT_CMD.RD_DEV_NAME);
		const len = Math.max(0, (f[2] | (f[3] << 8)) - 18);
		return String.fromCharCode(...Array.from(f.subarray(22, 22 + len)).filter((c) => c >= 0x20 && c < 0x7f));
	}

	private async inquire(): Promise<PrinterStatus> {
		return this.getStatus();
	}

	private assertPrintable(s: PrinterStatus) {
		const err = btPrintErrors(s);
		if (err) throw new PrinterError(err, 'device');
	}

	async print(pages: Bitmap[], label: LabelSpec, opts: PrintOptions) {
		const { signal, onProgress } = opts;
		const copies = Math.max(1, opts.copies | 0);
		const total = pages.length * copies;
		const density = Math.min(15, Math.max(0, opts.density | 0));
		const report = (phase: Parameters<NonNullable<PrintOptions['onProgress']>>[0]['phase'], page: number) =>
			onProgress?.({ phase, page, pages: total });

		report('preparing', 0);
		// Collated copies; only the very last page carries the end-of-job flag.
		const sequence: { chunks: Uint8Array[]; speed: number }[] = [];
		for (let c = 0; c < copies; c++) {
			for (let p = 0; p < pages.length; p++) {
				const last = c === copies - 1 && p === pages.length - 1;
				const { buffers } = buildT5080Buffers(pages[p], label, {
					density,
					headDots: this.headDots,
					printEnd: last,
					offsetX: opts.offsetX,
					offsetY: opts.offsetY
				});
				sequence.push(btChunkT5080Page(buffers));
			}
		}

		// 1. Check device, then wait (100 ms polls, up to 60) until it is no longer busy.
		report('checking', 0);
		await this.channel.command(BT_CMD.CHECK_DEVICE);
		let s: PrinterStatus;
		for (let tries = 0; ; tries++) {
			await sleep(100, signal);
			s = await this.inquire();
			if (s.printing) throw new PrinterError('Printer is already printing, try again shortly', 'busy');
			if (!s.busy) break;
			if (tries >= 60) throw new PrinterError('Printer stayed busy', 'timeout');
		}
		this.assertPrintable(s);

		// 2. Start (argument 0 on Bluetooth) and wait for the printing bit.
		await this.channel.command(BT_CMD.START_PRINT, 0);
		try {
			for (let tries = 0; ; tries++) {
				await sleep(100, signal);
				s = await this.inquire();
				this.assertPrintable(s);
				if (s.printing) break;
				if (tries >= 60) throw new PrinterError('Printer did not start printing', 'timeout');
			}

			// 3. Send every chunk when the buffer has room (20 ms status polls).
			for (let p = 0; p < sequence.length; p++) {
				report('sending', p + 1);
				const { chunks, speed } = sequence[p];
				for (const chunk of chunks) {
					for (;;) {
						s = await this.inquire();
						this.assertPrintable(s);
						if (!s.printing && !s.busy && !s.warnings.includes('Low battery, please charge'))
							throw new PrinterError('Printing was stopped on the device', 'stopped');
						if (!s.bufferFull) break;
						await sleep(20, signal);
					}
					await this.channel.sendChunk(chunk, signal);
					await sleep(20, signal);
					await this.channel.command(BT_CMD.BUF_FULL, chunk.length, speed);
				}
			}

			// 4. Wait until printing has finished (100 ms polls).
			report('printing', total);
			for (let tries = 0; tries < 1200; tries++) {
				await sleep(100, signal);
				s = await this.inquire();
				this.assertPrintable(s);
				report('printing', Math.min(total, s.pagesPrinted + 1));
				if (!s.printing && !s.busy) break;
			}
			report('done', total);
		} catch (e) {
			await this.stop().catch(() => {});
			throw e;
		}
	}

	/** stopPrint: STOP if printing, then poll every 20 ms (up to 50 times) until it stops. */
	async stop() {
		let s = await this.inquire();
		if (!s.printing) return;
		await this.channel.command(BT_CMD.STOP_PRINT);
		for (let i = 0; i < 50 && s.printing; i++) {
			await sleep(20);
			s = await this.inquire();
		}
	}
}
