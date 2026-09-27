import type { Family } from './types';

export const SUPVAN_VENDOR_ID = 0x1820;

export interface DeviceModel {
	productId: number;
	name: string;
	family: Family;
	/** Dots per mm (the official app's "DPI" value). */
	dpmm: number;
	/** Print head width in dots, where the official code clamps to it. */
	headDots: number;
	/** Listed in the official app's printer picker (others are recognized by getDevType only). */
	listed: boolean;
}

/**
 * All printers recognized by KatasymbolEditor 1.1.1 (components/Device.vue PrinterArray plus
 * HidUsbCtrlFunc.getDevType / getPrinterName / getPrinterDPI).
 */
export const DEVICE_MODELS: DeviceModel[] = [
	// T50/T80 series, 203 dpi.
	{ productId: 0x2072, name: 'T50M Plus', family: 't5080', dpmm: 8, headDots: 384, listed: true },
	{ productId: 0x2074, name: 'T50S', family: 't5080', dpmm: 8, headDots: 384, listed: true },
	{ productId: 0x2073, name: 'T50M Pro', family: 't5080', dpmm: 8, headDots: 384, listed: true },
	{ productId: 0x2076, name: 'T50M Pro', family: 't5080', dpmm: 8, headDots: 384, listed: true },
	{ productId: 0x2077, name: 'T50i', family: 't5080', dpmm: 8, headDots: 384, listed: true },
	{ productId: 0x2075, name: 'T80M', family: 't5080', dpmm: 8, headDots: 576, listed: true },
	{ productId: 0x207a, name: 'T80M Pro', family: 't5080', dpmm: 8, headDots: 576, listed: true },
	{ productId: 0x2071, name: 'T50 Max', family: 't5080', dpmm: 8, headDots: 384, listed: false },
	{ productId: 0x2078, name: 'T80M Pro', family: 't5080', dpmm: 8, headDots: 576, listed: false },
	// SP sign printers, 300 dpi.
	{ productId: 0x203e, name: 'SP650', family: 'sp', dpmm: 11.8, headDots: 672, listed: true },
	// TP tube/wire marker printers.
	{ productId: 0x202f, name: 'TP86A', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: true },
	{ productId: 0x2081, name: 'TP86A', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: true },
	{ productId: 0x202e, name: 'TP80A', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: true },
	{ productId: 0x2080, name: 'TP80A', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: true },
	{ productId: 0x202c, name: 'TP76i', family: 'tp', dpmm: 11.3, headDots: 144, listed: true },
	// G series, 203 dpi (G11/G15/G18/G21) and 300 dpi (G25/G28).
	{ productId: 0x2090, name: 'G11 Pro', family: 'g', dpmm: 8, headDots: 96, listed: true },
	{ productId: 0x2096, name: 'G11 Pro', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x2092, name: 'G15 Pro', family: 'g', dpmm: 8, headDots: 96, listed: true },
	{ productId: 0x2093, name: 'G15 MPro', family: 'g', dpmm: 8, headDots: 96, listed: true },
	{ productId: 0x2091, name: 'G18 Pro', family: 'g', dpmm: 8, headDots: 96, listed: true },
	{ productId: 0x2097, name: 'G18 Pro', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x4008, name: 'CG113 (G18 Pro)', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x4009, name: 'XG116 (G18 Pro)', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x2094, name: 'G21', family: 'g', dpmm: 8, headDots: 176, listed: false },
	{ productId: 0x2095, name: 'G28', family: 'g', dpmm: 11.8, headDots: 246, listed: false },
	{ productId: 0x2098, name: 'G25', family: 'g', dpmm: 11.8, headDots: 288, listed: false }
];

export const FAMILY_NAMES: Record<Family, string> = {
	t5080: 'T50 / T80 label printers',
	sp: 'SP sign printers',
	tp: 'TP wire marker printers',
	tp86a: 'TP86A / TP80A wire marker printers',
	g: 'G series label printers'
};

export function findModel(productId: number): DeviceModel | undefined {
	return DEVICE_MODELS.find((m) => m.productId === productId);
}

/** WebHID request filters: every known Supvan model on its vendor-defined collection. */
export const HID_FILTERS: HIDDeviceFilter[] = [{ vendorId: SUPVAN_VENDOR_ID, usagePage: 0xff00 }, { vendorId: SUPVAN_VENDOR_ID }];

/**
 * Bluetooth name prefixes of the T50/T80 printers, from the Katasymbol Android app's device
 * tables (TENDevice.getT50MProDevice, T50ProDevice, A50ProDevice; the Kata build renames
 * T0112A/T0101A to "T50M Pro"). The name is the prefix plus a serial, e.g. "T0148B2507018663".
 */
const BT_NAME_PREFIXES: [string, string][] = [
	...['T0096A', 'T0117A', 'T0118A', 'T0129A', 'T0147B', 'T0148', 'T0170', 'T0178', 'T0205', 'T0211', 'T0212', 'T0213', 'T0221', 'T0162B', 'T0163B', 'T0112A', 'T0101A'].map(
		(p) => [p, 'T50M Pro'] as [string, string]
	),
	...['T0046A', 'T0149B', 'T0159B', 'T0200', 'T0100A', 'T0145B', 'T0150B', 'T0201', 'T0151B', 'T0113A', 'T0152B', 'T0160B', 'T0202'].map(
		(p) => [p, 'T50 Pro'] as [string, string]
	),
	...['T0097A', 'T0153B', 'T0161B', 'T0206', 'T0154B', 'T0114A', 'T0146B', 'T0155B', 'T0115A', 'T0156B'].map((p) => [p, 'A50 Pro'] as [string, string])
];

/** Model name for a Bluetooth device name, or undefined if it isn't a known prefix. */
export function modelNameFromBluetoothName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	return BT_NAME_PREFIXES.find(([p]) => name.startsWith(p))?.[1];
}
