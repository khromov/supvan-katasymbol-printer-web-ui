<script lang="ts">
	import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryCharging, Bluetooth, CircleAlert, Loader, Tag, Unplug, TriangleAlert, Usb, X, Zap } from 'lucide-static';
	import Icon from './Icon.svelte';
	import { printer } from '../stores/printer.svelte';
	import { mode } from '../stores/mode.svelte';
	import { detectPlatform } from '../platform';

	const platform = detectPlatform();
	/** What to do when this browser can't reach printers at all. */
	const unsupportedHint =
		platform === 'ios'
			? "Safari can't connect to printers. Open this page in the Bluefy browser to print."
			: platform === 'android'
				? 'This browser can\'t connect to printers. Open this page in Chrome to print.'
				: 'This browser can\'t connect to printers. Use Chrome or Edge to print.';

	const batteryIcon = $derived.by(() => {
		const l = printer.status?.batteryLevel ?? 0;
		return l >= 4 ? BatteryFull : l >= 2 ? BatteryMedium : l >= 1 ? BatteryLow : Battery;
	});

	const statusTone = $derived.by(() => {
		if (printer.state === 'printing') return 'warn';
		if (printer.status?.errors.length) return 'err';
		if (printer.status?.warnings.length) return 'warn';
		return 'ok';
	});
</script>

<header>
	<div class="brand">
		<div class="logo"><Icon svg={Tag} size={18} /></div>
		<div>
			<div class="name">Katasymbol Web</div>
			<div class="sub">Label designer for Supvan / Katasymbol printers</div>
		</div>
	</div>

	<div class="conn">
		{#if mode.isPhone}
			<button class="btn sm" onclick={() => mode.choose('quick')} title="Switch to the quick label maker"><Icon svg={Zap} size={14} /> Quick label</button>
		{/if}
		{#if !printer.supported && !printer.bluetoothSupported}
			<span class="pill err unsupported" title="USB and Bluetooth printing need Chrome or Edge (or Bluefy on iPhone/iPad)">
				<Icon svg={TriangleAlert} size={14} /> {unsupportedHint}
			</span>
		{:else if printer.state === 'connecting'}
			<span class="pill"><span class="spin"><Icon svg={Loader} size={14} /></span> Connecting…</span>
		{:else if printer.connected && printer.model}
			<span class="pill {statusTone}">
				<span class="dot"></span>
				{printer.model.name}
				{#if printer.state === 'printing'}· printing{:else if printer.status?.errors.length}· {printer.status.errors[0]}{/if}
			</span>
			{#if printer.status?.charging}
				<span class="pill" title="Charging over USB"><Icon svg={BatteryCharging} size={14} /> Charging</span>
			{:else if printer.status?.batteryVolts}
				<span class="pill" title="Battery {printer.status.batteryVolts.toFixed(2)} V"><Icon svg={batteryIcon} size={14} /> {Math.round(((printer.status.batteryLevel ?? 0) / 4) * 100)}%</span>
			{/if}
			<button class="btn ghost sm" onclick={() => printer.disconnect()} title="Disconnect printer">
				<Icon svg={Unplug} size={15} /> Disconnect
			</button>
		{:else}
			{#if printer.supported}
				<button class="btn primary" onclick={() => printer.connect()} title="Connect a printer over USB">
					<Icon svg={Usb} size={16} /> Connect USB
				</button>
			{/if}
			{#if printer.bluetoothSupported}
				<button class="btn" class:primary={!printer.supported} onclick={() => printer.connectBluetooth()} title={printer.bleSupported ? 'Connect a T50/T80 printer over Bluetooth' : 'Connect a paired T50/T80 printer over Bluetooth'}>
					<Icon svg={Bluetooth} size={16} /> Bluetooth
				</button>
			{/if}
		{/if}
	</div>
</header>

{#if printer.error && !printer.connected}
	<div class="banner" role="alert">
		<Icon svg={CircleAlert} size={16} />
		<div class="banner-text">
			<div>{printer.error}</div>
			{#if printer.errorDetail}<div class="detail">Details: {printer.errorDetail}</div>{/if}
		</div>
		<button class="btn sm icon ghost" onclick={() => printer.setError(null)} aria-label="Dismiss"><Icon svg={X} size={14} /></button>
	</div>
{/if}

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 10px 16px;
		background: var(--panel);
		border-bottom: 1px solid var(--line);
		min-height: 58px;
		flex-wrap: wrap;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.logo {
		width: 34px;
		height: 34px;
		border-radius: 9px;
		background: var(--accent);
		color: var(--accent-ink);
		display: grid;
		place-items: center;
	}

	.name {
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.sub {
		font-size: 12px;
		color: var(--muted);
	}

	.conn {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.unsupported {
		height: auto;
		min-height: 24px;
		padding: 4px 10px;
		white-space: normal;
		line-height: 1.35;
	}

	.banner {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 16px;
		background: var(--err-soft);
		color: var(--err);
		border-bottom: 1px solid color-mix(in oklab, var(--err), transparent 75%);
		font-size: 13px;
		line-height: 1.45;
	}

	.banner > :global(.icon) {
		margin-top: 1px;
	}

	.banner-text {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.detail {
		margin-top: 2px;
		font-size: 12px;
		opacity: 0.75;
	}

	.banner .btn {
		color: inherit;
		margin: -4px -6px -4px 0;
	}

	.spin {
		display: inline-flex;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 640px) {
		.sub {
			display: none;
		}
	}
</style>
