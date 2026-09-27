/**
 * Quick label: text with an optional icon above it, an optional frame, laid out automatically
 * and turned to read horizontally or vertically on the loaded label.
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
}

export const DEFAULT_QUICK: QuickLabel = { text: '', icon: null, font: 'Inter', orientation: 'horizontal', frame: false };

/** Whether the content has to be turned 90 degrees to get the chosen orientation on this label. */
export function quickRotated(q: QuickLabel, label: LabelSpec): boolean {
	const landscape = label.lengthMm >= label.widthMm;
	return (q.orientation === 'horizontal') !== landscape;
}

/**
 * Build the design. Layout happens on a "reading" canvas (the label as the user reads it); when
 * that is turned relative to the label, each element is rotated 90 degrees clockwise onto it.
 */
export function buildQuickDesign(q: QuickLabel, label: LabelSpec): DesignElement[] {
	const rotated = quickRotated(q, label);
	const W = label.lengthMm;
	const H = label.widthMm;
	// Reading canvas and its safe area (label padding, rotated along with the canvas).
	const vw = rotated ? H : W;
	const vh = rotated ? W : H;
	const p = label.padding;
	const pad = rotated ? { left: p.top, right: p.bottom, top: p.right, bottom: p.left } : p;
	let area = { x: pad.left, y: pad.top, w: vw - pad.left - pad.right, h: vh - pad.top - pad.bottom };

	const out: DesignElement[] = [];
	if (q.frame) {
		const thickness = 0.8;
		out.push({ id: newId(), type: 'shape', shape: 'rect', ...area, rotation: 0, thickness, fill: false, radius: 2 });
		// Keep content clear of the frame's inner edge.
		const inset = thickness + 1.8;
		area = { x: area.x + inset, y: area.y + inset, w: area.w - inset * 2, h: area.h - inset * 2 };
	}

	const text = q.text.trim();
	if (q.icon && text) {
		// Icon above the text, with a little breathing room on top: it takes up to 45% of the
		// remaining height, the text the rest.
		const top = Math.min(2, area.h * 0.06);
		const gap = Math.min(2, area.h * 0.05);
		const iconSize = Math.min(area.w, (area.h - top) * 0.45);
		out.push({ id: newId(), type: 'icon', name: q.icon, x: area.x + (area.w - iconSize) / 2, y: area.y + top, w: iconSize, h: iconSize, rotation: 0, strokeWidth: 2 });
		const ty = area.y + top + iconSize + gap;
		out.push(textElement(q, area.x, ty, area.w, area.y + area.h - ty));
	} else if (q.icon) {
		const s = Math.min(area.w, area.h);
		out.push({ id: newId(), type: 'icon', name: q.icon, x: area.x + (area.w - s) / 2, y: area.y + (area.h - s) / 2, w: s, h: s, rotation: 0, strokeWidth: 2 });
	} else if (text) {
		out.push(textElement(q, area.x, area.y, area.w, area.h));
	}

	if (!rotated) return out;
	// Turn the reading canvas 90 degrees clockwise onto the label: (vx, vy) -> (W - vy, vx).
	return out.map((el) => {
		const cx = el.x + el.w / 2;
		const cy = el.y + el.h / 2;
		const w = el.h;
		const h = el.w;
		return { ...el, x: W - cy - w / 2, y: cx - h / 2, w, h, rotation: 90 as Rotation };
	});
}

function textElement(q: QuickLabel, x: number, y: number, w: number, h: number): DesignElement {
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
		text: q.text.trim(),
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
