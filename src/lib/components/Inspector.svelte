<script lang="ts">
	import {
		AlignCenter, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart,
		ArrowDownToLine, ArrowUpToLine, Bold, Contrast, Copy, Italic, RotateCw, Trash2, Underline, Replace, Circle,
		Image, Minus, QrCode, Square, Type, Shapes, Table, TableCellsMerge, TableCellsSplit, ArrowRight, ArrowDown
	} from 'lucide-static';
	import Icon from './Icon.svelte';
	import { editor } from '../stores/editor.svelte';
	import {
		FONTS, cellAt, contentSize, mergeCells, resizeTableGrid, splitCell, tableCells, tableEdges,
		type DesignElement, type TableCell, type TableElement, type TextElement
	} from '../design/model';
	import { iconSvg } from '../design/icons';
	import { DEFAULT_EMOJI_GAMMA } from '../design/render';

	const el = $derived(editor.selected);
	let textArea = $state<HTMLTextAreaElement>();
	/** Only a new request focuses; the field remounting on selection (e.g. a paste) must not. */
	let handledFocus = editor.focusRequest;

	$effect(() => {
		if (editor.focusRequest !== handledFocus && textArea) {
			handledFocus = editor.focusRequest;
			textArea.focus();
			textArea.select();
		}
	});

	const round = (v: number) => Math.round(v * 10) / 10;

	// ---- Tables ----
	let cellArea = $state<HTMLTextAreaElement>();
	let handledCellFocus = editor.cellFocusRequest;

	$effect(() => {
		if (editor.cellFocusRequest !== handledCellFocus && cellArea) {
			handledCellFocus = editor.cellFocusRequest;
			cellArea.focus();
			cellArea.select();
		}
	});

	/** The table cell being edited (its anchor, for merged cells). */
	const cell = $derived.by(() => {
		const t = editor.tableCell;
		if (el?.type !== 'table' || t?.id !== el.id) return null;
		return cellAt(el, t.r, t.c) ?? null;
	});

	function setCell(patch: Partial<TableCell>, record = true) {
		if (el?.type !== 'table' || !cell) return;
		const cells = $state.snapshot(el.cells) as TableCell[][];
		cells[cell.r][cell.c] = { ...cells[cell.r][cell.c], ...patch };
		if (record) set({ cells });
		else live({ cells });
	}

	/** Tab / Shift+Tab move to the next / previous cell, like a spreadsheet. */
	function cellKey(e: KeyboardEvent) {
		if (e.key !== 'Tab' || el?.type !== 'table' || !cell) return;
		const list = tableCells(el);
		const i = list.findIndex((t) => t.r === cell.r && t.c === cell.c);
		const next = list[i + (e.shiftKey ? -1 : 1)];
		if (!next) return;
		e.preventDefault();
		editor.checkpoint();
		editor.tableCell = { id: el.id, r: next.r, c: next.c };
		editor.cellFocusRequest++;
	}

	function setGrid(t: TableElement, rows: number, cols: number) {
		rows = Math.max(1, Math.min(30, Math.round(rows) || 1));
		cols = Math.max(1, Math.min(20, Math.round(cols) || 1));
		if (rows === t.rowHeights.length && cols === t.colWidths.length) return;
		set(resizeTableGrid($state.snapshot(t) as TableElement, rows, cols));
		const sel = editor.tableCell;
		if (sel?.id === t.id && (sel.r >= rows || sel.c >= cols)) editor.tableCell = null;
	}

	/** Column widths / row heights in mm, as the table is drawn. */
	function sizesMm(t: TableElement, axis: 'col' | 'row') {
		const box = contentSize(t);
		const e = axis === 'col' ? tableEdges(t.colWidths, box.w) : tableEdges(t.rowHeights, box.h);
		return e.slice(1).map((v, i) => v - e[i]);
	}

	/** Set one column width / row height in mm; the table grows or shrinks by the difference. */
	function setSizeMm(t: TableElement, axis: 'col' | 'row', i: number, mm: number) {
		const sizes = sizesMm(t, axis);
		sizes[i] = Math.max(1, mm);
		const total = sizes.reduce((a, b) => a + b, 0);
		// w/h are the box on the label; a quarter-turned table has its columns along the label's y.
		const quarter = t.rotation === 90 || t.rotation === 270;
		const alongW = (axis === 'col') !== quarter;
		set({ ...(axis === 'col' ? { colWidths: sizes } : { rowHeights: sizes }), ...(alongW ? { w: total } : { h: total }) });
	}

	function merge(dir: 'right' | 'down') {
		if (el?.type !== 'table' || !cell) return;
		const cells = mergeCells($state.snapshot(el) as TableElement, cell.r, cell.c, dir);
		if (cells) set({ cells });
	}

	function split() {
		if (el?.type !== 'table' || !cell) return;
		const cells = splitCell($state.snapshot(el) as TableElement, cell.r, cell.c);
		if (cells) set({ cells });
	}

	function set(patch: Partial<DesignElement>) {
		if (el) editor.update(el.id, patch);
	}

	function live(patch: Partial<DesignElement>) {
		if (el) editor.update(el.id, patch, false);
	}

	function num(e: Event) {
		const v = parseFloat((e.currentTarget as HTMLInputElement).value);
		return Number.isFinite(v) ? v : 0;
	}

	function rotate() {
		if (!el) return;
		const cx = el.x + el.w / 2;
		const cy = el.y + el.h / 2;
		set({ rotation: ((el.rotation + 90) % 360) as DesignElement['rotation'], w: el.h, h: el.w, x: cx - el.h / 2, y: cy - el.w / 2 });
	}

	function center(axis: 'x' | 'y') {
		if (!el) return;
		if (axis === 'x') set({ x: (editor.view.lengthMm - el.w) / 2 });
		else set({ y: (editor.view.widthMm - el.h) / 2 });
	}

	const typeIcon: Record<DesignElement['type'], string> = { text: Type, icon: Shapes, shape: Square, qr: QrCode, image: Image, table: Table };
	const typeName = (e: DesignElement) =>
		e.type === 'text'
			? e.text.split('\n')[0] || 'Text'
			: e.type === 'icon'
				? e.name
				: e.type === 'shape'
					? e.shape
					: e.type === 'qr'
						? 'QR code'
						: e.type === 'table'
							? `Table ${e.rowHeights.length} × ${e.colWidths.length}`
							: 'Image';
