/**
 * Minimal report-level transport. Supvan printers expose one vendor-defined HID interface
 * (usage page 0xFF00) with 64-byte input and output reports and no report IDs.
 */
export interface Transport {
	readonly productId: number;
	readonly vendorId: number;
	readonly productName: string;
	/** Send one 64-byte output report (shorter data is zero padded). */
	sendReport(data: Uint8Array): Promise<void>;
	/** Subscribe to input reports. Returns an unsubscribe function. */
	onReport(listener: (data: Uint8Array) => void): () => void;
	close(): Promise<void>;
}

export const REPORT_SIZE = 64;

export function padReport(data: Uint8Array): Uint8Array {
	if (data.length === REPORT_SIZE) return data;
	const out = new Uint8Array(REPORT_SIZE);
	out.set(data.subarray(0, REPORT_SIZE));
	return out;
}

/** WebHID transport (Chrome/Edge). */
export class WebHidTransport implements Transport {
	private listeners = new Set<(data: Uint8Array) => void>();
	private handler = (e: HIDInputReportEvent) => {
		const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
		for (const l of this.listeners) l(data);
	};

	constructor(readonly device: HIDDevice) {
		device.addEventListener('inputreport', this.handler);
	}

	get productId() {
		return this.device.productId;
	}
	get vendorId() {
		return this.device.vendorId;
	}
	get productName() {
		return this.device.productName;
	}

	static async open(device: HIDDevice): Promise<WebHidTransport> {
		if (!device.opened) await device.open();
		return new WebHidTransport(device);
	}

	async sendReport(data: Uint8Array) {
		await this.device.sendReport(0, padReport(data) as Uint8Array<ArrayBuffer>);
	}

	onReport(listener: (data: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close() {
		this.device.removeEventListener('inputreport', this.handler);
		this.listeners.clear();
		if (this.device.opened) await this.device.close();
	}
}
