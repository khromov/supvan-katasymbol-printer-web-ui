import type { ByteTransport } from './serial';

/**
 * Bluetooth LE (GATT) byte transport for the Bluetooth printers, via Web Bluetooth. The T50/T80
 * printers are dual-mode: next to classic SPP they expose one vendor service carrying the same
 * `7E 5A` frames. It advertises no service UUIDs, so it is found by name. This is also the only way
 * to reach them from iOS (in a Web Bluetooth browser such as Bluefy).
 */
interface BleService {
	service: string;
	/** Commands and data are written here. */
	write: string;
	/** Replies arrive as notifications here. */
	notify: string;
}

/**
 * The vendor services the Supvan apps know (SUPRINT BLEUtils.getService, and 18F0 from the iOS
 * app's SFBLEManager), in the order they are tried. The T50/T80 use the first; which one the
 * E10/T10 series offer is not known yet. FEE7 is a common generic service, so it goes last.
 */
const BLE_SERVICES: BleService[] = [
	{ service: '0000e0ff-3c17-d293-8e48-14fe2e4da212', write: '0000ffe9-0000-1000-8000-00805f9b34fb', notify: '0000ffe1-0000-1000-8000-00805f9b34fb' },
	{ service: '0000a002-0000-1000-8000-00805f9b34fb', write: '0000c302-0000-1000-8000-00805f9b34fb', notify: '0000c305-0000-1000-8000-00805f9b34fb' },
	{ service: '0000ff00-0000-1000-8000-00805f9b34fb', write: '0000ff02-0000-1000-8000-00805f9b34fb', notify: '0000ff01-0000-1000-8000-00805f9b34fb' },
	{ service: '000018f0-0000-1000-8000-00805f9b34fb', write: '00002af1-0000-1000-8000-00805f9b34fb', notify: '00002af0-0000-1000-8000-00805f9b34fb' },
	{ service: '0000fee7-0000-1000-8000-00805f9b34fb', write: '0000fec1-0000-1000-8000-00805f9b34fb', notify: '0000fec1-0000-1000-8000-00805f9b34fb' }
];
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
		private notifyChar: BluetoothRemoteGATTCharacteristic,
		/** Write without response (as the iOS app does for every printer) instead of with. */
		private withoutResponse: boolean
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
			optionalServices: BLE_SERVICES.map((s) => s.service)
		});
	}

	/**
	 * Connect and pick the service. `preferWithoutResponse` writes without response where the
	 * characteristic allows it; without Write support, that is the only option anyway.
	 */
	static async open(device: BluetoothDevice, opts: { preferWithoutResponse?: boolean } = {}): Promise<WebBluetoothTransport> {
		if (!device.gatt) throw new Error('This device has no GATT server');
		const server = await device.gatt.connect();
		// Take the first known service the device has (the T50/T80's is tried first, as before).
		let service: BluetoothRemoteGATTService | undefined;
		let known: BleService | undefined;
		let lastError: unknown;
		for (const k of BLE_SERVICES) {
			try {
				service = await server.getPrimaryService(k.service);
				known = k;
				break;
			} catch (e) {
				lastError = e;
			}
		}
		if (!service || !known) throw lastError;
		const writeChar = await service.getCharacteristic(known.write);
		const notifyChar = await service.getCharacteristic(known.notify);
		await notifyChar.startNotifications();
		const { write, writeWithoutResponse } = writeChar.properties;
		const withoutResponse = writeWithoutResponse && (!write || !!opts.preferWithoutResponse) && typeof writeChar.writeValueWithoutResponse === 'function';
		return new WebBluetoothTransport(device, writeChar, notifyChar, withoutResponse);
	}

	async write(data: Uint8Array) {
		for (let o = 0; o < data.length; o += MAX_WRITE) {
			const piece = data.slice(o, o + MAX_WRITE);
			// Acknowledged writes pace the stream and work on every platform (incl. iOS browsers);
			// unacknowledged ones are paced by the callers' sleeps, like the iOS app.
			if (this.withoutResponse) await this.writeChar.writeValueWithoutResponse(piece);
			else await this.writeChar.writeValueWithResponse(piece);
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
