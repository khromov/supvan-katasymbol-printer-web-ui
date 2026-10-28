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
	// Newer T50/T80 revisions KatasymbolEditor 1.1.1 predates, from SupvanEditor 2.4.24
	// (Supvan.UsbDev.UsbCtrlFunc.GetDevType / GetDevName) and the Sep 2026 Windows T50 driver
	// (SupvanT50.dll), which drive them exactly like 0x2073 / 0x2075. 0x207f is the 2026 T50M Pro
	// (Supvan calls it "T50 Pro"; USB 1820:207f reported by a user). Only SupvanEditor prints to the
	// T50M (0x2070, "T50A" in Chinese), sending it one 40000-byte buffer per transfer instead of up
	// to 8 × 4096, and the T50/T80 driver does the same (T50M_PRODUCT_ID). The 300 dpi T80 Pro+
	// (0x207b) and T50 Plus+ (0x207c) are left out as the T50/T80 driver assumes 8 dots/mm.
	{ productId: 0x207f, name: 'T50M Pro', family: 't5080', dpmm: 8, headDots: 384, listed: false },
	{ productId: 0x207d, name: 'T50 Max', family: 't5080', dpmm: 8, headDots: 384, listed: false },
	{ productId: 0x2170, name: 'T50 Max', family: 't5080', dpmm: 8, headDots: 384, listed: false },
	{ productId: 0x2070, name: 'T50M', family: 't5080', dpmm: 8, headDots: 384, listed: false },
	{ productId: 0x2079, name: 'A80 Pro', family: 't5080', dpmm: 8, headDots: 576, listed: false },
	{ productId: 0x207e, name: 'T80 Max', family: 't5080', dpmm: 8, headDots: 576, listed: false },
	// SP sign printers, 300 dpi.
	{ productId: 0x203e, name: 'SP650', family: 'sp', dpmm: 11.8, headDots: 672, listed: true },
	// SP models only SupvanEditor 2.4.24 knows (frmLibUsbPrintCrt's HID SP path, which has no
	// per-model branches). Its older SP PIDs (0x2025-0x2037) bind to Supvan's kernel driver per the
	// bundled SupUsbDriv.inf, so they are no HID devices and are left out. Not hardware-tested.
	{ productId: 0x203d, name: 'SP350', family: 'sp', dpmm: 11.8, headDots: 672, listed: false },
	{ productId: 0x203f, name: 'SP650E', family: 'sp', dpmm: 11.8, headDots: 672, listed: false },
	{ productId: 0x20a0, name: 'SP750', family: 'sp', dpmm: 11.8, headDots: 672, listed: false },
	{ productId: 0x4011, name: 'CS603 (SP650)', family: 'sp', dpmm: 11.8, headDots: 672, listed: false },
	{ productId: 0x4012, name: 'XS606 (SP650)', family: 'sp', dpmm: 11.8, headDots: 672, listed: false },
	{ productId: 0x3103, name: 'K68', family: 'sp', dpmm: 11.8, headDots: 672, listed: false },
	// TP tube/wire marker printers.
	{ productId: 0x202f, name: 'TP86A', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: true },
	{ productId: 0x2081, name: 'TP86A', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: true },
	{ productId: 0x202e, name: 'TP80A', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: true },
	{ productId: 0x2080, name: 'TP80A', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: true },
	{ productId: 0x202c, name: 'TP76i', family: 'tp', dpmm: 11.3, headDots: 144, listed: true },
	// TP models only SupvanEditor 2.4.24 knows. Its TPDoPrint sends these devtypes LZMA streams
	// with 0x5C and no read-back, like the TP86A (tp86a); not hardware-tested.
	{ productId: 0x208a, name: 'TP96', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x400b, name: 'XT806 (TP96)', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x400e, name: 'CT803 (TP96)', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x402a, name: 'XT807 (TP96)', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x2085, name: 'TP56', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x2086, name: 'TP66i', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x2063, name: 'TP76E', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x209c, name: 'TP76E', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x2062, name: 'TP86E', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x2087, name: 'TP76i', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x2088, name: 'TP76i', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x400a, name: 'XT706 (TP76i)', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x400d, name: 'CT703 (TP76i)', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x402b, name: 'XT707 (TP76i)', family: 'tp86a', dpmm: 11.3, headDots: 144, listed: false },
	// These share the TP76i's devtype 8235: raw frames with 0x5A and no read-back (tp).
	// Left out: TP20/TP20M (own feed-dpi and cut-line handling), the P-series 0x3101-0x3107 (0x3101
	// and 0x3102 expect a 4-byte ack per frame), and TP80 / 0x202b, which bind to the kernel driver.
	{ productId: 0x202d, name: 'TP76i', family: 'tp', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x2082, name: 'TP76E', family: 'tp', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x2083, name: 'TP66i', family: 'tp', dpmm: 11.3, headDots: 144, listed: false },
	{ productId: 0x2084, name: 'TP90', family: 'tp', dpmm: 11.3, headDots: 144, listed: false },
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
	{ productId: 0x2098, name: 'G25', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	// G models only SupvanEditor 2.4.24 knows (GDoPrint by devtype: 8336-8339 96 dots at 8 dpmm,
	// 8340 192 dots at 8 dpmm, 8344 288 dots at 11.8 dpmm). Not hardware-tested. SupvanEditor also
	// gives the G21 (0x2094) 192 dots where KatasymbolEditor has 176; that entry is left as is. The
	// CG113 0x401e is left out: SupvanEditor reaches it as a USB printer-class device, not over HID.
	{ productId: 0x209a, name: 'Q15 Pro', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x20a2, name: 'G15 Max', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x20a1, name: 'G15 MPro', family: 'g', dpmm: 8, headDots: 96, listed: false }, // devtype of the G15M Pro, unnamed
	{ productId: 0x4000, name: 'CG103 (G15 Pro)', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x4001, name: 'XG106 (G15 Pro)', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x401f, name: 'XG116 (G11 Pro)', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x4023, name: 'XG107 (G18 Pro)', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x4024, name: 'XG117 (G15 Pro)', family: 'g', dpmm: 8, headDots: 96, listed: false },
	{ productId: 0x4019, name: 'CG213 (G21)', family: 'g', dpmm: 8, headDots: 192, listed: false },
	{ productId: 0x401a, name: 'XG216 (G21)', family: 'g', dpmm: 8, headDots: 192, listed: false },
	{ productId: 0x4025, name: 'XG217 (G21)', family: 'g', dpmm: 8, headDots: 192, listed: false },
	{ productId: 0x2099, name: 'G25M', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x209d, name: 'G21 Pro', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x209e, name: 'G28 Pro', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x209f, name: 'G21 Plus', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x20a3, name: 'G28 Plus', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x20a4, name: 'Q25', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x20a5, name: 'G25 Plus', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x20a6, name: 'Q25 Plus', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x20a7, name: 'G25 Plus', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x20a8, name: 'Q25 Plus', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x20a9, name: 'G25M Plus', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x4020, name: 'CG203 (G25)', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x4021, name: 'XG206 (G25)', family: 'g', dpmm: 11.8, headDots: 288, listed: false },
	{ productId: 0x4026, name: 'XG207 (G25)', family: 'g', dpmm: 11.8, headDots: 288, listed: false }
];

