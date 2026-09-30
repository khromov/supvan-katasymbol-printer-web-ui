/**
 * Quick label: text with an optional icon above it, an optional frame, laid out automatically
 * and turned to read horizontally or vertically on the loaded label. In grid mode the label
 * becomes a sheet of small labels, one per line of text, to cut apart with scissors.
 */
import type { LabelSpec } from '../printer/types';
import { newId, type DesignElement, type Rotation } from './model';

export interface QuickLabel {
	text: string;
	/** Lucide icon name, or null for none. */
	icon: string | null;
	font: string;
	orientation: 'horizontal' | 'vertical';
	frame: boolean;
	/** Cells per side of a grid of small labels (2..6), or 1 for one label. */
	grid: number;
}

export const DEFAULT_QUICK: QuickLabel = { text: '', icon: null, font: 'Inter', orientation: 'horizontal', frame: false, grid: 1 };

/** Grid choices: 1 (off), then 2×2 to 6×6. */
export const GRID_SIZES = [1, 2, 3, 4, 5, 6];

type Area = { x: number; y: number; w: number; h: number };
/** Strips the print head can't reach, as PrinterStore.unprintable reports them. */
export type Unprintable = { acrossX: boolean; mm: number } | null;
/** Space kept clear beyond an unprintable strip: the tape can sit a fraction off centre. */
const UNPRINTABLE_MARGIN = 0.5;
/** Frame line thickness, corner radius, and the space between the frame and the content, in mm. */
type FrameSpec = { thickness: number; radius: number; gap: number };

/** Whether the content has to be turned 90 degrees to get the chosen orientation on this label. */
export function quickRotated(q: QuickLabel, label: LabelSpec): boolean {
	const landscape = label.lengthMm >= label.widthMm;
	return (q.orientation === 'horizontal') !== landscape;
}

/** Grid mode: one small label per line, in reading order. A blank line leaves its cell empty. */
export function gridLines(q: QuickLabel): string[] {
	const lines = q.text.split('\n').map((l) => l.trim());
	while (lines.length && !lines[lines.length - 1]) lines.pop();
	return lines;
}

/** The label's padding, widened to keep clear of the strips the print head can't reach. */
function printablePadding(p: LabelSpec['padding'], unprintable: Unprintable): LabelSpec['padding'] {
	if (!unprintable) return p;
	const m = unprintable.mm + UNPRINTABLE_MARGIN;
	return unprintable.acrossX
		? { ...p, left: Math.max(p.left, m), right: Math.max(p.right, m) }
		: { ...p, top: Math.max(p.top, m), bottom: Math.max(p.bottom, m) };
}

/**
 * Build the design. Layout happens on a "reading" canvas (the label as the user reads it); when
 * that is turned relative to the label, each element is rotated 90 degrees clockwise onto it.
 * Content stays inside the label's padding and out of the `unprintable` strips.
 */
export function buildQuickDesign(q: QuickLabel, label: LabelSpec, unprintable: Unprintable = null): DesignElement[] {
	const rotated = quickRotated(q, label);
	const W = label.lengthMm;
	const H = label.widthMm;
	// Reading canvas and its safe area (label padding, rotated along with the canvas).
	const vw = rotated ? H : W;
	const vh = rotated ? W : H;
	const p = printablePadding(label.padding, unprintable);
	const pad = rotated ? { left: p.top, right: p.bottom, top: p.right, bottom: p.left } : p;

	const out: DesignElement[] = [];
	if (q.grid > 1) {
		layoutGrid(q, vw, vh, pad, out);
	} else {
		const area = { x: pad.left, y: pad.top, w: vw - pad.left - pad.right, h: vh - pad.top - pad.bottom };
		layoutLabel(q, q.text.trim(), area, { thickness: 0.8, radius: 2, gap: 1.8 }, out);
	}

	if (!rotated) return out;
	// Turn the reading canvas 90 degrees clockwise onto the label: (vx, vy) -> (W - vy, vx).
	return out.map((el) => {
		const cx = el.x + el.w / 2;
		const cy = el.y + el.h / 2;
		const w = el.h;
		const h = el.w;
		return { ...el, x: W - cy - w / 2, y: cx - h / 2, w, h, rotation: ((el.rotation + 90) % 360) as Rotation };
	});
}

