<script lang="ts">
	import {
		BatteryCharging, Bluetooth, CircleAlert, CircleCheck, LayoutDashboard, Plug, Printer, RectangleHorizontal,
		RectangleVertical, Square, Tag, TriangleAlert, Unplug, Usb, X, PencilRuler
	} from 'lucide-static';
	import Icon from './Icon.svelte';
	import IconPicker from './IconPicker.svelte';
	import LabelPicker from './LabelPicker.svelte';
	import ConnectHelp from './ConnectHelp.svelte';
	import { printer } from '../stores/printer.svelte';
	import { editor } from '../stores/editor.svelte';
	import { mode } from '../stores/mode.svelte';
	import { quick, saveQuick } from '../stores/quick.svelte';
	import { buildQuickDesign, quickRotated } from '../design/quick';
	import { bitmapToCanvas, renderBitmap } from '../design/render';
	import { iconSvg, iconsLoaded, loadIcons } from '../design/icons';
	import { labelShape, labelTitle } from '../catalog';
	import { FONTS, type DesignElement } from '../design/model';
	import type { LabelSpec } from '../printer/types';

	let canvas: HTMLCanvasElement;
	let previewWidth = $state(320);
	let headerH = $state(56);
	let viewH = $state(800);
	/** The preview has scrolled up and is locked under the header. */
	let stuck = $state(false);
	let sentinel: HTMLDivElement;
	/** Keep the locked preview compact enough to leave room for the controls below it. */
	const maxPreviewH = $derived(Math.max(120, Math.min(260, viewH * 0.28)));

	$effect(() => {
		const io = new IntersectionObserver(([e]) => (stuck = !e.isIntersecting), { rootMargin: `-${headerH + 1}px 0px 0px 0px` });
		io.observe(sentinel);
		return () => io.disconnect();
	});
	let showIcons = $state(false);
	let rendering = $state(false);
	let printed = $state(false);
	let printedTimer: ReturnType<typeof setTimeout>;

	const label = $derived(editor.label);
	const rotated = $derived(quickRotated(quick, label));
	const elements = $derived(buildQuickDesign($state.snapshot(quick), $state.snapshot(editor.label) as LabelSpec));
	const hasContent = $derived(!!quick.text.trim() || !!quick.icon);
	const errors = $derived(printer.status?.errors ?? []);
	const warnings = $derived(printer.status?.warnings ?? []);
	const shape = $derived(labelShape(label));

	$effect(() => {
		void $state.snapshot(quick);
		saveQuick();
	});

	/** Icon data is lazy-loaded; re-render the chosen icon once it's there. */
	let iconsReady = $state(iconsLoaded());
	$effect(() => {
		if (quick.icon && !iconsReady) void loadIcons().then(() => (iconsReady = true));
	});

	// Live preview: the exact dots, shown the right way up for reading.
	let token = 0;
	$effect(() => {
		const els = $state.snapshot(elements) as DesignElement[];
		const l = $state.snapshot(editor.label) as LabelSpec;
		const turn = rotated;
		const size = printer.canvasSize(l);
		const dpmm = printer.dpmm;
		const box = Math.max(100, previewWidth - 32);
		const maxH = maxPreviewH;
		const my = ++token;
		void (async () => {
			const bmp = await renderBitmap({ elements: els }, l.lengthMm, l.widthMm, size.width, size.height, dpmm);
			if (my !== token || !canvas) return;
			const src = document.createElement('canvas');
			bitmapToCanvas(bmp, src);
			const dw = turn ? src.height : src.width;
			const dh = turn ? src.width : src.height;
			canvas.width = dw;
			canvas.height = dh;
			const ctx = canvas.getContext('2d')!;
			ctx.imageSmoothingEnabled = false;
			ctx.save();
			if (turn) {
				// The label is printed turned; rotate back 90 degrees counter-clockwise for reading.
				ctx.translate(0, src.width);
				ctx.rotate(-Math.PI / 2);
			}
			ctx.drawImage(src, 0, 0);
			ctx.restore();
			const scale = Math.min(box / dw, maxH / dh);
			canvas.style.width = `${Math.round(dw * scale)}px`;
			canvas.style.height = `${Math.round(dh * scale)}px`;
		})();
	});

	async function print() {
		printed = false;
		rendering = true;
		try {
			const l = $state.snapshot(editor.label) as LabelSpec;
			const size = printer.canvasSize(l);
			const bmp = await renderBitmap({ elements: $state.snapshot(elements) as DesignElement[] }, l.lengthMm, l.widthMm, size.width, size.height, printer.dpmm);
			rendering = false;
			await printer.print([bmp], l, { density: editor.density, copies: 1 });
			printed = true;
			clearTimeout(printedTimer);
			printedTimer = setTimeout(() => (printed = false), 4000);
		} catch (e) {
			console.error(e);
		} finally {
			rendering = false;
		}
	}

	/** Continue editing this label in the full studio. */
	function openInStudio() {
		editor.checkpoint();
		editor.elements = $state.snapshot(elements) as DesignElement[];
		editor.selectedId = null;
		editor.persist();
		mode.choose('studio');
	}

	function connect() {
		if (printer.bluetoothSupported) printer.connectBluetooth();
		else printer.connect();
	}

	const phase: Record<string, string> = {
		preparing: 'Preparing…',
		checking: 'Checking printer…',
		sending: 'Sending…',
		printing: 'Printing…',
		finishing: 'Finishing…',
		done: 'Done'
	};
