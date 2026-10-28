import { newId, type DesignElement } from '../design/model';
import type { LabelSpec } from '../printer/types';

const STORAGE_KEY = 'katasymbol-web:v1';

export type Orientation = 'portrait' | 'landscape';

/** A complete label design: what templates save and load. */
export interface LabelDesign {
	label: LabelSpec;
	orientation: Orientation;
	elements: DesignElement[];
}

/** How a label comes in its own frame (lengthMm x widthMm); square counts as landscape. */
export const nativeOrientation = (label: LabelSpec): Orientation => (label.lengthMm >= label.widthMm ? 'landscape' : 'portrait');

/**
 * The label turned a quarter turn, as the editor shows it in the other orientation. The editor's
 * top-left is the label's top-right: the printed bitmap is the view turned 90 degrees clockwise.
 * Paper direction flips too, so the design axis across the print head stays right.
 */
export function turnedLabel(label: LabelSpec): LabelSpec {
	const p = label.padding;
	return {
		...label,
		lengthMm: label.widthMm,
		widthMm: label.lengthMm,
		paperDirection: label.paperDirection === 0 ? 1 : 0,
		padding: { left: p.top, top: p.right, right: p.bottom, bottom: p.left }
	};
}

interface Saved {
	label: LabelSpec;
	labelAuto: boolean;
	elements: DesignElement[];
	density: number;
	copies: number;
	offsetX?: number;
	offsetY?: number;
	/** Orientation chosen per label id; labels without an entry are edited as they come. */
	orientations?: Record<string, Orientation>;
}

/** T53116, a common 40 x 30 mm T50 label, until the printer reports what is loaded. */
function defaultLabel(): LabelSpec {
	return {
		id: '5497',
		name: 'T53116',
		text: '40mm*30mm T53116E',
		lengthMm: 40,
		widthMm: 30,
		paperDirection: 1,
		paperType: 1,
		gap: 3,
		padding: { top: 1, bottom: 1, left: 1, right: 1 },
		extra: { ShapeType: 1 }
	};
}

function load(): Partial<Saved> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

class EditorStore {
	label = $state<LabelSpec>(defaultLabel());
	/** Follow the label detected in the printer. */
	labelAuto = $state(true);
	elements = $state<DesignElement[]>([]);
	selectedId = $state<string | null>(null);
	density = $state(4);
	copies = $state(1);
	cutType = $state(0);
	/** Print position offsets in the official dialog's units (4 dots per step, -48..48). */
	offsetX = $state(0);
	offsetY = $state(0);
	/** Bumped when the text field for a new element should grab focus. */
	focusRequest = $state(0);
	/** When set, the next icon picked replaces this icon element instead of adding one. */
	iconReplaceTarget = $state<string | null>(null);
	/** Orientation chosen per label id (see `orientation`). */
	orientations = $state<Record<string, Orientation>>({});
	/** Cell being edited in the selected table, as grid row/column. */
	tableCell = $state<{ id: string; r: number; c: number } | null>(null);
	/** Bumped when the selected table cell's text field should grab focus. */
	cellFocusRequest = $state(0);

	/** Layer copied with Ctrl/Cmd+C, kept in memory for pasting. */
	private clipboard: DesignElement | null = null;

