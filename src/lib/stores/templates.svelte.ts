import { newId, type DesignElement } from '../design/model';
import type { LabelSpec } from '../printer/types';
import { editor, nativeOrientation, type LabelDesign } from './editor.svelte';

const STORAGE_KEY = 'katasymbol-web:templates';
/** Marks an exported template file. */
const FILE_KIND = 'katasymbol-web-template';
const FILE_VERSION = 1;

export interface Template extends LabelDesign {
	id: string;
	name: string;
	/** Epoch ms of the last save. */
	savedAt: number;
}

const ELEMENT_TYPES = new Set<DesignElement['type']>(['text', 'icon', 'shape', 'qr', 'image', 'table']);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A design read from storage or a file, or null when it isn't one this app can open. */
function parseDesign(v: unknown): LabelDesign | null {
	if (!v || typeof v !== 'object') return null;
	const d = v as Partial<LabelDesign>;
	const label = d.label as LabelSpec | undefined;
	if (!label || typeof label.id !== 'string' || !isNum(label.lengthMm) || !isNum(label.widthMm) || label.lengthMm <= 0 || label.widthMm <= 0) return null;
	const p = label.padding;
	if (!p || ![p.top, p.bottom, p.left, p.right].every(isNum)) return null;
	if (!Array.isArray(d.elements)) return null;
	const ok = d.elements.every(
		(el) => el && typeof el === 'object' && typeof el.id === 'string' && ELEMENT_TYPES.has(el.type) && [el.x, el.y, el.w, el.h].every(isNum)
	);
	if (!ok) return null;
	const orientation = d.orientation === 'portrait' || d.orientation === 'landscape' ? d.orientation : nativeOrientation(label);
	return { label, orientation, elements: d.elements };
}

function load(): Template[] {
	try {
		const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
		if (!Array.isArray(raw)) return [];
		return raw.flatMap((t) => {
			const d = parseDesign(t);
			return d && typeof t.id === 'string' && typeof t.name === 'string' ? [{ ...d, id: t.id, name: t.name, savedAt: isNum(t.savedAt) ? t.savedAt : 0 }] : [];
		});
	} catch {
		return [];
	}
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Named label designs kept in this browser, plus export to / import from .json files. */
class TemplatesStore {
	list = $state<Template[]>(load());
	/** The templates dialog is showing. */
	open = $state(false);
	error = $state<string | null>(null);

	/** Newest first. */
	get sorted(): Template[] {
		return [...this.list].sort((a, b) => b.savedAt - a.savedAt);
	}

	byName(name: string): Template | undefined {
		return this.list.find((t) => sameName(t.name, name));
	}

	private write(next: Template[]): boolean {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			this.error = 'Browser storage is full (large images take the most room). Export templates to files and delete some here.';
			return false;
		}
		this.list = next;
		this.error = null;
		return true;
	}

	/** Save the current design under `name`, replacing a template with the same name. */
	save(name: string): boolean {
		name = name.trim();
		if (!name) return false;
		const existing = this.byName(name);
		const t: Template = { ...editor.design, id: existing?.id ?? newId(), name, savedAt: Date.now() };
		return this.write(existing ? this.list.map((x) => (x.id === existing.id ? t : x)) : [...this.list, t]);
	}

	/** Replace a template's design with the current one, keeping its name. */
	overwrite(id: string): boolean {
		return this.write(this.list.map((t) => (t.id === id ? { ...editor.design, id, name: t.name, savedAt: Date.now() } : t)));
	}

	rename(id: string, name: string): boolean {
		name = name.trim();
		if (!name) return false;
		return this.write(this.list.map((t) => (t.id === id ? { ...t, name } : t)));
	}

	remove(id: string) {
		this.write(this.list.filter((t) => t.id !== id));
	}

	/** Open a template in the editor (undo brings the previous design back). */
	apply(id: string) {
		const t = this.list.find((x) => x.id === id);
		if (!t) return;
		editor.loadDesign(JSON.parse(JSON.stringify(t)));
		this.open = false;
	}

	/** Download a design as a .json file. */
	exportFile(design: LabelDesign, name: string) {
		const data = { kind: FILE_KIND, version: FILE_VERSION, name, savedAt: Date.now(), ...design };
		const blob = new Blob([JSON.stringify(data, null, '\t')], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${name.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'label'}.katasymbol.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}

	/**
	 * Read an exported file, add it to the templates (with a new name if the name is taken) and
	 * open it. It still opens when storage is full; only keeping it fails.
	 */
	async importFile(file: File): Promise<void> {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(await file.text());
		} catch {
			this.error = `${file.name} isn't a template file.`;
			return;
		}
		const design = data?.kind === FILE_KIND ? parseDesign(data) : null;
		if (!design) {
			this.error = `${file.name} isn't a template file from this app.`;
			return;
		}
		const base = (typeof data.name === 'string' && data.name.trim()) || file.name.replace(/(\.katasymbol)?\.json$/i, '');
		let name = base;
		for (let i = 2; this.byName(name); i++) name = `${base} (${i})`;
		const t: Template = { ...design, id: newId(), name, savedAt: Date.now() };
		const kept = this.write([...this.list, t]);
		editor.loadDesign(JSON.parse(JSON.stringify(design)));
		// Keep the dialog up to show why it wasn't kept.
		if (kept) this.open = false;
	}
}

export const templates = new TemplatesStore();
