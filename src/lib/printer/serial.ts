/**
 * Byte-stream transport for printers reached over classic Bluetooth (SPP/RFCOMM). In the browser
 * that is Web Serial, which exposes paired Bluetooth serial devices as serial ports.
 */
export interface ByteTransport {
	readonly name: string;
	write(data: Uint8Array): Promise<void>;
	/** Subscribe to received bytes. Returns an unsubscribe function. */
	onData(listener: (chunk: Uint8Array) => void): () => void;
	close(): Promise<void>;
}

/** Serial Port Profile service class, used by the T50/T80 printers' Bluetooth serial link. */
export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

export class WebSerialTransport implements ByteTransport {
	private listeners = new Set<(chunk: Uint8Array) => void>();
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private closing = false;
	private loop: Promise<void>;

	private constructor(
		readonly port: SerialPort,
		readonly name: string
	) {
		this.writer = port.writable!.getWriter();
		this.loop = this.readLoop();
	}

	static async open(port: SerialPort, name = 'Bluetooth printer'): Promise<WebSerialTransport> {
		// The baud rate is ignored for Bluetooth RFCOMM ports but required by the API.
		if (!port.readable) await port.open({ baudRate: 115200 });
		return new WebSerialTransport(port, name);
	}

	private async readLoop() {
		while (!this.closing && this.port.readable) {
			this.reader = this.port.readable.getReader();
			try {
				for (;;) {
					const { value, done } = await this.reader.read();
					if (done) break;
					if (value?.length) for (const l of this.listeners) l(value);
				}
			} catch (e) {
				// A non-fatal read error (e.g. a framing/break error) ends this reader; retry unless closing.
				if (!this.closing) console.warn('serial read error', e);
			} finally {
				this.reader.releaseLock();
				this.reader = null;
			}
		}
	}

	async write(data: Uint8Array) {
		await this.writer.write(data);
	}

	onData(listener: (chunk: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close() {
		this.closing = true;
		this.listeners.clear();
		await this.reader?.cancel().catch(() => {});
		await this.loop.catch(() => {});
		this.writer.releaseLock();
		await this.port.close().catch(() => {});
	}
}
