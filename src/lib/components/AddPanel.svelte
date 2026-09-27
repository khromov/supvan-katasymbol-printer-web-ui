<script lang="ts">
	import { Circle, Image, Minus, QrCode, Square, Type } from 'lucide-static';
	import Icon from './Icon.svelte';
	import IconPicker from './IconPicker.svelte';
	import { editor } from '../stores/editor.svelte';
	import { makeIcon, makeImage, makeQr, makeShape, makeText, placeFree, type DesignElement } from '../design/model';

	let picker = $state<IconPicker>();
	let fileInput: HTMLInputElement;

	const W = $derived(editor.label.lengthMm);
	const H = $derived(editor.label.widthMm);

	/** Add an element in the least crowded spot of the label's safe area. */
	function addFree(el: DesignElement, focus = false) {
		const p = editor.label.padding;
		const area = { x: p.left, y: p.top, w: W - p.left - p.right, h: H - p.top - p.bottom };
		const others = editor.elements.filter((e) => !(e.type === 'shape' && e.shape !== 'line' && !e.fill));
		editor.add(placeFree(el, others, area), focus);
	}

	const replacing = $derived.by(() => {
		const el = editor.elements.find((e) => e.id === editor.iconReplaceTarget);
		return el?.type === 'icon' ? el.name : null;
	});

	$effect(() => {
		if (editor.iconReplaceTarget) picker?.focus();
	});

	function pickIcon(name: string) {
		const target = editor.iconReplaceTarget;
		if (target && editor.elements.some((e) => e.id === target)) {
			editor.update(target, { name });
			editor.selectedId = target;
			editor.iconReplaceTarget = null;
			return;
		}
		editor.iconReplaceTarget = null;
		addFree(makeIcon(W, H, name));
	}

	function onFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			const src = String(reader.result);
			const img = new window.Image();
			img.onload = () => addFree(makeImage(W, H, src, img.naturalWidth / img.naturalHeight || 1));
			img.src = src;
		};
		reader.readAsDataURL(file);
		(e.currentTarget as HTMLInputElement).value = '';
	}
</script>

<aside class="panel">
	<section>
		<h3 class="section-title">Add</h3>
		<div class="adds">
			<button class="add" onclick={() => addFree(makeText(W, H), true)}>
				<Icon svg={Type} size={18} /><span>Text</span>
			</button>
			<button class="add" onclick={() => editor.add(makeShape(W, H, 'rect'))}>
				<Icon svg={Square} size={18} /><span>Box</span>
			</button>
			<button class="add" onclick={() => editor.add(makeShape(W, H, 'ellipse'))}>
				<Icon svg={Circle} size={18} /><span>Ellipse</span>
			</button>
			<button class="add" onclick={() => addFree(makeShape(W, H, 'line'))}>
				<Icon svg={Minus} size={18} /><span>Line</span>
			</button>
			<button class="add" onclick={() => addFree(makeQr(W, H), true)}>
				<Icon svg={QrCode} size={18} /><span>QR code</span>
			</button>
			<button class="add" onclick={() => fileInput.click()}>
				<Icon svg={Image} size={18} /><span>Image</span>
			</button>
		</div>
		<input type="file" accept="image/*" bind:this={fileInput} onchange={onFile} hidden />
	</section>

	<section class="icons">
		<div class="icons-head">
			<h3 class="section-title">Icons</h3>
			{#if replacing}
				<button class="btn sm ghost" onclick={() => (editor.iconReplaceTarget = null)}>Cancel replace</button>
			{/if}
		</div>
		<IconPicker bind:this={picker} onpick={pickIcon} {replacing} />
		<a class="credit" href="https://lucide.dev" target="_blank" rel="noreferrer">Icons by Lucide</a>
	</section>
</aside>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 16px;
		background: var(--panel);
		border-right: 1px solid var(--line);
		min-height: 0;
		overflow: hidden;
	}

	.adds {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
	}

	.add {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 10px 4px 8px;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: var(--panel);
		font-size: 12px;
		font-weight: 500;
		color: var(--text);
		transition: background 0.12s, border-color 0.12s;
	}

	.add:hover {
		background: var(--panel-2);
		border-color: var(--line-strong);
	}

	.icons {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
	}

	.icons-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.icons-head .section-title {
		margin: 0 0 8px;
	}

	.credit {
		margin-top: 8px;
		font-size: 11px;
		color: var(--faint);
		text-decoration: none;
	}

	.credit:hover {
		color: var(--muted);
	}
</style>
