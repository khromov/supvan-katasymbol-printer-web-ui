import { familyFromBluetoothName, findModel, HID_FILTERS, modelNameFromBluetoothName, unsupportedBluetoothModel, type DeviceModel } from './devices';
import { WebBluetoothTransport } from './ble';
import { GDriver } from './families/g';
import { probeSpInterface, SpDriver } from './families/sp';
import { T5080Driver } from './families/t5080';
import { T5080BtDriver } from './families/t5080-bt';
import { T15BtDriver, T15_HEAD_DOTS } from './families/t15';
import { E11BtDriver, E11_HEAD_DOTS } from './families/e11';
import { E12BtDriver, E12_HEAD_DOTS } from './families/e12';
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
		case 't15':
		case 'e11':
		case 'e12':
			throw new PrinterError(`${model.name} connects over Bluetooth only`, 'unsupported');
	}
}

/** A driver for a printer on a Bluetooth link. */
export type BluetoothDriver = T5080BtDriver | T15BtDriver | E11BtDriver | E12BtDriver;

/** Refuse Supvan printers whose protocol this app doesn't speak, rather than drive them as a T50/T80. */
function assertSupported(devName: string | undefined) {
	const model = unsupportedBluetoothModel(devName);
	if (model) throw new PrinterError(`The ${model} isn't supported yet.`, 'unsupported');
}

const t15Model = (devName: string): DeviceModel => ({
	productId: 0,
	name: `${modelNameFromBluetoothName(devName) ?? (devName || 'E10')} (Bluetooth)`,
	family: 't15',
	dpmm: 8,
	headDots: T15_HEAD_DOTS,
	listed: false
});

const e11Model = (): DeviceModel => ({
	productId: 0,
	name: 'E11 (Bluetooth)',
	family: 'e11',
	dpmm: 8,
	headDots: E11_HEAD_DOTS,
	listed: false
});

const e12Model = (): DeviceModel => ({
	productId: 0,
	name: 'E12 (Bluetooth)',
	family: 'e12',
	dpmm: 8,
	headDots: E12_HEAD_DOTS,
	listed: false
});

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
 * Open a Bluetooth printer. The T50/T80 and the E10/T10 series use Bluetooth serial (the other
 * families' Bluetooth models use BLE); Web Serial doesn't expose the device name, so the model
 * is taken from the printer's own RD_DEV_NAME reply. Both families answer the same status and
 * name commands, so the T50/T80 driver asks before the right one takes over.
 */
export async function openBluetoothPrinter(port: SerialPort, debug = false): Promise<{ model: DeviceModel; driver: BluetoothDriver; transport: WebSerialTransport }> {
	const transport = await WebSerialTransport.open(port);
	try {
		const driver = new T5080BtDriver(transport);
		driver.channel.debug = debug;
		await driver.handshake();
		const devName = await driver.readDeviceName().catch(() => '');
		assertSupported(devName);
		const family = familyFromBluetoothName(devName);
		if (family === 't15') {
			driver.channel.dispose();
			const t15 = new T15BtDriver(transport, devName);
			t15.channel.debug = debug;
			return { model: t15Model(devName), driver: t15, transport };
		}
		if (family === 'e11') {
			driver.channel.dispose();
			const e11 = new E11BtDriver(transport, devName);
			e11.channel.debug = debug;
			return { model: e11Model(), driver: e11, transport };
		}
		if (family === 'e12') {
			driver.channel.dispose();
			const e12 = new E12BtDriver(transport, devName);
			e12.channel.debug = debug;
			return { model: e12Model(), driver: e12, transport };
		}
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

/**
 * Open a printer over BLE, by its advertised name: E10/T10 series, E11, E12 or T50/T80. The T50/T80
 * doesn't answer data frames there. The E10/T10 are driven like the iOS app drives them: writes
 * without response where the printer allows it, and a reply expected for every data frame. The E12
 * only takes writes without response and also answers every data frame; the E11 is driven like the
 * Android apps drive it, which is how they drive the E12 too.
 */
export async function openBlePrinter(device: BluetoothDevice, debug = false): Promise<{ model: DeviceModel; driver: BluetoothDriver; transport: WebBluetoothTransport }> {
	assertSupported(device.name);
	const family = familyFromBluetoothName(device.name);
	const isT15 = family === 't15';
	const transport = await WebBluetoothTransport.open(device, { preferWithoutResponse: family !== 't5080' });
	try {
		if (family === 'e11') {
			const e11 = new E11BtDriver(transport, device.name ?? '');
			e11.channel.debug = debug;
			await e11.handshake();
			return { model: e11Model(), driver: e11, transport };
		}
		if (family === 'e12') {
			const e12 = new E12BtDriver(transport, device.name ?? '');
			e12.channel.debug = debug;
			await e12.handshake();
			return { model: e12Model(), driver: e12, transport };
		}
		if (isT15) {
			const t15 = new T15BtDriver(transport, device.name ?? '', 'ble');
			t15.channel.debug = debug;
			await t15.handshake();
			return { model: t15Model(device.name ?? ''), driver: t15, transport };
		}
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
