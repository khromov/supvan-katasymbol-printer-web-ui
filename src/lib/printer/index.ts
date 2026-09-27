import { findModel, HID_FILTERS, type DeviceModel } from './devices';
import { GDriver } from './families/g';
import { probeSpInterface, SpDriver } from './families/sp';
import { T5080Driver } from './families/t5080';
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
