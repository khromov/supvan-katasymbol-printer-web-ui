<script lang="ts">
	/** Renders a lucide-static SVG string, e.g. `import { Printer } from 'lucide-static'`. */
	let { svg, size = 16, stroke = 2 }: { svg: string; size?: number; stroke?: number } = $props();

	const html = $derived(
		svg
			.replace(/width="24"/, `width="${size}"`)
			.replace(/height="24"/, `height="${size}"`)
			.replace(/stroke-width="2"/, `stroke-width="${stroke}"`)
	);
</script>

<span class="icon" aria-hidden="true">{@html html}</span>

<style>
	.icon {
		display: inline-flex;
		flex: none;
		line-height: 0;
	}
</style>
