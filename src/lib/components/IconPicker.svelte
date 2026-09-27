<script lang="ts">
	import { Search, X } from 'lucide-static';
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import { iconSvg, loadIcons, searchIcons, iconNames } from '../design/icons';

	let { onpick, replacing = null }: { onpick: (name: string) => void; replacing?: string | null } = $props();

	let query = $state('');
	let ready = $state(false);
	/** Back to the first page whenever the query changes; "Show more" raises it. */
	let limit = $derived.by(() => {
		void query;
		return 96;
	});
	let input: HTMLInputElement;

	const all = $derived(ready ? searchIcons(query, 5000) : []);
	const results = $derived(all.slice(0, limit));
	const total = $derived(all.length);

	onMount(() => {
		loadIcons().then(() => (ready = true));
	});

	export function focus() {
		input?.focus();
		input?.select();
	}
</script>

<div class="picker">
	<div class="search">
		<Icon svg={Search} size={15} />
		<input
			bind:this={input}
			bind:value={query}
			placeholder={ready ? `Search ${iconNames().length.toLocaleString()} icons…` : 'Loading icons…'}
			aria-label="Search icons"
			onkeydown={(e) => {
				if (e.key === 'Enter' && results[0]) onpick(results[0]);
				if (e.key === 'Escape') query = '';
			}}
		/>
		{#if query}
			<button class="clear" onclick={() => (query = '')} aria-label="Clear search"><Icon svg={X} size={14} /></button>
		{/if}
	</div>
	<div class="meta">
		{#if replacing}
			Click an icon to replace <b>{replacing}</b>
		{:else if query.trim()}
			{total} match{total === 1 ? '' : 'es'} · Enter adds the first
		{:else}
			Popular icons · type to search by name or tag
		{/if}
	</div>
	<div class="grid">
		{#each results as name (name)}
			<button class="cell" title={name} onclick={() => onpick(name)}>
				{@html iconSvg(name, 22, 1.75)}
			</button>
		{:else}
			{#if ready}<div class="empty">No icons match “{query}”.</div>{/if}
		{/each}
	</div>
	{#if query.trim() && total > results.length}
		<button class="btn sm ghost more" onclick={() => (limit += 96)}>Show more ({total - results.length} left)</button>
	{/if}
</div>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-height: 0;
	}

	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 36px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--panel);
		color: var(--muted);
	}

	.search:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}

	.search input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text);
	}

	.clear {
		border: 0;
		background: transparent;
		color: var(--muted);
		display: inline-flex;
		padding: 2px;
	}

	.meta {
		font-size: 12px;
		color: var(--faint);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(42px, 1fr));
		gap: 4px;
		overflow-y: auto;
		min-height: 0;
		padding: 1px;
	}

	.cell {
		aspect-ratio: 1;
		display: grid;
		place-items: center;
		border: 1px solid transparent;
		border-radius: 8px;
		background: var(--panel-2);
		color: var(--text);
		transition: background 0.1s, border-color 0.1s, transform 0.1s;
	}

	.cell:hover {
		background: var(--accent-soft);
		border-color: color-mix(in oklab, var(--accent), transparent 60%);
		color: var(--accent);
	}

	.cell:active {
		transform: scale(0.94);
	}

	.cell :global(svg) {
		display: block;
	}

	.empty {
		grid-column: 1 / -1;
		color: var(--muted);
		font-size: 13px;
		padding: 12px 0;
	}

	.more {
		align-self: center;
	}
</style>