</script>

<svelte:window bind:innerHeight={viewH} />

<div class="quick">
	<header bind:offsetHeight={headerH}>
		<div class="brand">
			<div class="logo"><Icon svg={Tag} size={16} /></div>
			<b>Quick label</b>
		</div>
		<button class="btn sm ghost" onclick={() => mode.choose('studio')}><Icon svg={LayoutDashboard} size={15} /> Full studio</button>
	</header>

	<main>
		<!-- 0. Printer -->
		<section class="card printer">
			{#if printer.connected && printer.model}
				<div class="row between">
					<span class="pill ok"><span class="dot"></span> {printer.model.name}</span>
					<div class="row">
						{#if printer.status?.charging}
							<span class="pill"><Icon svg={BatteryCharging} size={13} /> Charging</span>
						{:else if printer.status?.batteryLevel !== undefined}
							<span class="pill">{Math.round((printer.status.batteryLevel / 4) * 100)}%</span>
						{/if}
						<button class="btn sm icon ghost" onclick={() => printer.disconnect()} aria-label="Disconnect"><Icon svg={Unplug} size={15} /></button>
					</div>
				</div>
			{:else if printer.state === 'connecting'}
				<div class="connecting">Connecting…</div>
			{:else if printer.supported || printer.bluetoothSupported}
				<div class="connect-buttons">
					{#if printer.supported && printer.bluetoothSupported}
						<button class="btn primary big" onclick={() => printer.connect()}><Icon svg={Usb} size={18} /> USB</button>
						<button class="btn primary big" onclick={() => printer.connectBluetooth()}><Icon svg={Bluetooth} size={18} /> Bluetooth</button>
					{:else}
						<button class="btn primary big wide" onclick={connect}>
							<Icon svg={printer.bluetoothSupported ? Bluetooth : Plug} size={18} /> Connect printer
						</button>
					{/if}
				</div>
			{:else}
				<ConnectHelp />
			{/if}
			{#if printer.error && !printer.connected}
				<div class="note err">
					<Icon svg={CircleAlert} size={15} />
					<span>{printer.error}</span>
					<button class="btn sm icon ghost" onclick={() => printer.setError(null)} aria-label="Dismiss"><Icon svg={X} size={14} /></button>
				</div>
			{/if}
			<div class="label-line"><LabelPicker /></div>
		</section>

		<!-- 6. Preview: locks under the header once scrolled to, so it stays visible while editing. -->
		<div class="sentinel" bind:this={sentinel}></div>
		<section class="preview" class:stuck style:top="{headerH}px" bind:clientWidth={previewWidth}>
			<div class="paper" class:rounded={shape === 'rounded'} class:round={shape === 'round'}>
				<canvas bind:this={canvas}></canvas>
				{#if !hasContent}<div class="empty">Your label appears here</div>{/if}
			</div>
			<div class="caption">
				{labelTitle(label)}{rotated ? ' · printed turned to fit the label' : ''}
			</div>
		</section>

		<!-- 1. Text -->
		<section class="card">
			<label class="field">
				<span>Text</span>
				<textarea class="input" rows="2" bind:value={quick.text} placeholder="What should the label say?"></textarea>
			</label>
		</section>

		<!-- 2. Icon -->
		<section class="card">
			<div class="row between">
				<span class="label-sm">Icon (above the text)</span>
				{#if quick.icon}
					<button class="btn sm ghost" onclick={() => (quick.icon = null)}><Icon svg={X} size={13} /> Remove</button>
				{/if}
			</div>
			{#if quick.icon}
				<button class="chosen" onclick={() => (showIcons = !showIcons)}>
					<span class="chosen-icon">{@html iconsReady ? iconSvg(quick.icon, 26, 2) : ''}</span>
					<span class="chosen-name">{quick.icon}</span>
					<span class="change">{showIcons ? 'Done' : 'Change'}</span>
				</button>
			{:else if !showIcons}
				<button class="btn wide" onclick={() => (showIcons = true)}>Add an icon</button>
			{/if}
			{#if showIcons}
				<div class="picker">
					<IconPicker
						onpick={(name) => {
							quick.icon = name;
							showIcons = false;
						}}
					/>
				</div>
			{/if}
		</section>

		<!-- 3. Font -->
		<section class="card">
			<span class="label-sm">Font</span>
			<div class="fonts">
				{#each FONTS as f (f.family)}
					<button class="font" class:on={quick.font === f.family} style:font-family={`"${f.family}"`} onclick={() => (quick.font = f.family)}>
						{f.label.replace(' (system)', '')}
					</button>
				{/each}
			</div>
		</section>

		<!-- 4 + 5. Orientation and frame -->
		<section class="card options">
			<div class="field">
				<span class="label-sm">Direction</span>
				<div class="segmented">
					<button class:on={quick.orientation === 'horizontal'} onclick={() => (quick.orientation = 'horizontal')}>
						<Icon svg={RectangleHorizontal} size={16} /> Horizontal
					</button>
					<button class:on={quick.orientation === 'vertical'} onclick={() => (quick.orientation = 'vertical')}>
						<Icon svg={RectangleVertical} size={16} /> Vertical
					</button>
				</div>
			</div>
			<label class="toggle">
				<input type="checkbox" bind:checked={quick.frame} />
				<span class="switch" aria-hidden="true"></span>
				<Icon svg={Square} size={16} /> Frame
			</label>
		</section>

		<button class="btn ghost sm studio-link" onclick={openInStudio} disabled={!hasContent}>
			<Icon svg={PencilRuler} size={14} /> Fine-tune this label in Full studio
		</button>
	</main>

	<!-- 7. Print -->
	<footer>
		{#each errors as msg (msg)}<div class="note err"><Icon svg={CircleAlert} size={15} /> {msg}</div>{/each}
		{#each warnings as msg (msg)}<div class="note warn"><Icon svg={TriangleAlert} size={15} /> {msg}</div>{/each}
		{#if printer.error && printer.connected}<div class="note err"><Icon svg={CircleAlert} size={15} /> {printer.error}</div>{/if}
		{#if printer.state === 'printing'}
			<button class="btn big print" onclick={() => printer.cancel()}>
				<span class="spinner"></span>
				{phase[printer.progress?.phase ?? 'preparing']} <span class="cancel">Cancel</span>
			</button>
		{:else if printed}
			<div class="btn big print done"><Icon svg={CircleCheck} size={18} /> Printed</div>
		{:else}
			<button
				class="btn primary big print"
				onclick={printer.connected ? print : connect}
				disabled={(printer.connected && (!hasContent || rendering || errors.length > 0)) || (!printer.connected && !printer.supported && !printer.bluetoothSupported)}
			>
				<Icon svg={printer.connected ? Printer : Plug} size={18} />
				{printer.connected ? 'Print label' : 'Connect printer to print'}
			</button>
		{/if}
	</footer>
</div>

<style>
	.quick {
		min-height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--bg);
	}

	header {
		position: sticky;
		top: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		background: var(--panel);
		border-bottom: 1px solid var(--line);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.logo {
		width: 28px;
		height: 28px;
		border-radius: 8px;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: var(--accent-ink);
	}

	main {
		flex: 1;
		width: 100%;
		max-width: 560px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px 16px 24px;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		border-radius: 14px;
		background: var(--panel);
		border: 1px solid var(--line);
	}

	.row.between {
		justify-content: space-between;
	}

	.connect-buttons {
		display: flex;
		gap: 8px;
	}

	.connect-buttons .btn {
		flex: 1;
	}

	.big {
		height: 48px;
		font-size: 16px;
		font-weight: 600;
		border-radius: 12px;
	}

	.wide {
		width: 100%;
	}

	.connecting {
		text-align: center;
		color: var(--muted);
		padding: 12px 0;
	}

	.label-line {
		padding-top: 10px;
		border-top: 1px solid var(--line);
	}

	.sentinel {
		height: 1px;
		margin-bottom: -13px;
	}

	.preview {
		position: sticky;
		z-index: 4;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		margin: 0 -16px;
		padding: 10px 16px 8px;
		background: var(--bg);
		transition: box-shadow 0.15s;
	}

	.preview.stuck {
		box-shadow: 0 10px 14px -12px rgb(0 0 0 / 0.35);
		border-bottom: 1px solid var(--line);
	}

	.paper {
		position: relative;
		background: var(--paper);
		border-radius: 4px;
		box-shadow:
			0 0 0 1px rgb(0 0 0 / 0.08),
			0 8px 24px rgb(0 0 0 / 0.12);
		overflow: hidden;
		line-height: 0;
	}

	.paper.rounded {
		border-radius: 12px;
	}

	.paper.round {
		border-radius: 50%;
	}

	canvas {
		display: block;
		image-rendering: pixelated;
	}

	.empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		line-height: 1.4;
		color: #9d998f;
		font-size: 14px;
		text-align: center;
		padding: 12px;
	}

	.caption {
		font-size: 12px;
		color: var(--muted);
		text-align: center;
	}

	textarea.input {
		font-size: 17px;
		min-height: 72px;
	}

	.chosen {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: var(--panel-2);
		color: var(--text);
		text-align: left;
	}

	.chosen-icon {
		display: inline-flex;
	}

	.chosen-name {
		flex: 1;
		font-weight: 500;
	}

	.change {
		font-size: 13px;
		color: var(--accent);
	}

	.picker {
		display: flex;
		flex-direction: column;
		max-height: 300px;
	}

	.fonts {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		padding-bottom: 2px;
		scrollbar-width: none;
	}

	.font {
		flex: none;
		height: 40px;
		padding: 0 14px;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: var(--panel);
		color: var(--text);
		font-size: 16px;
		white-space: nowrap;
	}

	.font.on {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}

	.options {
		flex-direction: row;
		align-items: flex-end;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.options .field {
		flex: 1;
		min-width: 220px;
	}

	.segmented button {
		height: 36px;
		font-size: 14px;
		gap: 6px;
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		font-weight: 500;
		cursor: pointer;
		user-select: none;
	}

	.toggle input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.switch {
		width: 40px;
		height: 24px;
		border-radius: 999px;
		background: var(--line-strong);
		position: relative;
		transition: background 0.15s;
	}

	.switch::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #fff;
		transition: transform 0.15s;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
	}

	.toggle input:checked + .switch {
		background: var(--accent);
	}

	.toggle input:checked + .switch::after {
		transform: translateX(16px);
	}

	.toggle input:focus-visible + .switch {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.studio-link {
		align-self: center;
		color: var(--muted);
	}

	footer {
		position: sticky;
		bottom: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
		max-width: 560px;
		margin: 0 auto;
		padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
		background: linear-gradient(to top, var(--bg) 70%, transparent);
	}

	.print {
		width: 100%;
	}

	.print.done {
		background: var(--ok-soft);
		border-color: transparent;
		color: var(--ok);
	}

	.cancel {
		margin-left: 8px;
		font-weight: 500;
		opacity: 0.7;
		text-decoration: underline;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid currentColor;
		border-right-color: transparent;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.note {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-radius: 10px;
		font-size: 13px;
	}

	.note span {
		flex: 1;
	}

	.note.err {
		background: var(--err-soft);
		color: var(--err);
	}

	.note.warn {
		background: var(--warn-soft);
		color: var(--warn);
	}

	.note .btn {
		color: inherit;
	}
</style>
