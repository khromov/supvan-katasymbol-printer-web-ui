<script lang="ts">
	import { onMount } from 'svelte';
	import Header from './lib/components/Header.svelte';
	import AddPanel from './lib/components/AddPanel.svelte';
	import Stage from './lib/components/Stage.svelte';
	import Inspector from './lib/components/Inspector.svelte';
	import PrintPanel from './lib/components/PrintPanel.svelte';
	import QuickMode from './lib/components/QuickMode.svelte';
	import ModeChooser from './lib/components/ModeChooser.svelte';
	import { mode } from './lib/stores/mode.svelte';
	import { printer } from './lib/stores/printer.svelte';
	import { editor } from './lib/stores/editor.svelte';

	onMount(() => printer.init());

	// Persist print settings alongside the design.
	$effect(() => {
		void editor.density;
		void editor.copies;
		editor.persist();
	});
</script>

{#if mode.mode === 'quick'}
	<QuickMode />
{:else}
	<div class="app">
		<Header />
		<main>
			<AddPanel />
			<Stage />
			<aside class="right">
				<Inspector />
				<hr />
				<PrintPanel />
			</aside>
		</main>
	</div>
{/if}

{#if mode.choosing}
	<ModeChooser />
{/if}

<style>
	.app {
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	main {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 280px minmax(0, 1fr) 320px;
	}

	.right {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 16px;
		background: var(--panel);
		border-left: 1px solid var(--line);
		overflow-y: auto;
		min-height: 0;
	}

	hr {
		width: 100%;
		border: 0;
		border-top: 1px solid var(--line);
		margin: 0;
	}

	@media (max-width: 1080px) {
		main {
			grid-template-columns: 240px minmax(0, 1fr) 290px;
		}
	}

	@media (max-width: 860px) {
		.app {
			height: auto;
			min-height: 100%;
		}

		main {
			grid-template-columns: 1fr;
			grid-template-rows: none;
			grid-auto-rows: auto;
		}

		main > :global(:first-child) {
			order: 2;
			border-right: 0;
			border-top: 1px solid var(--line);
			max-height: 440px;
		}

		main > :global(.stage) {
			order: 1;
			height: min(62vh, 560px);
		}

		.right {
			order: 3;
			border-left: 0;
			border-top: 1px solid var(--line);
		}
	}
</style>
