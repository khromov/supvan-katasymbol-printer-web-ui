<script lang="ts">
	import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryCharging, Bluetooth, Loader, Tag, Unplug, TriangleAlert, Usb } from 'lucide-static';
	import Icon from './Icon.svelte';
	import { printer } from '../stores/printer.svelte';

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
		{#if !printer.supported && !printer.bluetoothSupported}
			<span class="pill err" title="WebHID and Web Serial are available in Chrome, Edge and other Chromium browsers">
				<Icon svg={TriangleAlert} size={14} /> This browser can't talk to printers (use Chrome or Edge)
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
			{#if printer.error}<span class="pill err error-msg" title={printer.error}>{printer.error}</span>{/if}
			{#if printer.supported}
				<button class="btn primary" onclick={() => printer.connect()} title="Connect a printer over USB">
					<Icon svg={Usb} size={16} /> Connect USB
				</button>
			{/if}
			{#if printer.bluetoothSupported}
				<button class="btn" class:primary={!printer.supported} onclick={() => printer.connectBluetooth()} title="Connect a paired T50/T80 printer over Bluetooth">
					<Icon svg={Bluetooth} size={16} /> Bluetooth
				</button>
			{/if}
		{/if}
	</div>
</header>

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

	.error-msg {
		max-width: 360px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
