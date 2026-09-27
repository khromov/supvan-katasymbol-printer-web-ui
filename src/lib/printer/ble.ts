import type { ByteTransport } from './serial';

/**
 * Bluetooth LE (GATT) byte transport for the T50/T80 printers, via Web Bluetooth. The printers
 * are dual-mode: next to classic SPP they expose one vendor service carrying the same `7E 5A`
 * frames. It advertises no service UUIDs, so it is found by name. This is also the only way to
 * reach them from iOS (in a Web Bluetooth browser such as Bluefy).
 */
export const BLE_SERVICE = '0000e0ff-3c17-d293-8e48-14fe2e4da212';
/** Commands and data are written here. */
export const BLE_WRITE = '0000ffe9-0000-1000-8000-00805f9b34fb';
/** Replies arrive as notifications here. */
export const BLE_NOTIFY = '0000ffe1-0000-1000-8000-00805f9b34fb';
/** Bluetooth names start with T0 (e.g. "T0148B2507018663"). */
export const BLE_NAME_PREFIXES = ['T0'];

/** Largest single write; the Android app writes 128-byte pieces and needs an MTU of at least 131. */
const MAX_WRITE = 128;

export class WebBluetoothTransport implements ByteTransport {
	private listeners = new Set<(chunk: Uint8Array) => void>();
	private onNotify = (e: Event) => {
		const v = (e.target as BluetoothRemoteGATTCharacteristic).value;
		if (!v) return;
		// Copy exactly the notified bytes (the DataView may be a window into a larger buffer).
		const chunk = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
		for (const l of this.listeners) l(chunk);
	};

	private constructor(
		readonly device: BluetoothDevice,
		private writeChar: BluetoothRemoteGATTCharacteristic,
		private notifyChar: BluetoothRemoteGATTCharacteristic
	) {
		notifyChar.addEventListener('characteristicvaluechanged', this.onNotify);
	}

	get name() {
		return this.device.name ?? 'Bluetooth printer';
	}

	/** Show the browser's device chooser. Must be called from a user gesture (a click). */
	static request(): Promise<BluetoothDevice> {
		return navigator.bluetooth.requestDevice({
			filters: BLE_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
			optionalServices: [BLE_SERVICE]
		});
	}

	static async open(device: BluetoothDevice): Promise<WebBluetoothTransport> {
		if (!device.gatt) throw new Error('This device has no GATT server');
		const server = await device.gatt.connect();
		const service = await server.getPrimaryService(BLE_SERVICE);
		const writeChar = await service.getCharacteristic(BLE_WRITE);
		const notifyChar = await service.getCharacteristic(BLE_NOTIFY);
		await notifyChar.startNotifications();
		return new WebBluetoothTransport(device, writeChar, notifyChar);
	}

	async write(data: Uint8Array) {
		for (let o = 0; o < data.length; o += MAX_WRITE) {
			const piece = data.slice(o, o + MAX_WRITE);
			// Acknowledged writes pace the stream and work on every platform (incl. iOS browsers).
			await this.writeChar.writeValueWithResponse(piece);
		}
	}

	onData(listener: (chunk: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close() {
		this.listeners.clear();
		this.notifyChar.removeEventListener('characteristicvaluechanged', this.onNotify);
		await this.notifyChar.stopNotifications().catch(() => {});
		if (this.device.gatt?.connected) this.device.gatt.disconnect();
	}
}