</script>

<section class="inspector">
	{#if !el}
		<h3 class="section-title">Layers</h3>
		{#if editor.elements.length}
			<div class="layers">
				{#each [...editor.elements].reverse() as item (item.id)}
					<button class="layer" onclick={() => (editor.selectedId = item.id)}>
						{#if item.type === 'icon'}{@html iconSvg(item.name, 16, 2)}{:else}<Icon svg={item.type === 'shape' ? (item.shape === 'ellipse' ? Circle : item.shape === 'line' ? Minus : Square) : typeIcon[item.type]} size={16} />{/if}
						<span>{typeName(item)}</span>
					</button>
				{/each}
			</div>
			<button class="btn sm ghost danger" onclick={() => editor.clear()}><Icon svg={Trash2} size={14} /> Clear label</button>
		{:else}
			<p class="muted">Nothing on the label yet. Select an element on the label to edit it here.</p>
		{/if}
	{:else}
		<div class="head">
			<h3 class="section-title">{el.type === 'qr' ? 'QR code' : el.type}</h3>
			<div class="row tight">
				<button class="btn sm icon ghost" title="Rotate 90°" onclick={rotate}><Icon svg={RotateCw} size={15} /></button>
				<button class="btn sm icon ghost" class:active={el.invert} title="White on black" onclick={() => set({ invert: !el.invert })}><Icon svg={Contrast} size={15} /></button>
				<button class="btn sm icon ghost" title="Bring to front" onclick={() => editor.reorder(el.id, 'top')}><Icon svg={ArrowUpToLine} size={15} /></button>
				<button class="btn sm icon ghost" title="Send to back" onclick={() => editor.reorder(el.id, 'bottom')}><Icon svg={ArrowDownToLine} size={15} /></button>
				<button class="btn sm icon ghost" title="Duplicate (⌘D)" onclick={() => editor.duplicate(el.id)}><Icon svg={Copy} size={15} /></button>
				<button class="btn sm icon ghost danger" title="Delete (⌫)" onclick={() => editor.remove(el.id)}><Icon svg={Trash2} size={15} /></button>
			</div>
		</div>

		{#if el.type === 'text'}
			{@const t = el as TextElement}
			<textarea
				class="input"
				rows="3"
				bind:this={textArea}
				value={t.text}
				onfocus={() => editor.checkpoint()}
				oninput={(e) => live({ text: e.currentTarget.value })}
				placeholder="Type label text"
			></textarea>
			<label class="field">
				<span>Font</span>
				<select class="input" value={t.font} onchange={(e) => set({ font: e.currentTarget.value })}>
					{#each FONTS as f (f.family)}<option value={f.family} style:font-family={f.family}>{f.label}</option>{/each}
				</select>
			</label>
			<div class="row">
				<div class="segmented">
					<button class:on={t.bold} onclick={() => set({ bold: !t.bold })} title="Bold"><Icon svg={Bold} size={15} /></button>
					<button class:on={t.italic} onclick={() => set({ italic: !t.italic })} title="Italic"><Icon svg={Italic} size={15} /></button>
					<button class:on={t.underline} onclick={() => set({ underline: !t.underline })} title="Underline"><Icon svg={Underline} size={15} /></button>
				</div>
				<div class="segmented">
					<button class:on={t.align === 'left'} onclick={() => set({ align: 'left' })} title="Align left"><Icon svg={AlignLeft} size={15} /></button>
					<button class:on={t.align === 'center'} onclick={() => set({ align: 'center' })} title="Center"><Icon svg={AlignCenter} size={15} /></button>
					<button class:on={t.align === 'right'} onclick={() => set({ align: 'right' })} title="Align right"><Icon svg={AlignRight} size={15} /></button>
				</div>
				<div class="segmented">
					<button class:on={t.valign === 'top'} onclick={() => set({ valign: 'top' })} title="Top"><Icon svg={AlignVerticalJustifyStart} size={15} /></button>
					<button class:on={t.valign === 'middle'} onclick={() => set({ valign: 'middle' })} title="Middle"><Icon svg={AlignVerticalJustifyCenter} size={15} /></button>
					<button class:on={t.valign === 'bottom'} onclick={() => set({ valign: 'bottom' })} title="Bottom"><Icon svg={AlignVerticalJustifyEnd} size={15} /></button>
				</div>
			</div>
			<div class="grid2">
				<label class="check">
					<input type="checkbox" checked={t.fit} onchange={(e) => set({ fit: e.currentTarget.checked })} />
					Fit text to box
				</label>
				<label class="field inline" class:disabled={t.fit}>
					<span>Size (pt)</span>
					<input class="input" type="number" min="4" max="200" step="0.5" value={t.size} disabled={t.fit} onchange={(e) => set({ size: Math.max(2, num(e)) })} />
				</label>
			</div>
			{#if /\p{Extended_Pictographic}/u.test(t.text)}
				<label class="check">
					<input type="checkbox" checked={t.ditherEmoji !== false} onchange={(e) => set({ ditherEmoji: e.currentTarget.checked })} />
					Dither emoji (keeps their shading)
				</label>
				{#if t.ditherEmoji !== false}
					{@const gamma = t.emojiGamma ?? DEFAULT_EMOJI_GAMMA}
					<label class="field">
						<span>Emoji darkness · {gamma.toFixed(1)}</span>
						<input type="range" min="0.8" max="3" step="0.1" value={gamma} onpointerdown={() => editor.checkpoint()} oninput={(e) => live({ emojiGamma: num(e) })} />
					</label>
					<label class="check">
						<input type="checkbox" checked={t.emojiOutline !== false} onchange={(e) => set({ emojiOutline: e.currentTarget.checked })} />
						Outline emoji
					</label>
				{/if}
			{/if}
			<label class="field">
				<span>Line spacing · {t.lineHeight.toFixed(2)}</span>
				<input type="range" min="0.8" max="2" step="0.05" value={t.lineHeight} onpointerdown={() => editor.checkpoint()} oninput={(e) => live({ lineHeight: num(e) })} />
			</label>
		{:else if el.type === 'icon'}
			<div class="icon-row">
				<div class="icon-preview">{@html iconSvg(el.name, 32, el.strokeWidth)}</div>
				<div class="icon-name">{el.name}</div>
				<button class="btn sm" onclick={() => (editor.iconReplaceTarget = el.id)}><Icon svg={Replace} size={14} /> Change</button>
			</div>
			<label class="field">
				<span>Stroke width · {el.strokeWidth.toFixed(2)}</span>
				<input type="range" min="0.75" max="4" step="0.25" value={el.strokeWidth} onpointerdown={() => editor.checkpoint()} oninput={(e) => live({ strokeWidth: num(e) })} />
			</label>
		{:else if el.type === 'shape'}
			<div class="grid2">
				<label class="field">
					<span>Thickness (mm)</span>
					<input class="input" type="number" min="0.1" max="10" step="0.1" value={round(el.thickness)} onchange={(e) => set({ thickness: Math.max(0.1, num(e)) })} />
				</label>
				{#if el.shape === 'rect'}
					<label class="field">
						<span>Corner radius (mm)</span>
						<input class="input" type="number" min="0" max="50" step="0.5" value={round(el.radius)} onchange={(e) => set({ radius: Math.max(0, num(e)) })} />
					</label>
				{/if}
			</div>
			{#if el.shape !== 'line'}
				<label class="check"><input type="checkbox" checked={el.fill} onchange={(e) => set({ fill: e.currentTarget.checked })} /> Filled</label>
			{/if}
		{:else if el.type === 'qr'}
			<label class="field">
				<span>Content (URL or text)</span>
				<textarea class="input" rows="2" bind:this={textArea} value={el.value} onfocus={() => editor.checkpoint()} oninput={(e) => live({ value: e.currentTarget.value })}></textarea>
			</label>
		{:else if el.type === 'table'}
			{@const t = el as TableElement}
			{#if cell}
				{@const c = t.cells[cell.r][cell.c]}
				<label class="field">
					<span>Cell · row {cell.r + 1}, column {cell.c + 1}{cell.rs > 1 || cell.cs > 1 ? ' (merged)' : ''}</span>
					<textarea
						class="input"
						rows="2"
						bind:this={cellArea}
						value={c.text}
						onfocus={() => editor.checkpoint()}
						oninput={(e) => setCell({ text: e.currentTarget.value }, false)}
						onkeydown={cellKey}
						placeholder="Type cell text (Tab: next cell)"
					></textarea>
				</label>
				<div class="row">
					<div class="segmented">
						<button class:on={c.align === 'left'} onclick={() => setCell({ align: 'left' })} title="Align cell left"><Icon svg={AlignLeft} size={15} /></button>
						<button class:on={c.align === 'center'} onclick={() => setCell({ align: 'center' })} title="Center cell"><Icon svg={AlignCenter} size={15} /></button>
						<button class:on={c.align === 'right'} onclick={() => setCell({ align: 'right' })} title="Align cell right"><Icon svg={AlignRight} size={15} /></button>
					</div>
					<div class="segmented">
						<button onclick={() => merge('right')} disabled={cell.c + cell.cs >= t.colWidths.length} title="Merge with the cell to the right">
							<Icon svg={TableCellsMerge} size={15} /><Icon svg={ArrowRight} size={12} />
						</button>
						<button onclick={() => merge('down')} disabled={cell.r + cell.rs >= t.rowHeights.length} title="Merge with the cell below">
							<Icon svg={TableCellsMerge} size={15} /><Icon svg={ArrowDown} size={12} />
						</button>
						<button onclick={split} disabled={cell.rs === 1 && cell.cs === 1} title="Unmerge"><Icon svg={TableCellsSplit} size={15} /></button>
					</div>
				</div>
			{:else}
				<p class="muted">Click a cell on the label to type in it. Drag the lines between cells to resize them.</p>
			{/if}
			<div class="grid2">
				<label class="field">
					<span>Rows</span>
					<input class="input" type="number" min="1" max="30" step="1" value={t.rowHeights.length} onchange={(e) => setGrid(t, num(e), t.colWidths.length)} />
				</label>
				<label class="field">
					<span>Columns</span>
					<input class="input" type="number" min="1" max="20" step="1" value={t.colWidths.length} onchange={(e) => setGrid(t, t.rowHeights.length, num(e))} />
				</label>
			</div>
			<div class="field">
				<span>Column widths (mm)</span>
				<div class="sizes">
					{#each sizesMm(t, 'col') as v, i (i)}
						<input class="input" type="number" min="1" step="0.5" value={round(v)} onchange={(e) => setSizeMm(t, 'col', i, num(e))} aria-label="Column {i + 1} width" />
					{/each}
				</div>
			</div>
			<div class="field">
				<span>Row heights (mm)</span>
				<div class="sizes">
					{#each sizesMm(t, 'row') as v, i (i)}
						<input class="input" type="number" min="1" step="0.5" value={round(v)} onchange={(e) => setSizeMm(t, 'row', i, num(e))} aria-label="Row {i + 1} height" />
					{/each}
				</div>
			</div>
			<div class="grid2">
				<label class="check">
					<input type="checkbox" checked={t.border} onchange={(e) => set({ border: e.currentTarget.checked })} />
					Borders
				</label>
				<label class="field inline" class:disabled={!t.border}>
					<span>Line (mm)</span>
					<input class="input" type="number" min="0.1" max="3" step="0.05" value={Math.round(t.borderWidth * 100) / 100} disabled={!t.border} onchange={(e) => set({ borderWidth: Math.max(0.1, num(e)) })} />
				</label>
			</div>
			<label class="field">
				<span>Font</span>
				<select class="input" value={t.font} onchange={(e) => set({ font: e.currentTarget.value })}>
					{#each FONTS as f (f.family)}<option value={f.family} style:font-family={f.family}>{f.label}</option>{/each}
				</select>
			</label>
			<div class="row">
				<div class="segmented">
					<button class:on={t.bold} onclick={() => set({ bold: !t.bold })} title="Bold"><Icon svg={Bold} size={15} /></button>
				</div>
				<div class="segmented">
					<button class:on={t.valign === 'top'} onclick={() => set({ valign: 'top' })} title="Top"><Icon svg={AlignVerticalJustifyStart} size={15} /></button>
					<button class:on={t.valign === 'middle'} onclick={() => set({ valign: 'middle' })} title="Middle"><Icon svg={AlignVerticalJustifyCenter} size={15} /></button>
					<button class:on={t.valign === 'bottom'} onclick={() => set({ valign: 'bottom' })} title="Bottom"><Icon svg={AlignVerticalJustifyEnd} size={15} /></button>
				</div>
			</div>
			<div class="grid2">
				<label class="field">
					<span>Size (pt)</span>
					<input class="input" type="number" min="3" max="72" step="0.5" value={t.size} onchange={(e) => set({ size: Math.max(2, num(e)) })} />
				</label>
				<label class="field">
					<span>Cell padding (mm)</span>
					<input class="input" type="number" min="0" max="10" step="0.1" value={round(t.padding)} onchange={(e) => set({ padding: Math.max(0, num(e)) })} />
				</label>
			</div>
		{:else if el.type === 'image'}
			<label class="check"><input type="checkbox" checked={el.dither} onchange={(e) => set({ dither: e.currentTarget.checked })} /> Dither (for photos)</label>
			<label class="check"><input type="checkbox" checked={!!el.colorAsBlack} onchange={(e) => set({ colorAsBlack: e.currentTarget.checked })} /> Colours print as black</label>
			<label class="field">
				<span>Threshold · {el.threshold}</span>
				<input type="range" min="10" max="245" step="1" value={el.threshold} onpointerdown={() => editor.checkpoint()} oninput={(e) => live({ threshold: num(e) })} />
			</label>
		{/if}

		<div class="geom">
			<label class="field"><span>X (mm)</span><input class="input" type="number" step="0.5" value={round(el.x)} onchange={(e) => set({ x: num(e) })} /></label>
			<label class="field"><span>Y (mm)</span><input class="input" type="number" step="0.5" value={round(el.y)} onchange={(e) => set({ y: num(e) })} /></label>
			<label class="field"><span>Width</span><input class="input" type="number" min="1" step="0.5" value={round(el.w)} onchange={(e) => set({ w: Math.max(1, num(e)) })} /></label>
			<label class="field"><span>Height</span><input class="input" type="number" min="1" step="0.5" value={round(el.h)} onchange={(e) => set({ h: Math.max(1, num(e)) })} /></label>
		</div>
		<div class="row">
			<button class="btn sm" onclick={() => center('x')}>Center horizontally</button>
			<button class="btn sm" onclick={() => center('y')}>Center vertically</button>
		</div>
	{/if}
</section>

<style>
	.inspector {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.head .section-title {
		margin: 0;
	}

	.tight {
		gap: 0;
	}

	.row {
		flex-wrap: wrap;
	}

	.segmented button {
		min-width: 30px;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		align-self: end;
		height: 34px;
	}

	.field.disabled {
		opacity: 0.5;
	}

	.sizes {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
		gap: 6px;
	}

	.sizes .input {
		padding: 0 6px;
	}

	.geom {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
	}

	.geom .input {
		padding: 0 6px;
	}

	input[type='range'] {
		width: 100%;
		accent-color: var(--accent);
	}

	.icon-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.icon-preview {
		width: 48px;
		height: 48px;
		display: grid;
		place-items: center;
		border-radius: 10px;
		background: var(--panel-2);
		border: 1px solid var(--line);
	}

	.icon-name {
		flex: 1;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.layers {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 220px;
		overflow: auto;
	}

	.layer {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		text-align: left;
		color: var(--text);
	}

	.layer:hover {
		background: var(--panel-2);
	}

	.layer span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.danger:hover:not(:disabled) {
		color: var(--err);
	}

	.muted {
		color: var(--muted);
		margin: 0;
		font-size: 13px;
	}
</style>
