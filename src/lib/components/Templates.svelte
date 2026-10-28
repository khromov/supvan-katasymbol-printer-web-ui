<script lang="ts">
	import { CircleAlert, Download, FolderOpen, Pencil, Save, Trash2, Upload, X } from 'lucide-static';
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import { editor } from '../stores/editor.svelte';
	import { templates, type Template } from '../stores/templates.svelte';

	let name = $state('');
	let renaming = $state<string | null>(null);
	let renameValue = $state('');
	let fileInput: HTMLInputElement;
	let nameInput: HTMLInputElement;

	const taken = $derived(name.trim() ? templates.byName(name) : undefined);

	onMount(() => {
		templates.error = null;
		nameInput.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && !renaming) templates.open = false;
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	function save() {
		if (!name.trim()) return;
		if (taken && !confirm(`Replace the template "${taken.name}" with the current design?`)) return;
		if (templates.save(name)) name = '';
	}

	function overwrite(t: Template) {
		if (confirm(`Replace "${t.name}" with the current design?`)) templates.overwrite(t.id);
	}

	function remove(t: Template) {
		if (confirm(`Delete the template "${t.name}"?`)) templates.remove(t.id);
	}

	function startRename(t: Template) {
		renaming = t.id;
		renameValue = t.name;
	}

	function finishRename(e?: Event) {
		e?.preventDefault();
		if (renaming && renameValue.trim()) templates.rename(renaming, renameValue);
		renaming = null;
	}

	function onFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) void templates.importFile(file);
	}

	const date = (ms: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
	/** Size as edited: turned labels show their sides swapped. */
	const size = (t: Template) => {
		const [a, b] = [t.label.lengthMm, t.label.widthMm];
		const landscape = t.orientation === 'landscape';
		return `${landscape ? Math.max(a, b) : Math.min(a, b)} × ${landscape ? Math.min(a, b) : Math.max(a, b)} mm · ${t.orientation}`;
	};
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && (templates.open = false)}>
	<div class="card" role="dialog" aria-modal="true" aria-labelledby="templates-title">
		<div class="head">
			<h2 id="templates-title">Templates</h2>
			<button class="btn sm icon ghost" onclick={() => (templates.open = false)} aria-label="Close"><Icon svg={X} size={16} /></button>
		</div>

		<form class="save" onsubmit={(e) => (e.preventDefault(), save())}>
			<input class="input" bind:this={nameInput} bind:value={name} placeholder="Name this design, e.g. Shelf label" maxlength="80" aria-label="Template name" />
			<button class="btn primary" type="submit" disabled={!name.trim() || !editor.elements.length} title={editor.elements.length ? 'Save the current design' : 'The label is empty'}>
				<Icon svg={Save} size={15} /> {taken ? 'Replace' : 'Save'}
			</button>
		</form>

		{#if templates.error}
			<div class="error" role="alert"><Icon svg={CircleAlert} size={15} /> {templates.error}</div>
		{/if}

		{#if templates.list.length}
			<ul class="list">
				{#each templates.sorted as t (t.id)}
					<li>
						{#if renaming === t.id}
							<form class="rename" onsubmit={finishRename}>
								<input
									class="input"
									bind:value={renameValue}
									{@attach (node) => {
										node.focus();
										node.select();
									}}
									maxlength="80"
									aria-label="New name"
									onblur={() => finishRename()}
									onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), (renaming = null))}
								/>
							</form>
						{:else}
							<button class="open" onclick={() => templates.apply(t.id)} title="Open this template">
								<b>{t.name}</b>
								<small>{size(t)} · {t.elements.length} {t.elements.length === 1 ? 'element' : 'elements'} · {date(t.savedAt)}</small>
							</button>
						{/if}
						<div class="actions">
							<button class="btn sm icon ghost" onclick={() => templates.apply(t.id)} title="Open"><Icon svg={FolderOpen} size={15} /></button>
							<button class="btn sm icon ghost" onclick={() => overwrite(t)} disabled={!editor.elements.length} title="Save the current design over this one"><Icon svg={Save} size={15} /></button>
							<button class="btn sm icon ghost" onclick={() => startRename(t)} title="Rename"><Icon svg={Pencil} size={15} /></button>
							<button class="btn sm icon ghost" onclick={() => templates.exportFile(t, t.name)} title="Export to a file"><Icon svg={Download} size={15} /></button>
							<button class="btn sm icon ghost danger" onclick={() => remove(t)} title="Delete"><Icon svg={Trash2} size={15} /></button>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">No templates yet. Design a label, give it a name above and save it to use it again later.</p>
		{/if}

		<div class="files">
			<button class="btn sm" onclick={() => fileInput.click()} title="Open a template file exported from this app"><Icon svg={Upload} size={14} /> Import file…</button>
			<button class="btn sm" onclick={() => templates.exportFile(editor.design, name || 'label')} disabled={!editor.elements.length} title="Save the current design to a file">
				<Icon svg={Download} size={14} /> Export current design
			</button>
		</div>
		<input type="file" accept=".json,application/json" bind:this={fileInput} onchange={onFile} hidden />
		<p class="note">
			Templates are kept in this browser. Export them to files for a backup or to use them on another computer. Opening a template
			replaces the label you're working on; Undo brings it back.
		</p>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: grid;
		place-items: center;
		padding: 16px;
		background: color-mix(in oklab, var(--bg), transparent 30%);
		backdrop-filter: blur(4px);
	}

	.card {
		width: min(520px, 100%);
		max-height: calc(100vh - 32px);
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px 18px 16px;
		border-radius: 16px;
		background: var(--panel);
		border: 1px solid var(--line);
		box-shadow: 0 24px 64px rgb(0 0 0 / 0.18);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	h2 {
		margin: 0;
		font-size: 18px;
		letter-spacing: -0.01em;
	}

	.save {
		display: flex;
		gap: 8px;
	}

	.save .input {
		flex: 1;
		min-width: 0;
	}

	.error {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		padding: 8px 10px;
		border-radius: 8px;
		background: var(--err-soft);
		color: var(--err);
		font-size: 13px;
		line-height: 1.4;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow-y: auto;
		min-height: 0;
	}

	li {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 2px 4px 2px 0;
		border-radius: 9px;
	}

	li:hover {
		background: var(--panel-2);
	}

	.open {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 7px 10px;
		border: 0;
		background: transparent;
		color: var(--text);
		text-align: left;
	}

	.open b,
	.open small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.open small {
		color: var(--muted);
		font-size: 12px;
	}

	.rename {
		flex: 1;
		min-width: 0;
		padding: 4px 6px;
	}

	.rename .input {
		width: 100%;
	}

	.actions {
		display: flex;
		flex: none;
	}

	.danger:hover:not(:disabled) {
		color: var(--err);
	}

	.files {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.muted,
	.note {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.45;
	}

	.note {
		font-size: 12px;
		color: var(--faint);
	}

	@media (max-width: 480px) {
		.actions .btn:nth-child(1) {
			display: none;
		}
	}
</style>