export const FAMILY_NAMES: Record<Family, string> = {
	t5080: 'T50 / T80 label printers',
	sp: 'SP sign printers',
	tp: 'TP wire marker printers',
	tp86a: 'TP86A / TP80A wire marker printers',
	g: 'G series label printers',
	t15: 'E10 / T10 label makers (Bluetooth)',
	e11: 'E11 label maker (Bluetooth)',
	e12: 'E12 label maker (Bluetooth)'
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

/** Bluetooth name prefixes of the E12 (SUPRINT printing process 4), e.g. "T0195A260420I470". */
const E12_NAME_PREFIXES: [string, string][] = ['T0187', 'T0188', 'T0189', 'T0190', 'T0228', 'T0229', 'T0194', 'T0195', 'T0196', 'T0197', 'T0230', 'T0231'].map(
	(p) => [p, 'E12'] as [string, string]
);

/**
 * Bluetooth name prefixes of the E11, black and white models (Katasymbol 1.4.29 / SUPRINT 1.5.0
 * EDevice.getE11Device, printer type 3601, printing process 4).
 */
const E11_NAME_PREFIXES: [string, string][] = [
	'T0138', 'T0139', 'T0181', 'T0182', 'T0183', 'T0184', 'T0224', 'T0225', 'T0216', 'T0217', 'T0218', 'T0219', 'T0226', 'T0227'
].map((p) => [p, 'E11'] as [string, string]);

/**
 * Supvan Bluetooth printers with other protocols this app doesn't speak yet, so they aren't taken
 * for a T50/T80: the E16/T16/A16 (SUPRINT printing process 16).
 */
const UNSUPPORTED_NAME_PREFIXES: [string, string][] = [
	...['T0053', 'T0105', 'T0054', 'T0107', 'T0055', 'T0106', 'T0122', 'T0123'].map((p) => [p, 'E16'] as [string, string]),
	...['T0047', 'T0052'].map((p) => [p, 'T16'] as [string, string]),
	...['T0056', 'T0069'].map((p) => [p, 'A16'] as [string, string])
];

/**
 * Over classic Bluetooth the app only has the printer's own answer to RD_DEV_NAME, which on the
 * E10/T10 series is a model name ("E10pro" from a T0179G… E10), not the Bluetooth name.
 */
const T15_MODEL_NAMES = /^(E10|T10|T11|T12|A10)|^T1$/i;
/** The E12 firmware answers RD_DEV_NAME with "G15". */
const E12_MODEL_NAMES = /^(E12|G15$)/i;
/** The apps never ask an E11 for RD_DEV_NAME, so what it answers is a guess. */
const E11_MODEL_NAMES = /^E11/i;
const UNSUPPORTED_MODEL_NAMES = /^(E16|T16|A16)/i;

/** Model name of a Bluetooth printer this app can't drive yet, if the name is one. */
export function unsupportedBluetoothModel(name: string | undefined): string | undefined {
	if (!name) return undefined;
	return UNSUPPORTED_NAME_PREFIXES.find(([p]) => name.startsWith(p))?.[1] ?? (UNSUPPORTED_MODEL_NAMES.test(name) ? name : undefined);
}

/** Model name for a Bluetooth device name, or undefined if it isn't a known prefix. */
export function modelNameFromBluetoothName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	return [T15_NAME_PREFIXES, E11_NAME_PREFIXES, E12_NAME_PREFIXES, BT_NAME_PREFIXES].map((list) => list.find(([p]) => name.startsWith(p))).find(Boolean)?.[1];
}

/**
 * Family of a Bluetooth printer by its Bluetooth name or its RD_DEV_NAME model name: the T10/T15
 * series, the E11, the E12, else the T50/T80 series.
 */
export function familyFromBluetoothName(name: string | undefined): Family {
	if (!name) return 't5080';
	if (T15_NAME_PREFIXES.some(([p]) => name.startsWith(p)) || T15_MODEL_NAMES.test(name)) return 't15';
	if (E11_NAME_PREFIXES.some(([p]) => name.startsWith(p)) || E11_MODEL_NAMES.test(name)) return 'e11';
	if (E12_NAME_PREFIXES.some(([p]) => name.startsWith(p)) || E12_MODEL_NAMES.test(name)) return 'e12';
	return 't5080';
}
