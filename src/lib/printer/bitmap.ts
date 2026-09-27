import type { Bitmap } from './types';

/**
 * 2D bit grid helpers mirroring the official *ImageDataUtils rotate/flip/offset routines,
 * but on flat typed arrays.
 */
export interface Grid {
	/** Number of rows. */
	rows: number;
	/** Number of columns. */
	cols: number;
	data: Uint8Array;
}

export const fromBitmap = (b: Bitmap): Grid => ({ rows: b.height, cols: b.width, data: b.data });

export const toBitmap = (g: Grid): Bitmap => ({ width: g.cols, height: g.rows, data: g.data });

/** Rotate like the official rotateData(arr, w, h, deg) for 90, 180 and 270/-90. */
export function rotate(g: Grid, deg: number): Grid {
	const { rows: h, cols: w, data } = g;
	if (deg === 90) {
		// out[i][j] = in[h - j - 1][i], out is w x h
		const out = new Uint8Array(w * h);
		for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) out[i * h + j] = data[(h - j - 1) * w + i];
		return { rows: w, cols: h, data: out };
	}
	if (deg === 180) {
		const out = new Uint8Array(w * h);
		for (let i = 0, n = w * h; i < n; i++) out[i] = data[n - 1 - i];
		return { rows: h, cols: w, data: out };
	}
	if (deg === 270 || deg === -90) {
		// out[i][j] = in[j][w - i - 1], out is w x h
		const out = new Uint8Array(w * h);
		for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) out[i * h + j] = data[j * w + (w - i - 1)];
		return { rows: w, cols: h, data: out };
	}
	return g;
}

/** 1 = mirror left/right, 2 = mirror top/bottom. */
export function flip(g: Grid, type: 1 | 2): Grid {
	const { rows: h, cols: w, data } = g;
	const out = new Uint8Array(w * h);
	for (let i = 0; i < h; i++)
		for (let j = 0; j < w; j++)
			out[i * w + j] = type === 1 ? data[i * w + (w - j - 1)] : data[(h - i - 1) * w + j];
	return { rows: h, cols: w, data: out };
}

/** Official offsetData: shifts rows by offsetX (row index + offsetX) and columns by offsetY. */
export function offset(g: Grid, offsetX: number, offsetY: number): Grid {
	if (!offsetX && !offsetY) return g;
	const { rows: h, cols: w, data } = g;
	const out = new Uint8Array(w * h);
	for (let i = 0; i < h; i++) {
		const si = i + offsetX;
		if (si < 0 || si >= h) continue;
		for (let j = 0; j < w; j++) {
			const sj = j - offsetY;
			if (sj >= 0 && sj < w) out[i * w + j] = data[si * w + sj];
		}
	}
	return { rows: h, cols: w, data: out };
}

/** Keep the centered `max` rows (official safeData). */
export function cropRowsCentered(g: Grid, max: number): Grid {
	if (g.rows <= max) return g;
	const off = Math.floor((g.rows - max) / 2);
	return { rows: max, cols: g.cols, data: g.data.slice(off * g.cols, (off + max) * g.cols) };
}

/**
 * Column-major packing used by all Supvan families: each column becomes ceil(rows/8) bytes,
 * row r stored in byte floor(r/8), bit r%8 (LSB first).
 */
export function packColumns(g: Grid): { bytes: Uint8Array; bytesPerColumn: number } {
	const bpc = Math.ceil(g.rows / 8);
	const bytes = new Uint8Array(bpc * g.cols);
	for (let c = 0; c < g.cols; c++) {
		for (let r = 0; r < g.rows; r++) {
			if (g.data[r * g.cols + c]) bytes[c * bpc + (r >> 3)] |= 1 << (r & 7);
		}
	}
	return { bytes, bytesPerColumn: bpc };
}

/** Threshold RGBA pixels like the official clamp(): opaque and gray < 180 prints. */
export function rgbaToBitmap(rgba: Uint8ClampedArray, width: number, height: number, threshold = 180): Bitmap {
	const data = new Uint8Array(width * height);
	for (let i = 0; i < width * height; i++) {
		const a = rgba[i * 4 + 3];
		if (a <= threshold) continue;
		const gray = rgba[i * 4] * 0.3 + rgba[i * 4 + 1] * 0.59 + rgba[i * 4 + 2] * 0.11;
		if (gray < threshold) data[i] = 1;
	}
	return { width, height, data };
}
