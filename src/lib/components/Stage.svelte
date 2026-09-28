<script lang="ts">
	import { Maximize, Minus, Plus, Redo2, Undo2, Grid3x3, Sparkles } from 'lucide-static';
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import { editor } from '../stores/editor.svelte';
	import { printer } from '../stores/printer.svelte';
	import { bitmapToCanvas, prepareAssets, renderBitmap, renderDesign } from '../design/render';
	import { labelShape } from '../catalog';
	import { T15_PRINT_DOTS } from '../printer/families/t15';
	import type { DesignElement } from '../design/model';

	type Mode = 'dots' | 'smooth';
	const MODE_KEY = 'katasymbol-web:stage-mode';

	let cw = $state(0);
	let ch = $state(0);
	let zoom = $state<number | 'fit'>('fit');
	let mode = $state<Mode>(readMode());
	let canvas: HTMLCanvasElement;
	let guides = $state<{ v: number[]; h: number[] }>({ v: [], h: [] });

	function readMode(): Mode {
		try {
			return localStorage.getItem(MODE_KEY) === 'smooth' ? 'smooth' : 'dots';
		} catch {
			return 'dots';
		}
	}

	function setMode(m: Mode) {
		mode = m;
		try {
			localStorage.setItem(MODE_KEY, m);
		} catch {
			// ignore
		}
	}

	const W = $derived(editor.label.lengthMm);
	const H = $derived(editor.label.widthMm);
	const fitScale = $derived.by(() => {
		const small = cw < 640;
		return Math.max(1, Math.min((cw - (small ? 40 : 96)) / W, (ch - (small ? 96 : 120)) / H));
	});
	const scale = $derived(zoom === 'fit' ? fitScale : zoom);
	const shape = $derived(labelShape(editor.label));
	const pad = $derived(editor.label.padding);

	/**
	 * Strips the print head cannot reach (T50/T80 crop the across-head axis to the head width, the
	 * E10/T10 series print the middle 88 dots of their 96-dot head).
	 */
	const deadZones = $derived.by(() => {
		const model = printer.model;
		const family = printer.family;
		const headDots = family === 't15' ? T15_PRINT_DOTS : family === 't5080' ? (model?.headDots ?? 384) : 0;
		if (!headDots) return null;
		const dpmm = model?.dpmm ?? 8;
		const acrossX = editor.label.paperDirection !== 0;
		const acrossMm = acrossX ? W : H;
		const extra = (acrossMm * dpmm - headDots) / dpmm / 2;
		return extra > 0 ? { acrossX, mm: extra } : null;
	});

	// Render whenever the design, label, mode or zoom changes.
	let token = 0;
	$effect(() => {
		const design = { elements: $state.snapshot(editor.elements) as DesignElement[] };
		const label = $state.snapshot(editor.label);
		const m = mode;
		const s = scale;
		const size = printer.canvasSize(label);
		const dpmm = printer.dpmm;
		const my = ++token;
		requestAnimationFrame(async () => {
			if (my !== token || !canvas) return;
			await prepareAssets(design);
			if (my !== token) return;
			if (m === 'dots') {
				const bmp = await renderBitmap(design, label.lengthMm, label.widthMm, size.width, size.height, dpmm);
				if (my === token) bitmapToCanvas(bmp, canvas);
			} else {
				const dpr = Math.min(3, window.devicePixelRatio || 1);
				canvas.width = Math.round(label.lengthMm * s * dpr);
				canvas.height = Math.round(label.widthMm * s * dpr);
				renderDesign(canvas.getContext('2d')!, design, label.lengthMm, label.widthMm, s * dpr);
			}
		});
	});

	// ---- Pointer interaction ----
	type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
	const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
	let drag: {
		id: string;
		kind: 'move' | Handle;
		startX: number;
		startY: number;
		orig: { x: number; y: number; w: number; h: number };
		moved: boolean;
	} | null = null;

	const keepsAspect = (el: DesignElement) => el.type === 'icon' || el.type === 'qr' || el.type === 'image';

	function startDrag(e: PointerEvent, el: DesignElement, kind: 'move' | Handle) {
		if (e.button !== 0) return;
		e.stopPropagation();
		editor.selectedId = el.id;
		drag = { id: el.id, kind, startX: e.clientX, startY: e.clientY, orig: { x: el.x, y: el.y, w: el.w, h: el.h }, moved: false };
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			// Pointer already released (e.g. synthetic events); dragging still works without capture.
		}
	}

	function snap(value: number, targets: number[], threshold: number): { v: number; hit: number | null } {
		let best: number | null = null;
		for (const t of targets) if (Math.abs(value - t) <= threshold && (best === null || Math.abs(value - t) < Math.abs(value - best))) best = t;
		return best === null ? { v: value, hit: null } : { v: best, hit: best };
	}

	function onMove(e: PointerEvent) {
		if (!drag) return;
		const el = editor.elements.find((x) => x.id === drag!.id);
		if (!el) return;
		const dx = (e.clientX - drag.startX) / scale;
		const dy = (e.clientY - drag.startY) / scale;
		if (!drag.moved) {
			if (Math.hypot(dx * scale, dy * scale) < 3) return;
			editor.checkpoint();
			drag.moved = true;
		}
		const o = drag.orig;
		const th = 6 / scale;
		const vx = [0, W / 2, W, pad.left, W - pad.right];
		const hy = [0, H / 2, H, pad.top, H - pad.bottom];
		const gv: number[] = [];
		const gh: number[] = [];
		if (drag.kind === 'move') {
			let x = o.x + dx;
			let y = o.y + dy;
			if (!e.altKey) {
				// Snap left edge, center or right edge to label guides.
				for (const off of [0, o.w / 2, o.w]) {
					const r = snap(x + off, vx, th);
					if (r.hit !== null) {
						x = r.v - off;
						gv.push(r.hit);
						break;
					}
				}
				for (const off of [0, o.h / 2, o.h]) {
					const r = snap(y + off, hy, th);
					if (r.hit !== null) {
						y = r.v - off;
						gh.push(r.hit);
						break;
					}
				}
			}
			el.x = x;
			el.y = y;
		} else {
			const k = drag.kind;
			let { x, y, w, h } = o;
			if (k.includes('e')) w = Math.max(1, o.w + dx);
			if (k.includes('s')) h = Math.max(1, o.h + dy);
			if (k.includes('w')) {
				w = Math.max(1, o.w - dx);
				x = o.x + o.w - w;
			}
			if (k.includes('n')) {
				h = Math.max(1, o.h - dy);
				y = o.y + o.h - h;
			}
			// Corner handles lock the aspect ratio for icons/QR/images; Shift toggles it.
			if (k.length === 2 && keepsAspect(el) !== e.shiftKey) {
				const ratio = o.w / o.h;
				if (w / h > ratio) w = h * ratio;
				else h = w / ratio;
				if (k.includes('w')) x = o.x + o.w - w;
				if (k.includes('n')) y = o.y + o.h - h;
			}
			Object.assign(el, { x, y, w, h });
		}
		guides = { v: gv, h: gh };
	}

	function endDrag() {
		if (drag?.moved) editor.persist();
		drag = null;
		guides = { v: [], h: [] };
	}

	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t.closest('input, textarea, select, [contenteditable]')) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			if (e.shiftKey) editor.redo();
			else editor.undo();
			return;
		}
		if (mod && e.key.toLowerCase() === 'y') {
			e.preventDefault();
			editor.redo();
			return;
		}
		const el = editor.selected;
		if (!el) return;
		if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			editor.remove(el.id);
		} else if (mod && e.key.toLowerCase() === 'd') {
			e.preventDefault();
			editor.duplicate(el.id);
		} else if (e.key === 'Escape') {
			editor.selectedId = null;
		} else if (e.key.startsWith('Arrow')) {
			e.preventDefault();
			const step = e.shiftKey ? 2 : 0.5;
			const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
			const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
			editor.update(el.id, { x: el.x + dx, y: el.y + dy });
		} else if (e.key === 'Enter' && el.type === 'text') {
			e.preventDefault();
			editor.focusRequest++;
		}
	}

	onMount(() => {
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	function zoomBy(f: number) {
		zoom = Math.min(60, Math.max(2, Math.round(scale * f * 10) / 10));
	}

	const pct = $derived(Math.round((scale / (96 / 25.4)) * 100));
</script>

<div class="stage" bind:clientWidth={cw} bind:clientHeight={ch}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="viewport" onpointerdown={() => (editor.selectedId = null)}>
		<div
			class="paper"
			class:rounded={shape === 'rounded'}
			class:round={shape === 'round'}
			style:width="{W * scale}px"
			style:height="{H * scale}px"
			style:--r="{2.5 * scale}px"
		>
			<canvas bind:this={canvas} class:dots={mode === 'dots'}></canvas>

			<svg class="guides" viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
				<rect
					x={pad.left}
					y={pad.top}
					width={Math.max(0, W - pad.left - pad.right)}
					height={Math.max(0, H - pad.top - pad.bottom)}
					class="safe"
					vector-effect="non-scaling-stroke"
				/>
				{#if deadZones}
					<defs>
						<pattern id="hatch" width="1.2" height="1.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
							<rect width="0.35" height="1.2" class="hatch" />
						</pattern>
					</defs>
					{#if deadZones.acrossX}
						<rect x="0" y="0" width={deadZones.mm} height={H} fill="url(#hatch)" />
						<rect x={W - deadZones.mm} y="0" width={deadZones.mm} height={H} fill="url(#hatch)" />
					{:else}
						<rect x="0" y="0" width={W} height={deadZones.mm} fill="url(#hatch)" />
						<rect x="0" y={H - deadZones.mm} width={W} height={deadZones.mm} fill="url(#hatch)" />
					{/if}
				{/if}
				{#each guides.v as gx (gx)}<line x1={gx} x2={gx} y1="0" y2={H} class="snap" vector-effect="non-scaling-stroke" />{/each}
				{#each guides.h as gy (gy)}<line y1={gy} y2={gy} x1="0" x2={W} class="snap" vector-effect="non-scaling-stroke" />{/each}
			</svg>

			<div class="overlay" onpointermove={onMove} onpointerup={endDrag} onpointercancel={endDrag}>
				{#each editor.elements as el (el.id)}
					<div
						class="box"
						class:selected={el.id === editor.selectedId}
						style:left="{el.x * scale}px"
						style:top="{el.y * scale}px"
						style:width="{el.w * scale}px"
						style:height="{el.h * scale}px"
						onpointerdown={(e) => startDrag(e, el, 'move')}
						ondblclick={() => el.type === 'text' && editor.focusRequest++}
						role="button"
						tabindex="-1"
						aria-label="{el.type} element"
					>
						{#if el.id === editor.selectedId}
							{#each HANDLES as hd (hd)}
								<span class="handle {hd}" onpointerdown={(e) => startDrag(e, el, hd)}></span>
							{/each}
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>

	{#if !editor.elements.length}
		<div class="empty-hint">Add text or pick an icon on the left to start your label</div>
	{/if}

	<div class="toolbar">
		<div class="row">
			<button class="btn sm icon ghost" onclick={() => editor.undo()} disabled={!editor.canUndo} title="Undo (⌘Z)"><Icon svg={Undo2} size={15} /></button>
			<button class="btn sm icon ghost" onclick={() => editor.redo()} disabled={!editor.canRedo} title="Redo (⇧⌘Z)"><Icon svg={Redo2} size={15} /></button>
		</div>
		<div class="segmented mode">
			<button class:on={mode === 'dots'} onclick={() => setMode('dots')} title="Exactly the dots the printer will print">
				<Icon svg={Grid3x3} size={14} /> Print dots
			</button>
			<button class:on={mode === 'smooth'} onclick={() => setMode('smooth')} title="Smooth preview">
				<Icon svg={Sparkles} size={14} /> Smooth
			</button>
		</div>
		<div class="row">
			<button class="btn sm icon ghost zoom-out" onclick={() => zoomBy(1 / 1.25)} title="Zoom out"><Icon svg={Minus} size={15} /></button>
			<button class="btn sm ghost zoom" onclick={() => (zoom = 'fit')} title="Fit to screen">{pct}%</button>
			<button class="btn sm icon ghost zoom-in" onclick={() => zoomBy(1.25)} title="Zoom in"><Icon svg={Plus} size={15} /></button>
			<button class="btn sm icon ghost" class:active={zoom === 'fit'} onclick={() => (zoom = 'fit')} title="Fit"><Icon svg={Maximize} size={14} /></button>
		</div>
	</div>
</div>

<style>
	.stage {
		position: relative;
		min-width: 0;
		min-height: 0;
		background-color: var(--stage);
		background-image: radial-gradient(var(--stage-dots) 1px, transparent 1px);
		background-size: 16px 16px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.viewport {
		flex: 1;
		overflow: auto;
		display: grid;
		place-items: center;
		padding: 48px 48px 72px;
		min-height: 0;
	}

	.paper {
		position: relative;
		background: var(--paper);
		box-shadow:
			0 0 0 1px rgb(0 0 0 / 0.08),
			0 2px 6px rgb(0 0 0 / 0.08),
			0 12px 32px rgb(0 0 0 / 0.12);
		flex: none;
	}

	.paper.rounded,
	.paper.rounded canvas {
		border-radius: var(--r);
	}

	.paper.round,
	.paper.round canvas {
		border-radius: 50%;
	}

	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}

	canvas.dots {
		image-rendering: pixelated;
	}

	.guides {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		overflow: visible;
	}

	.safe {
		fill: none;
		stroke: #2f6fe4;
		stroke-opacity: 0.35;
		stroke-dasharray: 4 3;
		stroke-width: 1;
	}

	.hatch {
		fill: #c2362b;
		fill-opacity: 0.25;
	}

	.snap {
		stroke: #e8542b;
		stroke-width: 1;
	}

	.overlay {
		position: absolute;
		inset: 0;
	}

	.box {
		position: absolute;
		cursor: move;
		outline: 1px dashed transparent;
		touch-action: none;
	}

	.box:hover {
		outline-color: color-mix(in oklab, var(--select), transparent 40%);
	}

	.box.selected {
		outline: 1.5px solid var(--select);
	}

	.handle {
		position: absolute;
		width: 10px;
		height: 10px;
		background: #fff;
		border: 1.5px solid var(--select);
		border-radius: 2px;
		touch-action: none;
	}

	.handle.nw { left: -5px; top: -5px; cursor: nwse-resize; }
	.handle.n { left: calc(50% - 5px); top: -5px; cursor: ns-resize; }
	.handle.ne { right: -5px; top: -5px; cursor: nesw-resize; }
	.handle.e { right: -5px; top: calc(50% - 5px); cursor: ew-resize; }
	.handle.se { right: -5px; bottom: -5px; cursor: nwse-resize; }
	.handle.s { left: calc(50% - 5px); bottom: -5px; cursor: ns-resize; }
	.handle.sw { left: -5px; bottom: -5px; cursor: nesw-resize; }
	.handle.w { left: -5px; top: calc(50% - 5px); cursor: ew-resize; }

	.empty-hint {
		position: absolute;
		left: 50%;
		bottom: 64px;
		transform: translateX(-50%);
		padding: 6px 12px;
		border-radius: 999px;
		background: var(--panel);
		color: var(--muted);
		font-size: 13px;
		box-shadow: var(--shadow);
		pointer-events: none;
		white-space: nowrap;
	}

	.toolbar {
		position: absolute;
		left: 12px;
		right: 12px;
		bottom: 12px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		pointer-events: none;
	}

	.toolbar > * {
		pointer-events: auto;
		background: var(--panel);
		border-radius: 10px;
		box-shadow: var(--shadow);
		padding: 3px;
	}

	.mode {
		border: 0;
	}

	.mode button {
		padding: 0 10px;
		font-size: 13px;
	}

	.zoom {
		min-width: 56px;
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 640px) {
		.viewport {
			padding: 16px 16px 64px;
		}

		.toolbar {
			left: 8px;
			right: 8px;
			bottom: 8px;
			gap: 4px;
		}

		.mode button {
			padding: 0 6px;
			font-size: 12px;
		}

		.zoom-in,
		.zoom-out,
		.zoom {
			display: none;
		}
	}
</style>
