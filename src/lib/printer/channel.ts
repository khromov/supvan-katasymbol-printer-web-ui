import { REPORT_SIZE, type Transport } from './transport';
import { PrinterError } from './types';

export const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new PrinterError('Cancelled', 'cancelled'));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				reject(new PrinterError('Cancelled', 'cancelled'));
			},
			{ once: true }
		);
	});

/**
 * Request/response channel over the HID transport. Supvan firmware answers every command
 * (and every completed bulk transfer) with one input report, so requests are serialized and
 * each one resolves with the next report that arrives.
 */
export class CommandChannel {
	private queue: Promise<unknown> = Promise.resolve();
	private waiter: ((d: Uint8Array) => void) | null = null;
	private unsubscribe: () => void;
	/** Set after a timeout: a late reply may still arrive and must not answer the next request. */
	private drainBeforeNext = false;
	debug = false;

	constructor(readonly transport: Transport) {
		this.unsubscribe = transport.onReport((d) => {
			if (this.debug) console.debug('[hid <-]', hex(d));
			const w = this.waiter;
			this.waiter = null;
			if (!w && this.debug) console.debug('[hid] dropped unsolicited report');
			w?.(d);
		});
	}

	dispose() {
		this.unsubscribe();
	}

	/** Send `reports` back to back, then wait for one response report. */
	request(reports: Uint8Array[], timeoutMs = 5000): Promise<Uint8Array> {
		const run = async () => {
			if (this.drainBeforeNext) {
				// Give a late reply to the timed-out request time to arrive; it's dropped (no waiter).
				this.drainBeforeNext = false;
				await sleep(300);
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const response = new Promise<Uint8Array>((resolve, reject) => {
				timer = setTimeout(() => {
					this.waiter = null;
					this.drainBeforeNext = true;
					reject(new PrinterError('Printer did not respond', 'timeout'));
				}, timeoutMs);
				this.waiter = (d) => {
					clearTimeout(timer);
					resolve(d);
				};
			});
			try {
				for (const r of reports) {
					if (this.debug) console.debug('[hid ->]', hex(r.subarray(0, 16)));
					await this.transport.sendReport(r);
				}
			} catch (e) {
				clearTimeout(timer);
				this.waiter = null;
				response.catch(() => {});
				throw e;
			}
			return response;
		};
		const p = this.queue.then(run, run);
		this.queue = p.catch(() => {});
		return p;
	}

	/** Send reports without waiting for a reply (for firmware that doesn't answer bulk data). */
	send(reports: Uint8Array[]): Promise<void> {
		const run = async () => {
			for (const r of reports) await this.transport.sendReport(r);
		};
		const p = this.queue.then(run, run);
		this.queue = p.catch(() => {});
		return p;
	}

	/** Send bytes as consecutive zero padded 64-byte reports (no response expected per report). */
	static chunk(data: Uint8Array | number[]): Uint8Array[] {
		const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data, (b) => b & 0xff);
		const out: Uint8Array[] = [];
		for (let i = 0; i < bytes.length; i += REPORT_SIZE) {
			const r = new Uint8Array(REPORT_SIZE);
			r.set(bytes.subarray(i, i + REPORT_SIZE));
			out.push(r);
		}
		return out;
	}
}

/**
 * The 8-byte "vendor request" framing used by the T50/T80, SP and G families:
 * C0 40 <value hi> <value lo> <command> 00 08 00 [extra hi, extra lo]
 */
export function vendorCommand(command: number, value = 0, extra?: number): Uint8Array {
	const len = extra === undefined ? 8 : 10;
	const d = new Uint8Array(len);
	d[0] = 0xc0;
	d[1] = 0x40;
	d[2] = (value >> 8) & 0xff;
	d[3] = value & 0xff;
	d[4] = command & 0xff;
	d[5] = 0x00;
	d[6] = 0x08;
	d[7] = 0x00;
	if (extra !== undefined) {
		d[8] = (extra >> 8) & 0xff;
		d[9] = extra & 0xff;
	}
	return d;
}

export const hex = (d: Uint8Array | number[]) =>
	Array.from(d, (b) => (b & 0xff).toString(16).padStart(2, '0')).join(' ');
