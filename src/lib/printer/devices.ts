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
	g: 'G series label printers',
	t15: 'E10 / T10 label makers (Bluetooth)'
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

/**
 * Bluetooth name prefixes of the T10/T15-series label makers, which all use the T15 protocol
 * (SUPRINT 1.5.0 EDevice.getE10Device, T10Device and A10PlusDevice, printing process 15). Prefixes
 * both the E10 and T10 lists have are named E10, as the app checks the E10 first.
 */
const T15_NAME_PREFIXES: [string, string][] = [
	...['T0010', 'T0026', 'T0035', 'T0039', 'T0043', 'T0065', 'T0060', 'T0126', 'T0127', 'T0011', 'T0028', 'T0059', 'T0066', 'T0036', 'T0040', 'T0044',
		'T0071', 'T0075', 'T0012', 'T0027', 'T0058', 'T0067', 'T0037', 'T0041', 'T0045', 'T0061', 'T0068', 'T0078', 'T0073', 'T0077', 'T0007', 'T0025',
		'T0034', 'T0038', 'T0042', 'T0057', 'T0064', 'T0017', 'T0072', 'T0082', 'T0087', 'T0092', 'T0131', 'T0135', 'T0144', 'T0177', 'T0180', 'T0207',
		'T0208', 'T0222', 'T0081', 'T0086', 'T0091', 'T0124', 'T0125', 'T0132', 'T0136', 'T0143', 'T0176', 'T0179', 'T0209', 'T0210', 'T0223', 'T0084',
		'T0089', 'T0094', 'T0085', 'T0090', 'T0095', 'T0098', 'T0133', 'T0137', 'T0083', 'T0088', 'T0093', 'T0130', 'T0134'].map((p) => [p, 'E10'] as [string, string]),
	['T0006', 'T11'],
	['T0032', 'T12'],
	['T0232', 'T1'],
	['T0236', 'T10'],
	['T0070', 'T10 Plus'],
	['T0076', 'T10 Pro'],
	['T0140', 'T10 Pro'],
	...['T0001', 'T0002', 'T0003', 'T0004', 'T0005', 'T0008', 'T0009', 'T0074'].map((p) => [p, 'T10'] as [string, string]),
	['T0079', 'A10 Plus'],
	['T0080', 'A10 Pro'],
	['T0141', 'A10 Pro']
];

/**
 * Supvan Bluetooth printers with other protocols this app doesn't speak yet, so they aren't taken
 * for a T50/T80: the E11/E12 (SUPRINT printing process 4) and the E16/T16/A16 (process 16).
 */
const UNSUPPORTED_NAME_PREFIXES: [string, string][] = [
	...['T0138', 'T0139', 'T0181', 'T0182', 'T0183', 'T0184', 'T0224', 'T0225', 'T0216', 'T0217', 'T0218', 'T0219', 'T0226', 'T0227'].map(
		(p) => [p, 'E11'] as [string, string]
	),
	...['T0187', 'T0188', 'T0189', 'T0190', 'T0228', 'T0229', 'T0194', 'T0195', 'T0196', 'T0197', 'T0230', 'T0231'].map((p) => [p, 'E12'] as [string, string]),
	...['T0053', 'T0105', 'T0054', 'T0107', 'T0055', 'T0106', 'T0122', 'T0123'].map((p) => [p, 'E16'] as [string, string]),
	...['T0047', 'T0052'].map((p) => [p, 'T16'] as [string, string]),
	...['T0056', 'T0069'].map((p) => [p, 'A16'] as [string, string])
];

/** Model name of a Bluetooth printer this app can't drive yet, if the name is one. */
export function unsupportedBluetoothModel(name: string | undefined): string | undefined {
	if (!name) return undefined;
	return UNSUPPORTED_NAME_PREFIXES.find(([p]) => name.startsWith(p))?.[1];
}

/** Model name for a Bluetooth device name, or undefined if it isn't a known prefix. */
export function modelNameFromBluetoothName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	return (T15_NAME_PREFIXES.find(([p]) => name.startsWith(p)) ?? BT_NAME_PREFIXES.find(([p]) => name.startsWith(p)))?.[1];
}

/** Family of a Bluetooth printer by its name: the T10/T15 series, else the T50/T80 series. */
export function familyFromBluetoothName(name: string | undefined): Family {
	return name && T15_NAME_PREFIXES.some(([p]) => name.startsWith(p)) ? 't15' : 't5080';
}