	private past: string[] = [];
	private future: string[] = [];
	canUndo = $state(false);
	canRedo = $state(false);
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		const s = load();
		if (s.label) this.label = s.label;
		if (typeof s.labelAuto === 'boolean') this.labelAuto = s.labelAuto;
		if (Array.isArray(s.elements)) this.elements = s.elements;
		if (s.density) this.density = s.density;
		if (s.copies) this.copies = s.copies;
		if (typeof s.offsetX === 'number') this.offsetX = s.offsetX;
		if (typeof s.offsetY === 'number') this.offsetY = s.offsetY;
		if (s.orientations && typeof s.orientations === 'object') this.orientations = s.orientations;
	}

	get selected(): DesignElement | undefined {
		return this.elements.find((e) => e.id === this.selectedId);
	}

	/** Orientation the label is edited in. */
	get orientation(): Orientation {
		return this.orientations[this.label.id] ?? nativeOrientation(this.label);
	}

	/** The editor shows the label turned a quarter turn; the bitmap is turned back for printing. */
	get turned(): boolean {
		return this.isTurned(this.label);
	}

	/** The label in editor coordinates: what all element geometry is relative to. */
	get view(): LabelSpec {
		return this.viewOf(this.label);
	}

	private isTurned(label: LabelSpec, orientations = this.orientations) {
		const o = orientations[label.id];
		return !!o && o !== nativeOrientation(label);
	}

	private viewOf(label: LabelSpec, orientations = this.orientations): LabelSpec {
		return this.isTurned(label, orientations) ? turnedLabel(label) : label;
	}

	/** The current design, detached from the store. */
	get design(): LabelDesign {
		return {
			label: $state.snapshot(this.label) as LabelSpec,
			orientation: this.orientation,
			elements: $state.snapshot(this.elements) as DesignElement[]
		};
	}

	/**
	 * Replace the design with a saved one (undoable). A template for another label pins that label,
	 * so it opens as saved instead of being refitted to the label in the printer.
	 */
	loadDesign(d: LabelDesign) {
		this.checkpoint();
		if (d.label.id !== this.label.id) this.labelAuto = false;
		this.label = clone(d.label);
		this.orientations = { ...this.orientations, [d.label.id]: d.orientation };
		this.elements = clone(d.elements);
		this.selectedId = null;
		this.tableCell = null;
		this.persist();
	}

	/**
	 * Edit the label in portrait or landscape. The design is scaled to fit the turned label and
	 * centered, like switching labels; the choice is remembered for this label.
	 */
	setOrientation(o: Orientation) {
		if (o === this.orientation) return;
		this.checkpoint();
		const old = this.view;
		this.orientations = { ...this.orientations, [this.label.id]: o };
		this.fitElements(old, this.view);
		this.persist();
	}

	persist() {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			const data: Saved = {
				label: $state.snapshot(this.label) as LabelSpec,
				labelAuto: this.labelAuto,
				elements: $state.snapshot(this.elements) as DesignElement[],
				density: this.density,
				copies: this.copies,
				offsetX: this.offsetX,
				offsetY: this.offsetY,
				orientations: $state.snapshot(this.orientations)
			};
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
			} catch {
				// Storage unavailable (private mode, quota); the design just won't persist.
			}
		}, 300);
	}

	private snapshot() {
		return JSON.stringify({ elements: $state.snapshot(this.elements), label: $state.snapshot(this.label), orientations: $state.snapshot(this.orientations) });
	}

	/** Record the current state before a change, for undo. */
	checkpoint() {
		this.past.push(this.snapshot());
		if (this.past.length > 100) this.past.shift();
		this.future = [];
		this.canUndo = true;
		this.canRedo = false;
	}

	private restore(raw: string) {
		const s = JSON.parse(raw);
		this.elements = s.elements;
		this.label = s.label;
		if (s.orientations) this.orientations = s.orientations;
		if (this.selectedId && !this.elements.some((e) => e.id === this.selectedId)) this.selectedId = null;
		this.persist();
	}

	undo() {
		const prev = this.past.pop();
		if (!prev) return;
		this.future.push(this.snapshot());
		this.restore(prev);
		this.canUndo = this.past.length > 0;
		this.canRedo = true;
	}

	redo() {
		const next = this.future.pop();
		if (!next) return;
		this.past.push(this.snapshot());
		this.restore(next);
		this.canRedo = this.future.length > 0;
		this.canUndo = true;
	}

	add(el: DesignElement, focus = false) {
		this.checkpoint();
		this.elements.push(el);
		this.selectedId = el.id;
		if (focus) this.focusRequest++;
		this.persist();
	}

	update(id: string, patch: Partial<DesignElement>, record = true) {
		const el = this.elements.find((e) => e.id === id);
		if (!el) return;
		if (record) this.checkpoint();
		Object.assign(el, patch);
		this.persist();
	}

	remove(id = this.selectedId) {
		if (!id) return;
		this.checkpoint();
		this.elements = this.elements.filter((e) => e.id !== id);
		if (this.selectedId === id) this.selectedId = null;
		this.persist();
	}

	/** A copy of `el` with a fresh id, nudged down-right but kept on the label. */
	private offsetCopy(el: DesignElement): DesignElement {
		const copy = { ...clone(el), id: newId() };
		copy.x = Math.min(copy.x + 2, this.view.lengthMm - copy.w);
		copy.y = Math.min(copy.y + 2, this.view.widthMm - copy.h);
		return copy;
	}

	duplicate(id = this.selectedId) {
		const el = this.elements.find((e) => e.id === id);
		if (!el) return;
		this.add(this.offsetCopy($state.snapshot(el) as DesignElement));
	}

	copy(id = this.selectedId) {
		const el = this.elements.find((e) => e.id === id);
		if (el) this.clipboard = $state.snapshot(el) as DesignElement;
	}

	/** Paste the copied layer. Each paste steps further from the last, so repeats don't stack. */
	paste() {
		if (!this.clipboard) return;
		const copy = this.offsetCopy(this.clipboard);
		this.clipboard = clone(copy);
		this.add(copy);
	}

	reorder(id: string, dir: 'up' | 'down' | 'top' | 'bottom') {
		const i = this.elements.findIndex((e) => e.id === id);
		if (i < 0) return;
		this.checkpoint();
		const [el] = this.elements.splice(i, 1);
		const j = dir === 'top' ? this.elements.length : dir === 'bottom' ? 0 : dir === 'up' ? Math.min(this.elements.length, i + 1) : Math.max(0, i - 1);
		this.elements.splice(j, 0, el);
		this.persist();
	}

	clear() {
		if (!this.elements.length) return;
		this.checkpoint();
		this.elements = [];
		this.selectedId = null;
		this.persist();
	}

	/**
	 * Resize the label without scaling the design (a roll label cut to another length): the
	 * elements keep their size and stay centered.
	 */
	resizeLabel(label: LabelSpec) {
		const old = this.view;
		const next = this.viewOf(label);
		if (old.lengthMm === next.lengthMm && old.widthMm === next.widthMm) return;
		this.checkpoint();
		const dx = (next.lengthMm - old.lengthMm) / 2;
		const dy = (next.widthMm - old.widthMm) / 2;
		for (const el of this.elements) {
			el.x += dx;
			el.y += dy;
		}
		this.label = label;
		this.persist();
	}

	/** Switch label, scaling the layout uniformly so it keeps its composition. */
	setLabel(label: LabelSpec, auto = this.labelAuto) {
		const old = this.label;
		this.labelAuto = auto;
		if (old.id === label.id && old.lengthMm === label.lengthMm && old.widthMm === label.widthMm) {
			this.label = label;
			this.persist();
			return;
		}
		this.checkpoint();
		this.fitElements(this.viewOf(old), this.viewOf(label));
		this.label = label;
		this.persist();
	}

	/** Scale the layout uniformly from one editor frame to another, keeping its composition. */
	private fitElements(old: LabelSpec, next: LabelSpec) {
		const s = Math.min(next.lengthMm / old.lengthMm, next.widthMm / old.widthMm);
		const dx = (next.lengthMm - old.lengthMm * s) / 2;
		const dy = (next.widthMm - old.widthMm * s) / 2;
		if (!Number.isFinite(s) || s <= 0 || (Math.abs(s - 1) <= 1e-6 && !dx && !dy)) return;
		for (const el of this.elements) {
			el.x = el.x * s + dx;
			el.y = el.y * s + dy;
			el.w *= s;
			el.h *= s;
			if (el.type === 'text' && !el.fit) el.size = Math.max(4, Math.round(el.size * s * 2) / 2);
			if (el.type === 'shape') el.thickness = Math.max(0.2, el.thickness * s);
			if (el.type === 'table') {
				el.size = Math.max(3, Math.round(el.size * s * 2) / 2);
				el.borderWidth = Math.max(0.15, el.borderWidth * s);
				el.padding *= s;
			}
		}
	}
}

export const editor = new EditorStore();
