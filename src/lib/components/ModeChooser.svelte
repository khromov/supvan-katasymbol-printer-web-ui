<script lang="ts">
	import { LayoutDashboard, Tag, Zap } from 'lucide-static';
	import Icon from './Icon.svelte';
	import { mode } from '../stores/mode.svelte';
</script>

<div class="backdrop">
	<div class="card" role="dialog" aria-modal="true" aria-labelledby="mode-title">
		<div class="logo"><Icon svg={Tag} size={22} /></div>
		<h2 id="mode-title">What would you like to do?</h2>
		<button class="choice primary" onclick={() => mode.choose('quick')}>
			<Icon svg={Zap} size={22} />
			<span>
				<b>Quick label</b>
				<small>Type some text, add an icon, print. Made for phones.</small>
			</span>
		</button>
		<button class="choice" onclick={() => mode.choose('studio')}>
			<Icon svg={LayoutDashboard} size={22} />
			<span>
				<b>Full studio</b>
				<small>The complete editor: layers, shapes, QR codes and images.</small>
			</span>
		</button>
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
		background: color-mix(in oklab, var(--bg), transparent 8%);
		backdrop-filter: blur(6px);
	}

	.card {
		width: min(420px, 100%);
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 24px 20px 20px;
		border-radius: 18px;
		background: var(--panel);
		border: 1px solid var(--line);
		box-shadow: 0 24px 64px rgb(0 0 0 / 0.18);
	}

	.logo {
		width: 44px;
		height: 44px;
		border-radius: 12px;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: var(--accent-ink);
	}

	h2 {
		margin: 4px 0 8px;
		font-size: 20px;
		letter-spacing: -0.01em;
	}

	.choice {
		display: flex;
		align-items: center;
		gap: 14px;
		width: 100%;
		padding: 16px;
		border-radius: 14px;
		border: 1px solid var(--line);
		background: var(--panel);
		color: var(--text);
		text-align: left;
	}

	.choice span {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.choice b {
		font-size: 16px;
	}

	.choice small {
		font-size: 13px;
		color: var(--muted);
		line-height: 1.35;
	}

	.choice.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-ink);
	}

	.choice.primary small {
		color: color-mix(in oklab, var(--accent-ink), transparent 20%);
	}

	.choice:active {
		transform: scale(0.99);
	}
</style>
