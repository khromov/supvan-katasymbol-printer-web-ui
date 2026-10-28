/** Label design document. All geometry is in millimetres, origin at the label's top-left. */

export type Rotation = 0 | 90 | 180 | 270;

interface Base {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	rotation: Rotation;
	/** Print white-on-black inside the element box. */
	invert?: boolean;
}

export interface TextElement extends Base {
	type: 'text';
	text: string;
	font: string;
	/** Font size in points; ignored when `fit` is on. */
	size: number;
	bold: boolean;
	italic: boolean;
	underline?: boolean;
	align: 'left' | 'center' | 'right';
	valign: 'top' | 'middle' | 'bottom';
	/** Shrink/grow the text to fill the box. */
	fit: boolean;
	lineHeight: number;
	/** Dither color emoji instead of thresholding them (default on). */
	ditherEmoji?: boolean;
	/** Gamma applied to emoji before dithering; higher is darker (default DEFAULT_EMOJI_GAMMA). */
	emojiGamma?: number;
	/** Outline dithered emoji with a 1-dot edge so light ones stay readable (default on). */
	emojiOutline?: boolean;
}

export interface IconElement extends Base {
	type: 'icon';
	name: string;
	/** Stroke width in lucide units (24 unit viewbox, default 2). */
	strokeWidth: number;
}

export interface ShapeElement extends Base {
	type: 'shape';
	shape: 'rect' | 'ellipse' | 'line';
	/** Line/border thickness in mm. */
	thickness: number;
	fill: boolean;
	radius: number;
	/** Lines only: draw dashed, e.g. as a cut guide. */
	dashed?: boolean;
}

export interface QrElement extends Base {
	type: 'qr';
	value: string;
}

export interface ImageElement extends Base {
	type: 'image';
	src: string;
	/** 0..255 threshold, or dithering. */
	threshold: number;
	dither: boolean;
	/** Count colour by its saturation as dark, so light colours (yellow, orange) print solid. */
	colorAsBlack?: boolean;
}

export interface TableCell {
	text: string;
	align: 'left' | 'center' | 'right';
	/** Merged cells: this cell spans `colSpan` x `rowSpan` grid cells; the cells it covers are ignored. */
	colSpan?: number;
	rowSpan?: number;
}

export interface TableElement extends Base {
	type: 'table';
	/** Relative column widths and row heights; they are scaled to fill the element box. */
	colWidths: number[];
	rowHeights: number[];
	/** cells[row][col]. */
	cells: TableCell[][];
	border: boolean;
	/** Border line thickness in mm. */
	borderWidth: number;
	/** Space between the cell border and its text, in mm. */
	padding: number;
	font: string;
	/** Font size in points. */
	size: number;
	bold: boolean;
	valign: 'top' | 'middle' | 'bottom';
}

export type DesignElement = TextElement | IconElement | ShapeElement | QrElement | ImageElement | TableElement;

export interface Design {
	elements: DesignElement[];
}

export const PT_TO_MM = 25.4 / 72;

export const FONTS: { family: string; label: string; weights: number[] }[] = [
	{ family: 'Inter', label: 'Inter', weights: [400, 700] },
	{ family: 'Roboto Condensed', label: 'Roboto Condensed', weights: [400, 700] },
	{ family: 'Bebas Neue', label: 'Bebas Neue', weights: [400] },
	{ family: 'Archivo Black', label: 'Archivo Black', weights: [400] },
	{ family: 'Roboto Mono', label: 'Roboto Mono', weights: [400, 700] },
	{ family: 'Merriweather', label: 'Merriweather', weights: [400, 700] },
	{ family: 'Caveat', label: 'Caveat', weights: [400, 700] },
	{ family: 'Arial', label: 'Arial (system)', weights: [400, 700] },
	{ family: 'Georgia', label: 'Georgia (system)', weights: [400, 700] },
	{ family: 'Courier New', label: 'Courier New (system)', weights: [400, 700] }
];

let counter = 0;
export const newId = () => `el${Date.now().toString(36)}${(counter++).toString(36)}`;

export function makeText(labelW: number, labelH: number, text = 'Label text'): TextElement {
	const w = Math.max(10, labelW * 0.8);
	const h = Math.max(5, Math.min(labelH * 0.35, 20));
	return {
		id: newId(),
		type: 'text',
		x: (labelW - w) / 2,
		y: (labelH - h) / 2,
		w,
		h,
		rotation: 0,
		text,
		font: 'Inter',
		size: 14,
		bold: true,
		italic: false,
		align: 'center',
		valign: 'middle',
		fit: true,
		lineHeight: 1.15
	};
}

