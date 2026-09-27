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
