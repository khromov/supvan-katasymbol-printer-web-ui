// node-hid transport used to exercise the printer drivers from Node (same protocol code as the web app).
import HID from 'node-hid';
import { padReport, type Transport } from '../src/lib/printer/transport.ts';

export class NodeHidTransport implements Transport {
	private listeners = new Set<(data: Uint8Array) => void>();

	private constructor(
		private dev: HID.HIDAsync,
		readonly vendorId: number,
		readonly productId: number,
		readonly productName: string
	) {
		dev.on('data', (buf: Buffer) => {
			const data = new Uint8Array(buf);
			for (const l of this.listeners) l(data);
		});
		dev.on('error', (err: unknown) => console.error('[hid error]', err));
	}

	static async openFirst(vendorId = 0x1820): Promise<NodeHidTransport> {
		const info = (await HID.devicesAsync()).find((d) => d.vendorId === vendorId && d.usagePage === 0xff00);
		if (!info?.path) throw new Error('No Supvan HID device found');
		const dev = await HID.HIDAsync.open(info.path);
		return new NodeHidTransport(dev, info.vendorId, info.productId, info.product ?? '');
	}

	async sendReport(data: Uint8Array) {
		// hidapi expects a leading report ID byte; 0 means "no report IDs" and is stripped.
		const out = new Uint8Array(65);
		out.set(padReport(data), 1);
		await this.dev.write(Array.from(out));
	}

	onReport(listener: (data: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close() {
		this.listeners.clear();
		await this.dev.close();
	}
}