export function makeIcon(labelW: number, labelH: number, name: string): IconElement {
	const s = Math.max(5, Math.min(labelW, labelH) * 0.45);
	return { id: newId(), type: 'icon', x: (labelW - s) / 2, y: (labelH - s) / 2, w: s, h: s, rotation: 0, name, strokeWidth: 2 };
}

export function makeShape(labelW: number, labelH: number, shape: ShapeElement['shape']): ShapeElement {
	if (shape === 'line') {
		const w = labelW * 0.8;
		return { id: newId(), type: 'shape', shape, x: (labelW - w) / 2, y: labelH / 2 - 1, w, h: 2, rotation: 0, thickness: 0.5, fill: false, radius: 0 };
	}
	const inset = 1.5;
	return {
		id: newId(),
		type: 'shape',
		shape,
		x: inset,
		y: inset,
		w: labelW - inset * 2,
		h: labelH - inset * 2,
		rotation: 0,
		thickness: 0.6,
		fill: false,
		radius: shape === 'rect' ? 1.5 : 0
	};
}

export function makeQr(labelW: number, labelH: number, value = 'https://example.com'): QrElement {
	const s = Math.max(8, Math.min(labelW, labelH) * 0.6);
	return { id: newId(), type: 'qr', x: (labelW - s) / 2, y: (labelH - s) / 2, w: s, h: s, rotation: 0, value };
}

export function makeImage(labelW: number, labelH: number, src: string, aspect: number): ImageElement {
	let w = labelW * 0.6;
	let h = w / aspect;
	if (h > labelH * 0.8) {
		h = labelH * 0.8;
		w = h * aspect;
	}
	return { id: newId(), type: 'image', x: (labelW - w) / 2, y: (labelH - h) / 2, w, h, rotation: 0, src, threshold: 128, dither: true };
}

export function makeTable(labelW: number, labelH: number, rows = 3, cols = 2): TableElement {
	const w = Math.max(10, labelW * 0.85);
	const h = Math.max(6, labelH * 0.7);
	return {
		id: newId(),
		type: 'table',
		x: (labelW - w) / 2,
		y: (labelH - h) / 2,
		w,
		h,
		rotation: 0,
		colWidths: Array(cols).fill(w / cols),
		rowHeights: Array(rows).fill(h / rows),
		cells: Array.from({ length: rows }, () => Array.from({ length: cols }, (): TableCell => ({ text: '', align: 'left' }))),
		border: true,
		borderWidth: 0.3,
		padding: 0.6,
		font: 'Inter',
		size: 7,
		bold: false,
		valign: 'middle'
	};
}

/** Width/height of the element's unrotated content box (w/h are the box on the label). */
export const contentSize = (el: DesignElement) => (el.rotation === 90 || el.rotation === 270 ? { w: el.h, h: el.w } : { w: el.w, h: el.h });

/** Cumulative edges (0..total) of `sizes` scaled to fill `total`. */
export function tableEdges(sizes: number[], total: number): number[] {
	const sum = sizes.reduce((a, b) => a + b, 0) || 1;
	const out = [0];
	for (const s of sizes) out.push(out[out.length - 1] + (s / sum) * total);
	out[out.length - 1] = total;
	return out;
}

/** Anchor cells that are drawn, in reading order (cells covered by a merge are skipped). */
export function tableCells(el: TableElement) {
	const out: { r: number; c: number; rs: number; cs: number; cell: TableCell }[] = [];
	const rows = el.rowHeights.length;
	const cols = el.colWidths.length;
	const covered = new Uint8Array(rows * cols);
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			if (covered[r * cols + c]) continue;
			const cell = el.cells[r]?.[c] ?? { text: '', align: 'left' };
			const rs = Math.max(1, Math.min(cell.rowSpan ?? 1, rows - r));
			const cs = Math.max(1, Math.min(cell.colSpan ?? 1, cols - c));
			for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) covered[i * cols + j] = 1;
			out.push({ r, c, rs, cs, cell });
		}
	}
	return out;
}

/** The drawn (possibly merged) cell covering grid cell (r, c). */
export function cellAt(el: TableElement, r: number, c: number) {
	return tableCells(el).find((t) => r >= t.r && r < t.r + t.rs && c >= t.c && c < t.c + t.cs);
}

const cloneCells = (cells: TableCell[][]) => cells.map((row) => row.map((cell) => ({ ...cell })));

