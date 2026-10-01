<script lang="ts">
	import { Bluetooth, Check, ChevronDown, Copy, ExternalLink, Laptop, Smartphone, Tablet, Usb } from 'lucide-static';
	import Icon from './Icon.svelte';
	import { detectPlatform, type Platform } from '../platform';

	type Method = { label: string; icon: string; steps: string[]; bluefy?: boolean };
	type Guide = { id: 'desktop' | 'android' | 'ios'; title: string; icon: string; summary: string; intro?: string; methods: Method[] };

	const BLUEFY_URL = 'https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055';
	let copied = $state(false);

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(location.href.split('?')[0]);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// Clipboard unavailable; the address bar still has the link.
		}
	}

	const PICK_PRINTER = 'Pick your printer in the list (its name starts with T0).';

	const GUIDES: Guide[] = [
		{
			id: 'desktop',
			title: 'Mac or Windows',
			icon: Laptop,
			summary: 'USB or Bluetooth',
			intro: 'Use Chrome or Edge, then connect either way:',
			methods: [
				{
					label: 'With a USB cable',
					icon: Usb,
					steps: ['Plug the printer into your computer and switch it on.', 'Click USB and choose the SUPVAN "USB Device".']
				},
				{
					label: 'Wirelessly (Bluetooth)',
					icon: Bluetooth,
					steps: [
						'Turn on Bluetooth on your computer and switch the printer on. No pairing needed.',
						`Click Connect Bluetooth. ${PICK_PRINTER}`
					]
				}
			]
		},
		{
			id: 'android',
			title: 'Android',
			icon: Smartphone,
			summary: 'Bluetooth',
			methods: [
				{
					label: 'Bluetooth in Chrome',
					icon: Bluetooth,
					steps: ['Open this page in Chrome.', 'Turn on Bluetooth and switch the printer on.', `Tap Connect Bluetooth. ${PICK_PRINTER}`]
				}
			]
		},
		{
			id: 'ios',
			title: 'iPhone or iPad',
			icon: Tablet,
			summary: 'Bluetooth in Bluefy',
			methods: [
				{
					label: 'Bluetooth in the Bluefy browser',
					icon: Bluetooth,
					steps: [
						"Safari can't connect to printers, so install the free Bluefy browser.",
						'Open this page in Bluefy, turn on Bluetooth and switch the printer on.',
						`Tap Connect Bluetooth. ${PICK_PRINTER}`
					],
					bluefy: true
				}
			]
		}
	];

	const platform: Platform = detectPlatform();
	const mine = platform === 'ios' ? 'ios' : platform === 'android' ? 'android' : 'desktop';
	const current = GUIDES.find((g) => g.id === mine)!;
	const others = GUIDES.filter((g) => g.id !== mine);
	let showOthers = $state(false);
</script>

<div class="help">
	<div class="title">How to connect</div>
	{@render guide(current, true)}
	<button class="more" onclick={() => (showOthers = !showOthers)} aria-expanded={showOthers}>
		Other devices <span class="chev" class:open={showOthers}><Icon svg={ChevronDown} size={14} /></span>
	</button>
	{#if showOthers}
		{#each others as g (g.id)}{@render guide(g, false)}{/each}
	{/if}
	<p class="note">The printer takes one connection at a time, so close the Katasymbol app on your other devices first.</p>
</div>

{#snippet guide(g: Guide, primary: boolean)}
	<div class="guide" class:primary>
		<div class="guide-head">
			<Icon svg={g.icon} size={16} />
			<span class="guide-title">{g.title}</span>
			<span class="via">{g.summary}</span>
		</div>
		{#if g.intro}<p class="intro">{g.intro}</p>{/if}
		{#each g.methods as m (m.label)}
			<div class="method">
				{#if g.methods.length > 1}
					<div class="method-head"><Icon svg={m.icon} size={13} /> {m.label}</div>
				{/if}
				<ol>
					{#each m.steps as step (step)}<li>{step}</li>{/each}
				</ol>
				{#if m.bluefy}
					<div class="actions">
						<a class="btn sm" href={BLUEFY_URL} target="_blank" rel="noreferrer"><Icon svg={ExternalLink} size={13} /> Get Bluefy</a>
						<button class="btn sm" onclick={copyLink}><Icon svg={copied ? Check : Copy} size={13} /> {copied ? 'Copied' : 'Copy page link'}</button>
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/snippet}

<style>
	.help {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel-2);
	}

	.title {
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
	}

	.guide {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.guide + .guide {
		padding-top: 8px;
		border-top: 1px solid var(--line);
	}

	.guide-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.guide-title {
		font-weight: 600;
		font-size: 13px;
	}

	.via {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: var(--muted);
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 1px 7px;
	}

	.primary .via {
		color: var(--accent);
		border-color: color-mix(in oklab, var(--accent), transparent 60%);
		background: var(--accent-soft);
	}

	ol {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 13px;
		color: var(--text);
	}

	.intro {
		margin: 0;
		font-size: 13px;
	}

	.method {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.method-head {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
		margin-top: 2px;
	}

	.actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		padding-left: 18px;
	}

	.actions .btn {
		text-decoration: none;
		color: var(--text);
	}

	.more {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 0;
		background: none;
		padding: 2px 0;
		font-size: 12px;
		color: var(--muted);
	}

	.more:hover {
		color: var(--text);
	}

	.chev {
		display: inline-flex;
		transition: transform 0.15s;
	}

	.chev.open {
		transform: rotate(180deg);
	}

	.note {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}
</style>
