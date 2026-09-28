<script lang="ts">
	import { Check, ChevronDown, ScanLine, Search, X } from 'lucide-static';
	import Icon from './Icon.svelte';
	import { editor } from '../stores/editor.svelte';
	import { printer } from '../stores/printer.svelte';
	import { customLabel, labelShape, labelTitle, loadCatalog, PAPER_TYPES } from '../catalog';
	import type { Family, LabelSpec } from '../printer/types';
	import { FAMILY_NAMES } from '../printer/devices';

	let dialog: HTMLDialogElement;
	let catalog = $state<LabelSpec[]>([]);
	let query = $state('');
	let customW = $state(40);
	let customH = $state(30);
	let showManual = $state(false);

	const family = $derived(printer.family);

	$effect(() => {
		const f = family;
		loadCatalog(f).then((c) => {
			if (family !== f) return;
			catalog = c;
			// A catalog label from another family doesn't apply; start from this family's first label.
			const cur = editor.label;
			if (!cur.id.startsWith('custom') && !c.some((l) => l.id === cur.id) && c.length) editor.setLabel(c[0], editor.labelAuto);
		});
	});

	/** The catalog entry matching the label the printer reports, if any. */
	const detected = $derived.by(() => {
		const m = printer.media;
		if (!m?.labelId) return null;
		const hit = catalog.find((l) => l.id === String(m.labelId));
		// Like MatCtrlFunc.waitForIdentifyMat (T50/T80 only), the chip's paper type and gap replace
		// the catalog's for printing. The catalog value stays in extra.PaperType for display.
		if (hit && family === 't5080') return { ...hit, paperType: m.paperType ?? hit.paperType, gap: m.gap ?? hit.gap };
		if (hit) return hit;
		if (m.widthMm && m.lengthMm) return { ...customLabel(m.lengthMm, m.widthMm, family, m.paperType ?? 1, m.gap ?? 3), name: `Label ${m.labelId}` };
		return null;
	});

	// Follow the printer's label while auto mode is on.
	$effect(() => {
		const d = detected;
		const cur = editor.label;
		const differs = d && (d.id !== cur.id || d.lengthMm !== cur.lengthMm || d.widthMm !== cur.widthMm || d.paperType !== cur.paperType || d.gap !== cur.gap);
		if (d && editor.labelAuto && differs) {
			editor.setLabel($state.snapshot(d) as LabelSpec, true);
		}
	});

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase().replace(/[x×*]/g, ' ');
		const words = q.split(/\s+/).filter(Boolean);
		const list = catalog.filter((l) => {
			if (!words.length) return true;
			const hay = `${l.name} ${l.id} ${l.text ?? ''} ${l.lengthMm} ${l.widthMm} ${l.lengthMm}x${l.widthMm} ${typeName(l)}`.toLowerCase();
			return words.every((w) => hay.includes(w));
		});
		return list.sort((a, b) => a.lengthMm - b.lengthMm || a.widthMm - b.widthMm || a.name.localeCompare(b.name));
	});

	function choose(label: LabelSpec) {
		editor.setLabel($state.snapshot(label) as LabelSpec, detected?.id === label.id);
		dialog.close();
	}

	function useCustom() {
		const w = Math.max(5, Math.min(200, Math.round(customW)));
		const h = Math.max(5, Math.min(200, Math.round(customH)));
		editor.setLabel(customLabel(w, h, family), false);
		dialog.close();
	}

	/** Paper type name from the catalog entry (chip codes differ from catalog codes). */
	function typeName(l: LabelSpec) {
		const t = Number(l.extra?.PaperType ?? l.paperType);
		return PAPER_TYPES[t] ?? 'Label';
	}

	/** Fit a label outline into a `box` px square, keeping its aspect ratio. */
	function swatch(l: LabelSpec, box: number) {
		const k = box / Math.max(l.lengthMm, l.widthMm);
		return `width:${Math.max(4, l.lengthMm * k)}px;height:${Math.max(4, l.widthMm * k)}px`;
	}

	function open() {
		query = '';
		customW = editor.label.lengthMm;
		customH = editor.label.widthMm;
		dialog.showModal();
	}
</script>

