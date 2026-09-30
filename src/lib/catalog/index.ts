import type { Family, LabelSpec } from '../printer/types';

/**
 * A label from the official app's catalog, trimmed by scripts/extract-catalog.mjs to the fields
 * used here. Optional fields are left out when they hold their default ('' or 0, ShapeType 1).
 */
interface CatalogEntry {
	ID: string | number;
	Name: string;
	Text?: string;
	TapeLength: number;
	TapeWidth: number;
	PaperDirection: number;
	PaperType: number;
	DieCutGap: number;
	Padding: { Top: number; Bottom: number; Left: number; Right: number };
	ShapeType?: number;
	/** SP plate hole layout (read by the SP driver through LabelSpec.extra). */
	HoleStyle?: number;
	HoleWidth?: number;
	HoleHeight?: number;
	ClassName1?: string;
	[k: string]: unknown;
}

const loaders: Record<Family, () => Promise<{ default: CatalogEntry[] }>> = {
	t5080: () => import('./t5080.json') as Promise<{ default: CatalogEntry[] }>,
	sp: () => import('./sp.json') as Promise<{ default: CatalogEntry[] }>,
	tp: () => import('./tp.json') as Promise<{ default: CatalogEntry[] }>,
	tp86a: () => import('./tp.json') as Promise<{ default: CatalogEntry[] }>,
	g: () => import('./g.json') as Promise<{ default: CatalogEntry[] }>,
	// From Supvan's template server (scripts/download-catalog.mjs); KatasymbolEditor has none.
	t15: () => import('./t15.json') as Promise<{ default: CatalogEntry[] }>
};

const cache = new Map<Family, LabelSpec[]>();

/** store/enum/paperTypeEnum.js (2 is used by the SP catalog for die-cut). */
export const PAPER_TYPES: Record<number, string> = {
	0: 'Continuous',
	1: 'Die-cut',
	2: 'Die-cut',
	3: 'Marker card',
	4: 'Flag label',
	5: 'Plate',
	6: 'Tube',
	7: 'Heat-shrink tube',
	8: 'Marker strip',
	9: 'Continuous with holes',
	10: 'Reflective',
	11: 'Laminated aluminum',
	12: 'Black mark',
	13: 'Black-mark card',
	14: 'Black-mark sticker',
	21: 'Laminated wrap, continuous',
	22: 'Laminated wrap, die-cut'
};

export function toLabelSpec(e: CatalogEntry): LabelSpec {
	const text = (e.Text ?? '').replace(/<br\s*\/?>/gi, ' ').trim();
	return {
		id: String(e.ID),
		name: e.Name,
		text,
		lengthMm: e.TapeLength,
		widthMm: e.TapeWidth,
		paperDirection: e.PaperDirection,
		paperType: e.PaperType,
		gap: e.DieCutGap,
		padding: { top: e.Padding?.Top ?? 0, bottom: e.Padding?.Bottom ?? 0, left: e.Padding?.Left ?? 0, right: e.Padding?.Right ?? 0 },
		className: e.ClassName1 || undefined,
		extra: e
	};
}

export async function loadCatalog(family: Family): Promise<LabelSpec[]> {
	const hit = cache.get(family);
	if (hit) return hit;
	const mod = await loaders[family]();
	const seen = new Set<string>();
	const labels = mod.default.map(toLabelSpec).filter((l) => !seen.has(l.id) && seen.add(l.id));
	cache.set(family, labels);
	return labels;
}

/**
 * Paper types cut off a roll wherever printing stops (continuous tape, tubes, heat-shrink tube,
 * continuous with holes, laminated wrap): their catalog length is only a starting point.
 */
const ROLL_PAPER_TYPES = new Set([0, 6, 7, 9, 21]);
/**
 * Lengths offered for roll labels, in mm. The printers take any length; the cap guards against
 * typos that would print metres of tape (500 mm is about half a minute on an E10).
 */
export const ROLL_LENGTH = { min: 10, max: 500 };

/** Whether the label comes off a roll, so its length along the tape can be anything. */
export function rollLabel(label: LabelSpec): boolean {
	return ROLL_PAPER_TYPES.has(label.paperType);
}

/**
 * Whether the label's length can follow its content (auto length): only tape off a roll in a strip
 * label maker (E10/T10 series, G series). Elsewhere a roll label keeps the length the user sets.
 */
export function autoLengthLabel(label: LabelSpec, family: Family): boolean {
	return (family === 't15' || family === 'g') && rollLabel(label);
}

/** Length along the tape: the design's width, or its height when the design runs across the head. */
export function tapeLength(label: LabelSpec): number {
	return label.paperDirection === 1 ? label.widthMm : label.lengthMm;
}

export function withTapeLength(label: LabelSpec, mm: number): LabelSpec {
	return label.paperDirection === 1 ? { ...label, widthMm: mm } : { ...label, lengthMm: mm };
}

/** Label outline shape from the catalog (1 rectangle, 2 rounded, 3 round). */
export function labelShape(label: LabelSpec): 'rect' | 'rounded' | 'round' {
	const s = Number(label.extra?.ShapeType ?? 1);
	return s === 2 ? 'rounded' : s === 3 ? 'round' : 'rect';
}

export function labelTitle(label: LabelSpec): string {
	const size = `${label.lengthMm} × ${label.widthMm} mm`;
	return label.id.startsWith('custom') ? `Custom ${size}` : `${size} · ${label.name}`;
}

export function customLabel(lengthMm: number, widthMm: number, family: Family, paperType = 1, gap = 3): LabelSpec {
	return {
		id: `custom-${lengthMm}x${widthMm}`,
		name: 'Custom',
		lengthMm,
		widthMm,
		paperDirection: family === 't5080' ? 1 : 0,
		paperType,
		gap,
		padding: { top: 1, bottom: 1, left: 1, right: 1 }
	};
}
