import type { Family, LabelSpec } from '../printer/types';

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
	ClassName1?: string;
	[k: string]: unknown;
}

const loaders: Record<Family, () => Promise<{ default: CatalogEntry[] }>> = {
	t5080: () => import('./t5080.json') as Promise<{ default: CatalogEntry[] }>,
	sp: () => import('./sp.json') as Promise<{ default: CatalogEntry[] }>,
	tp: () => import('./tp.json') as Promise<{ default: CatalogEntry[] }>,
	tp86a: () => import('./tp.json') as Promise<{ default: CatalogEntry[] }>,
	g: () => import('./g.json') as Promise<{ default: CatalogEntry[] }>
};

const cache = new Map<Family, LabelSpec[]>();

export const PAPER_TYPES: Record<number, string> = {
	0: 'Continuous',
	1: 'Die-cut',
	2: 'Die-cut',
	5: 'Card',
	6: 'Black mark card',
	12: 'Black mark',
	13: 'Black mark card',
	14: 'Transparent'
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