/**
 * Change the number of rows/columns. Rows and columns are added or removed at the end, new ones
 * get the average size, and merges are cut back to the new grid.
 */
export function resizeTableGrid(el: TableElement, rows: number, cols: number): Pick<TableElement, 'rowHeights' | 'colWidths' | 'cells'> {
	const grow = (sizes: number[], n: number) => {
		const avg = sizes.reduce((a, b) => a + b, 0) / (sizes.length || 1) || 1;
		return Array.from({ length: n }, (_, i) => sizes[i] ?? avg);
	};
	const cells = Array.from({ length: rows }, (_, r) =>
		Array.from({ length: cols }, (_, c): TableCell => {
			const cell = { ...(el.cells[r]?.[c] ?? { text: '', align: 'left' }) };
			if (cell.rowSpan) cell.rowSpan = Math.min(cell.rowSpan, rows - r);
			if (cell.colSpan) cell.colSpan = Math.min(cell.colSpan, cols - c);
			return cell;
		})
	);
	return { rowHeights: grow(el.rowHeights, rows), colWidths: grow(el.colWidths, cols), cells };
}

/**
 * Merge the cell at (r, c) with its neighbour to the right or below. Null when that would cut
 * through another merged cell or leave the table. Text of the absorbed cells is appended.
 */
export function mergeCells(el: TableElement, r: number, c: number, dir: 'right' | 'down'): TableCell[][] | null {
	const a = cellAt(el, r, c);
	if (!a) return null;
	const nr = dir === 'down' ? a.rs + 1 : a.rs;
	const nc = dir === 'right' ? a.cs + 1 : a.cs;
	if (a.r + nr > el.rowHeights.length || a.c + nc > el.colWidths.length) return null;
	const inside = (t: { r: number; c: number; rs: number; cs: number }) => t.r >= a.r && t.c >= a.c && t.r + t.rs <= a.r + nr && t.c + t.cs <= a.c + nc;
	const touches = (t: { r: number; c: number; rs: number; cs: number }) => t.r < a.r + nr && t.r + t.rs > a.r && t.c < a.c + nc && t.c + t.cs > a.c;
	const parts = tableCells(el).filter(touches);
	if (!parts.every(inside)) return null;
	const cells = cloneCells(el.cells);
	const anchor = cells[a.r][a.c];
	const texts = parts.map((t) => t.cell.text).filter((t) => t.trim());
	for (const t of parts) cells[t.r][t.c] = { text: '', align: t.cell.align };
	cells[a.r][a.c] = { ...anchor, text: texts.join(' '), rowSpan: nr > 1 ? nr : undefined, colSpan: nc > 1 ? nc : undefined };
	return cells;
}

/** Undo a merge: the cell at (r, c) goes back to one grid cell, the others reappear empty. */
export function splitCell(el: TableElement, r: number, c: number): TableCell[][] | null {
	const a = cellAt(el, r, c);
	if (!a || (a.rs === 1 && a.cs === 1)) return null;
	const cells = cloneCells(el.cells);
	delete cells[a.r][a.c].rowSpan;
	delete cells[a.r][a.c].colSpan;
	return cells;
}

const overlap = (a: Base, b: Base) =>
	Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Move a new element to the spot inside the label's safe area that overlaps existing
 * elements the least (shrinking it if the label is crowded), preferring the center.
 */
export function placeFree<T extends DesignElement>(
	el: T,
	existing: DesignElement[],
	area: { x: number; y: number; w: number; h: number }
): T {
	if (!existing.length) return el;
	let best = { cost: Infinity, x: el.x, y: el.y, s: 1 };
	for (const s of [1, 0.75, 0.55]) {
		const w = el.w * s;
		const h = el.h * s;
		if (w > area.w || h > area.h) continue;
		const cx = area.x + area.w / 2;
		const cy = area.y + area.h / 2;
		for (let y = area.y; y <= area.y + area.h - h + 1e-6; y += 0.5) {
			for (let x = area.x; x <= area.x + area.w - w + 1e-6; x += 0.5) {
				const box = { ...el, x, y, w, h };
				const covered = existing.reduce((n, o) => n + overlap(box, o), 0);
				const dist = Math.hypot(x + w / 2 - cx, y + h / 2 - cy);
				const cost = covered * 100 + dist + (1 - s) * 40;
				if (cost < best.cost) best = { cost, x, y, s };
			}
		}
		if (best.cost < 1e6 && best.cost < 100) break;
	}
	return { ...el, x: best.x, y: best.y, w: el.w * best.s, h: el.h * best.s };
}
