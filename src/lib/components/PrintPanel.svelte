<script lang="ts">
	import { CircleAlert, CircleCheck, Download, Minus, Plug, Plus, Printer, TriangleAlert, X } from 'lucide-static';
	import Icon from './Icon.svelte';
	import LabelPicker from './LabelPicker.svelte';
	import { editor } from '../stores/editor.svelte';
	import { printer } from '../stores/printer.svelte';
	import { renderBitmap, bitmapToCanvas } from '../design/render';
	import { familyOptions } from '../printer/options';
	import type { DesignElement } from '../design/model';
	import type { LabelSpec } from '../printer/types';

	let rendering = $state(false);
	let done = $state(false);
	let doneTimer: ReturnType<typeof setTimeout>;

	const opts = $derived(familyOptions(printer.family, editor.label));
	const phaseText: Record<string, string> = {
		preparing: 'Preparing',
		checking: 'Checking printer',
		sending: 'Sending',
		printing: 'Printing',
		finishing: 'Finishing',
		done: 'Done'
	};

	$effect(() => {
		const d = opts.density;
		if (d && (editor.density < d.min || editor.density > d.max)) editor.density = d.default;
		const cuts = opts.cutTypes;
		if (cuts && !cuts.some((c) => c.value === editor.cutType)) editor.cutType = cuts[0].value;
	});

	async function render() {
		const label = $state.snapshot(editor.label) as LabelSpec;
		const size = printer.canvasSize(label);
		const design = { elements: $state.snapshot(editor.elements) as DesignElement[] };
		return { label, bmp: await renderBitmap(design, label.lengthMm, label.widthMm, size.width, size.height, printer.dpmm) };
	}

	async function print() {
		done = false;
		rendering = true;
		try {
			const { label, bmp } = await render();
			rendering = false;
			await printer.print([bmp], label, {
				density: opts.density ? editor.density : 4,
				copies: editor.copies,
				cutType: opts.cutTypes ? editor.cutType : undefined
			});
			done = true;
			clearTimeout(doneTimer);
			doneTimer = setTimeout(() => (done = false), 4000);
		} catch (e) {
			console.error(e);
		} finally {
			rendering = false;
		}
	}

	async function downloadPng() {
		const { label, bmp } = await render();
		const c = document.createElement('canvas');
		bitmapToCanvas(bmp, c, [0, 0, 0]);
		const a = document.createElement('a');
		a.href = c.toDataURL('image/png');
		a.download = `label-${label.lengthMm}x${label.widthMm}mm.png`;
		a.click();
	}

	const pct = $derived(printer.progress ? Math.round((Math.max(0, printer.progress.page - 0.5) / Math.max(1, printer.progress.pages)) * 100) : 0);
	const errors = $derived(printer.status?.errors ?? []);
	const warnings = $derived(printer.status?.warnings ?? []);
</script>

<section class="block">
	<h3 class="section-title">Label</h3>
	<LabelPicker />
</section>

<section class="block">
	<h3 class="section-title">Print</h3>
	{#if opts.density}
		{@const range = opts.density}
		<div class="field">
			<span>Darkness · {editor.density}</span>
			<div class="density">
				{#each Array.from({ length: range.max - range.min + 1 }, (_, i) => i + range.min) as d}
					<button class:on={editor.density === d} onclick={() => (editor.density = d)} title="Darkness {d}">{d}</button>
				{/each}
			</div>
		</div>
	{/if}
	{#if opts.cutTypes}
		<label class="field">
			<span>Cut</span>
			<select class="input" value={editor.cutType} onchange={(e) => (editor.cutType = Number(e.currentTarget.value))}>
				{#each opts.cutTypes as c}<option value={c.value}>{c.label}</option>{/each}
			</select>
		</label>
	{/if}
	<div class="field">
		<span>Copies</span>
		<div class="copies">
			<button class="btn sm icon" onclick={() => (editor.copies = Math.max(1, editor.copies - 1))} disabled={editor.copies <= 1} aria-label="Fewer copies"><Icon svg={Minus} size={14} /></button>
			<input class="input" type="number" min="1" max="999" bind:value={editor.copies} onchange={() => (editor.copies = Math.max(1, Math.min(999, Math.round(editor.copies || 1))))} aria-label="Copies" />
			<button class="btn sm icon" onclick={() => (editor.copies = Math.min(999, editor.copies + 1))} aria-label="More copies"><Icon svg={Plus} size={14} /></button>
		</div>
	</div>

	{#each errors as msg}
		<div class="note err"><Icon svg={CircleAlert} size={15} /> {msg}</div>
	{/each}
	{#each warnings as msg}
		<div class="note warn"><Icon svg={TriangleAlert} size={15} /> {msg}</div>
	{/each}
	{#if printer.error && printer.connected}
		<div class="note err"><Icon svg={CircleAlert} size={15} /> {printer.error}</div>
	{/if}

	{#if printer.state === 'printing'}
		<div class="progress">
			<div class="progress-top">
				<span>{phaseText[printer.progress?.phase ?? 'preparing']}{printer.progress && printer.progress.pages > 1 ? ` · ${printer.progress.page}/${printer.progress.pages}` : ''}…</span>
				<button class="btn sm ghost" onclick={() => printer.cancel()}><Icon svg={X} size={14} /> Cancel</button>
			</div>
			<div class="bar"><div style:width="{pct}%"></div></div>
		</div>
	{:else if done}
		<div class="note ok"><Icon svg={CircleCheck} size={15} /> Sent to printer</div>
	{/if}

	{#if printer.connected}
		<button class="btn primary big" onclick={print} disabled={printer.state === 'printing' || rendering || errors.length > 0}>
			<Icon svg={Printer} size={18} />
			{editor.copies > 1 ? `Print ${editor.copies} labels` : 'Print label'}
		</button>
	{:else}
		<button class="btn primary big" onclick={() => printer.connect()} disabled={!printer.supported}>
			<Icon svg={Plug} size={18} /> Connect printer to print
		</button>
	{/if}
	<button class="btn ghost sm" onclick={downloadPng}><Icon svg={Download} size={14} /> Download as PNG</button>
</section>

<style>
	.block {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.block .section-title {
		margin: 0;
	}

	.density {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(24px, 1fr));
		gap: 3px;
	}

	.density button {
		height: 30px;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--panel);
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}

	.density button:hover {
		border-color: var(--line-strong);
	}

	.density button.on {
		background: var(--text);
		border-color: var(--text);
		color: var(--panel);
	}

	.copies {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.copies .input {
		width: 72px;
		text-align: center;
		height: 28px;
	}

	.big {
		height: 44px;
		font-size: 15px;
		font-weight: 600;
		border-radius: 10px;
	}

	.note {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-radius: 8px;
		font-size: 13px;
	}

	.note.err {
		background: var(--err-soft);
		color: var(--err);
	}

	.note.warn {
		background: var(--warn-soft);
		color: var(--warn);
	}

	.note.ok {
		background: var(--ok-soft);
		color: var(--ok);
	}

	.progress {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 13px;
	}

	.progress-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.bar {
		height: 6px;
		border-radius: 3px;
		background: var(--panel-2);
		overflow: hidden;
	}

	.bar div {
		height: 100%;
		background: var(--accent);
		transition: width 0.3s;
	}
</style>