/**
 * Split the whole label into equal cells, so every small label is the same size once cut out,
 * with dotted cut lines between them. Without any text, an icon fills every cell.
 */
function layoutGrid(q: QuickLabel, vw: number, vh: number, pad: LabelSpec['padding'], out: DesignElement[]) {
	const n = q.grid;
	const cw = vw / n;
	const ch = vh / n;
	for (let i = 1; i < n; i++) {
		out.push(cutLine(cw * i, vh, true));
		out.push(cutLine(ch * i, vw, false));
	}

	const s = Math.min(cw, ch);
	// Scissors are rarely exact: keep content clear of the cuts.
	const margin = Math.min(1, s * 0.08);
	const frame = { thickness: Math.min(0.8, Math.max(0.3, s * 0.05)), radius: Math.min(2, s * 0.08), gap: Math.min(1.8, s * 0.1) };
	const lines = gridLines(q);
	const iconOnly = !lines.some(Boolean);
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			const text = lines[r * n + c] ?? '';
			if (!text && !(iconOnly && q.icon)) continue;
			// Outer edges keep the label's padding, inner edges the cut margin.
			const x0 = c * cw + (c === 0 ? pad.left : margin);
			const y0 = r * ch + (r === 0 ? pad.top : margin);
			const x1 = (c + 1) * cw - (c === n - 1 ? pad.right : margin);
			const y1 = (r + 1) * ch - (r === n - 1 ? pad.bottom : margin);
			layoutLabel(q, text, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, frame, out);
		}
	}
}

/** One label's frame, icon and text inside `area`. */
function layoutLabel(q: QuickLabel, text: string, area: Area, frame: FrameSpec, out: DesignElement[]) {
	if (q.frame) {
		out.push({ id: newId(), type: 'shape', shape: 'rect', ...area, rotation: 0, thickness: frame.thickness, fill: false, radius: frame.radius });
		// Keep content clear of the frame's inner edge.
		const inset = frame.thickness + frame.gap;
		area = { x: area.x + inset, y: area.y + inset, w: area.w - inset * 2, h: area.h - inset * 2 };
	}

	if (q.icon && text) {
		// Icon above the text, with a little breathing room on top: it takes up to 45% of the
		// remaining height, the text the rest.
		const top = Math.min(2, area.h * 0.06);
		const gap = Math.min(2, area.h * 0.05);
		const iconSize = Math.min(area.w, (area.h - top) * 0.45);
		out.push({ id: newId(), type: 'icon', name: q.icon, x: area.x + (area.w - iconSize) / 2, y: area.y + top, w: iconSize, h: iconSize, rotation: 0, strokeWidth: 2 });
		const ty = area.y + top + iconSize + gap;
		out.push(textElement(q, text, area.x, ty, area.w, area.y + area.h - ty));
	} else if (q.icon) {
		const s = Math.min(area.w, area.h);
		out.push({ id: newId(), type: 'icon', name: q.icon, x: area.x + (area.w - s) / 2, y: area.y + (area.h - s) / 2, w: s, h: s, rotation: 0, strokeWidth: 2 });
	} else if (text) {
		out.push(textElement(q, text, area.x, area.y, area.w, area.h));
	}
}

/** A dotted cut line across the whole reading canvas, `at` mm from its left (vertical) or top edge. */
function cutLine(at: number, length: number, vertical: boolean): DesignElement {
	const box = 1;
	const pos = vertical ? { x: at - box / 2, y: 0, w: box, h: length } : { x: 0, y: at - box / 2, w: length, h: box };
	return { id: newId(), type: 'shape', shape: 'line', ...pos, rotation: vertical ? 90 : 0, thickness: 0.3, fill: false, radius: 0, dashed: true };
}

function textElement(q: QuickLabel, text: string, x: number, y: number, w: number, h: number): DesignElement {
	// A little side margin: glyphs of condensed/display fonts can overhang their advance width.
	const inset = Math.min(1, w * 0.03);
	return {
		id: newId(),
		type: 'text',
		x: x + inset,
		y,
		w: w - inset * 2,
		h,
		rotation: 0,
		text,
		font: q.font,
		size: 14,
		bold: true,
		italic: false,
		align: 'center',
		valign: 'middle',
		fit: true,
		lineHeight: 1.1
	};
}
