// Serial (Bluetooth SPP) byte transport for Node, for exercising the Bluetooth driver.
import { SerialPort } from 'serialport';
import type { ByteTransport } from '../src/lib/printer/serial.ts';

export class NodeSerialTransport implements ByteTransport {
	private listeners = new Set<(chunk: Uint8Array) => void>();

	private constructor(
		private port: SerialPort,
		readonly name: string
	) {
		port.on('data', (buf: Buffer) => {
			for (const l of this.listeners) l(new Uint8Array(buf));
		});
		port.on('error', (e) => console.error('[serial error]', e));
	}

	/** Open the first paired Supvan printer port (/dev/cu.T0…), or `path` if given. */
	static async open(path?: string): Promise<NodeSerialTransport> {
		const ports = await SerialPort.list();
		const p = path ?? ports.map((x) => x.path.replace('/dev/tty.', '/dev/cu.')).find((x) => /\/dev\/cu\.T0\d{3}/.test(x));
		if (!p) throw new Error('No paired Supvan printer serial port found (/dev/cu.T0…)');
		const port = new SerialPort({ path: p, baudRate: 115200, autoOpen: false });
		await new Promise<void>((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));
		return new NodeSerialTransport(port, p);
	}

	write(data: Uint8Array) {
		return new Promise<void>((resolve, reject) =>
			this.port.write(Buffer.from(data), (e) => (e ? reject(e) : this.port.drain(() => resolve())))
		);
	}

	onData(listener: (chunk: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close() {
		return new Promise<void>((resolve) => this.port.close(() => resolve()));
	}
}