{#if printer.connected}
	<div class="current">
		<div class="swatch-box">
			<div class="swatch" class:rounded={labelShape(editor.label) === 'rounded'} class:round={labelShape(editor.label) === 'round'} style={swatch(editor.label, 36)}></div>
		</div>
		<div class="info">
			<div class="title">{labelTitle(editor.label)}</div>
			<div class="sub">
				{typeName(editor.label)}{editor.label.gap ? ` · ${editor.label.gap} mm gap` : ''}
				{#if detected && detected.id === editor.label.id}
					<span class="pill ok tiny"><Icon svg={ScanLine} size={12} /> In printer</span>
				{/if}
			</div>
		</div>
		<button class="btn sm" onclick={open}>Change</button>
	</div>
	{#if detected && detected.id !== editor.label.id}
		<button class="detected" onclick={() => editor.setLabel($state.snapshot(detected) as LabelSpec, true)}>
			<Icon svg={ScanLine} size={14} /> Printer has <b>{labelTitle(detected)}</b> loaded. Use it
		</button>
	{/if}
{:else}
	<!-- Before connecting the label is only a starting point (connecting detects it), so it stays folded. -->
	<button class="summary" onclick={() => (showManual = !showManual)} aria-expanded={showManual} title={labelTitle(editor.label)}>
		<span class="summary-text">Label: <b>{editor.label.lengthMm} × {editor.label.widthMm} mm</b> · auto-detected on connect</span>
		<span class="chev" class:open={showManual}><Icon svg={ChevronDown} size={13} /></span>
	</button>
	{#if showManual}
		<div class="manual">
			<label class="field">
				<span>Printer type</span>
				<select class="input" value={printer.family} onchange={(e) => printer.setPreferredFamily(e.currentTarget.value as Family)}>
					{#each Object.entries(FAMILY_NAMES) as [value, name] (value)}<option {value}>{name}</option>{/each}
				</select>
			</label>
			<button class="btn sm" onclick={open}>Choose label size…</button>
		</div>
	{/if}
{/if}

<dialog bind:this={dialog} onclick={(e) => e.target === dialog && dialog.close()}>
	<div class="dlg">
		<div class="dlg-head">
			<h2>Choose label</h2>
			<button class="btn sm icon ghost" onclick={() => dialog.close()} aria-label="Close"><Icon svg={X} size={16} /></button>
		</div>
		<div class="custom">
			<span class="label-sm">Custom size</span>
			<input class="input" type="number" min="5" max="200" bind:value={customW} aria-label="Width in mm" />
			<span>×</span>
			<input class="input" type="number" min="5" max="200" bind:value={customH} aria-label="Height in mm" />
			<span class="label-sm">mm</span>
			<button class="btn sm" onclick={useCustom}>Use</button>
		</div>
		<div class="search">
			<Icon svg={Search} size={15} />
			<!-- svelte-ignore a11y_autofocus -->
			<input bind:value={query} autofocus placeholder="Search {catalog.length} labels by size or code, e.g. 40x30" aria-label="Search labels" />
		</div>
		<div class="list">
			{#each filtered as l (l.id)}
				<button class="item" class:on={l.id === editor.label.id} onclick={() => choose(l)}>
					<span class="mini-box"><span class="mini" class:rounded={labelShape(l) === 'rounded'} class:round={labelShape(l) === 'round'} style={swatch(l, 22)}></span></span>
					<span class="size">{l.lengthMm} × {l.widthMm}</span>
					<span class="code">{l.name}</span>
					<span class="type">{typeName(l)}</span>
					{#if detected?.id === l.id}<span class="pill ok tiny">In printer</span>{/if}
					{#if l.id === editor.label.id}<Icon svg={Check} size={15} />{/if}
				</button>
			{:else}
				<p class="none">No labels match.</p>
			{/each}
		</div>
	</div>
</dialog>

<style>
	.summary {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		max-width: 100%;
		border: 0;
		background: none;
		padding: 2px 0;
		font-size: 12px;
		color: var(--muted);
		text-align: left;
	}

	.summary:hover {
		color: var(--text);
	}

	.summary-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.summary-text b {
		font-weight: 600;
		color: var(--text);
	}

	.chev {
		display: inline-flex;
		color: var(--muted);
		transition: transform 0.15s;
	}

	.chev.open {
		transform: rotate(180deg);
	}

	.manual {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 8px;
	}

	.manual .btn {
		align-self: flex-start;
	}

	.current {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.swatch-box {
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		flex: none;
	}

	.swatch {
		border: 1.5px solid var(--line-strong);
		background: var(--paper);
		border-radius: 3px;
		flex: none;
	}

	.rounded {
		border-radius: 6px !important;
	}

	.round {
		border-radius: 50% !important;
	}

	.info {
		flex: 1;
		min-width: 0;
	}

	.title {
		font-weight: 600;
	}

	.sub {
		font-size: 12px;
		color: var(--muted);
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.tiny {
		height: 20px;
		padding: 0 7px;
		font-size: 11px;
	}

	.detected {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid transparent;
		background: var(--ok-soft);
		color: var(--ok);
		font-size: 13px;
		text-align: left;
	}

	dialog {
		width: min(560px, calc(100vw - 32px));
		max-height: min(720px, calc(100vh - 48px));
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--panel);
		color: var(--text);
		box-shadow: 0 24px 64px rgb(0 0 0 / 0.25);
	}

	dialog::backdrop {
		background: rgb(20 18 14 / 0.35);
	}

	.dlg {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		max-height: min(720px, calc(100vh - 48px));
	}

	.dlg-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	h2 {
		margin: 0;
		font-size: 16px;
	}

	.custom {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.custom .input {
		width: 72px;
	}

	.custom .label-sm:first-child {
		margin-right: auto;
	}

	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 36px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: 8px;
		color: var(--muted);
	}

	.search:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}

	.search input {
		flex: 1;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text);
	}

	.list {
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: 200px;
	}

	.item {
		display: grid;
		grid-template-columns: 28px 90px 1fr auto auto auto;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		text-align: left;
		color: var(--text);
	}

	.item:hover {
		background: var(--panel-2);
	}

	.item.on {
		background: var(--accent-soft);
	}

	.mini-box {
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
	}

	.mini {
		border: 1.5px solid var(--line-strong);
		border-radius: 2px;
		background: var(--paper);
		display: block;
	}

	.size {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.code,
	.type {
		color: var(--muted);
		font-size: 13px;
	}

	.none {
		color: var(--muted);
		text-align: center;
	}

	@media (max-width: 520px) {
		.item {
			grid-template-columns: 28px 80px 1fr auto;
		}
		.type {
			display: none;
		}
	}
</style>
