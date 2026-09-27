import { findModel, HID_FILTERS, modelNameFromBluetoothName, type DeviceModel } from './devices';
import { WebBluetoothTransport } from './ble';
import { GDriver } from './families/g';
import { probeSpInterface, SpDriver } from './families/sp';
import { T5080Driver } from './families/t5080';
import { T5080BtDriver } from './families/t5080-bt';
import { SPP_UUID, WebSerialTransport } from './serial';
import { Tp86aDriver, TpDriver } from './families/tp';
import { WebHidTransport, type Transport } from './transport';
import { PrinterError, type PrinterDriver } from './types';

export * from './types';
export * from './devices';

export function createDriver(model: DeviceModel, transport: Transport): PrinterDriver {
	switch (model.family) {
		case 't5080':
			return new T5080Driver(transport, model.headDots);
		case 'sp':
			return new SpDriver(transport);
		case 'tp':
			return new TpDriver(transport);
		case 'tp86a':
			return new Tp86aDriver(transport);
		case 'g':
			return new GDriver(transport, { dpmm: model.dpmm, headDots: model.headDots });
	}
}

export const webHidSupported = () => typeof navigator !== 'undefined' && 'hid' in navigator;

/**
 * Of the HID devices Chrome returns, pick the printer interface. SP printers enumerate two
 * identical interfaces; like the official app, try them last to first and keep the first one
 * that accepts a status request.
 */
export async function pickDevice(devices: HIDDevice[]): Promise<HIDDevice | undefined> {
	const known = devices.filter((d) => findModel(d.productId));
	const vendor = known.filter((d) => d.collections.some((c) => c.usagePage === 0xff00));
	const candidates = vendor.length ? vendor : known;
	if (candidates.length > 1 && findModel(candidates[0].productId)?.family === 'sp') {
		for (const d of [...candidates].reverse()) if (await probeSpInterface(d)) return d;
	}
	return candidates[0];
}

export async function requestPrinter(): Promise<HIDDevice | undefined> {
	return pickDevice(await navigator.hid.requestDevice({ filters: HID_FILTERS }));
}

export async function grantedPrinter(): Promise<HIDDevice | undefined> {
	return pickDevice(await navigator.hid.getDevices());
}

export async function openPrinter(device: HIDDevice): Promise<{ model: DeviceModel; driver: PrinterDriver; transport: WebHidTransport }> {
	const model = findModel(device.productId);
	if (!model) throw new PrinterError(`Unknown printer (product id 0x${device.productId.toString(16)})`, 'unsupported');
	const transport = await WebHidTransport.open(device);
	try {
		return { model, driver: createDriver(model, transport), transport };
	} catch (e) {
		await transport.close();
		throw e;
	}
}

// ---- Bluetooth (classic SPP via Web Serial) ----

export const webSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

const isSppPort = (p: SerialPort) => (p.getInfo() as { bluetoothServiceClassId?: string }).bluetoothServiceClassId === SPP_UUID;

/** Ask for a paired Bluetooth printer (its Serial Port Profile service). */
export async function requestBluetoothPort(): Promise<SerialPort> {
	return navigator.serial.requestPort({
		filters: [{ bluetoothServiceClassId: SPP_UUID }],
		allowedBluetoothServiceClassIds: [SPP_UUID]
	});
}

export async function grantedBluetoothPort(): Promise<SerialPort | undefined> {
	return (await navigator.serial.getPorts()).find(isSppPort);
}

/**
 * Open a Bluetooth printer. Only the T50/T80 family is known to use Bluetooth serial (the other
 * families' Bluetooth models use BLE); Web Serial doesn't expose the device name, so the model
 * is taken from the printer's own RD_DEV_NAME reply.
 */
export async function openBluetoothPrinter(port: SerialPort, debug = false): Promise<{ model: DeviceModel; driver: T5080BtDriver; transport: WebSerialTransport }> {
	const transport = await WebSerialTransport.open(port);
	try {
		const driver = new T5080BtDriver(transport);
		driver.channel.debug = debug;
		await driver.handshake();
		const devName = await driver.readDeviceName().catch(() => '');
		const name = /pro/i.test(devName) ? 'T50M Pro' : devName || 'T50 series';
		const model: DeviceModel = { productId: 0, name: `${name} (Bluetooth)`, family: 't5080', dpmm: 8, headDots: 384, listed: false };
		return { model, driver, transport };
	} catch (e) {
		await transport.close();
		throw e;
	}
}

// ---- Bluetooth LE (Web Bluetooth) ----

export const webBluetoothSupported = () => typeof navigator !== 'undefined' && 'bluetooth' in navigator;

/** False when the browser knows Bluetooth is off/unavailable (undefined if it can't tell). */
export async function bluetoothAvailable(): Promise<boolean | undefined> {
	try {
		return await navigator.bluetooth.getAvailability();
	} catch {
		return undefined;
	}
}

export const requestBlePrinter = () => WebBluetoothTransport.request();

/** Open a T50/T80 printer over BLE. The printer doesn't answer data frames there. */
export async function openBlePrinter(device: BluetoothDevice, debug = false): Promise<{ model: DeviceModel; driver: T5080BtDriver; transport: WebBluetoothTransport }> {
	const transport = await WebBluetoothTransport.open(device);
	try {
		const driver = new T5080BtDriver(transport, 384, { acksDataFrames: false, commandTimeoutMs: 4000 });
		driver.channel.debug = debug;
		await driver.handshake();
		const name = modelNameFromBluetoothName(device.name) ?? 'T50 series';
		const model: DeviceModel = { productId: 0, name: `${name} (Bluetooth)`, family: 't5080', dpmm: 8, headDots: 384, listed: false };
		return { model, driver, transport };
	} catch (e) {
		await transport.close();
		throw e;
	}
}
