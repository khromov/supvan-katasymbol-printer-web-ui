import {
	grantedBluetoothPort,
	grantedPrinter,
	openBluetoothPrinter,
	openPrinter,
	PrinterError,
	requestBluetoothPort,
	requestPrinter,
	webHidSupported,
	webSerialSupported,
	type Bitmap,
	type DeviceModel,
	type LabelSpec,
	type MediaInfo,
	type PrintProgress,
	type PrinterDriver,
	type PrinterStatus
} from '../printer';
import type { Family } from '../printer/types';

const FAMILY_KEY = 'katasymbol-web:family';
const LINK_KEY = 'katasymbol-web:link';
/** Protocol logging (Bluetooth frames) when the page URL has ?debug. */
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

type Link = 'usb' | 'bluetooth';

function readLink(): Link {
	try {
		return localStorage.getItem(LINK_KEY) === 'bluetooth' ? 'bluetooth' : 'usb';
	} catch {
		return 'usb';
	}
}

function saveLink(link: Link) {
	try {
		localStorage.setItem(LINK_KEY, link);
	} catch {
		// ignore
	}
}
const DEFAULT_DPMM: Record<Family, number> = { t5080: 8, sp: 11.8, tp: 11.3, tp86a: 11.3, g: 8 };

function readFamily(): Family {
	try {
		const f = localStorage.getItem(FAMILY_KEY);
		return f && f in DEFAULT_DPMM ? (f as Family) : 't5080';
	} catch {
		return 't5080';
	}
}

type ConnState = 'disconnected' | 'connecting' | 'ready' | 'printing';

const trimDots = (m: string) => m.replace(/\.+$/, '');

/** Plain-language message for a failed Bluetooth connection. */
function bluetoothErrorMessage(e: unknown): string {
	const raw = (e as Error)?.message ?? String(e);
	if (/open/i.test(raw) && /serial port/i.test(raw))
		return "Couldn't open a Bluetooth connection to the printer. Check that it's switched on, paired with this computer and not connected to a phone. On a Mac, forgetting the printer in Bluetooth settings and pairing it again usually helps.";
	if ((e as PrinterError)?.code === 'timeout')
		return "The printer didn't answer over Bluetooth. Check that it's switched on and not connected to another device, then try again.";
	return `Couldn't connect over Bluetooth: ${trimDots(raw)}.`;
}

/** Plain-language message for a failed USB connection. */
function usbErrorMessage(e: unknown): string {
	const raw = (e as Error)?.message ?? String(e);
	if (/failed to open/i.test(raw))
		return "Couldn't open the printer over USB. Close other apps that might be using it (like KatasymbolEditor), then reconnect the cable and try again.";
	return `Couldn't connect over USB: ${trimDots(raw)}.`;
}

const STATUS_INTERVAL = 2500;
const MEDIA_INTERVAL = 6000;

class PrinterStore {
	supported = webHidSupported();
	bluetoothSupported = webSerialSupported();
	debug = DEBUG;
	/** Connection used by the current printer. */
	link = $state<Link | null>(null);
	/** Recent protocol lines (only collected with ?debug). */
	log = $state<string[]>([]);
	state = $state<ConnState>('disconnected');
	model = $state<DeviceModel | null>(null);
	status = $state<PrinterStatus | null>(null);
	media = $state<MediaInfo | null>(null);
	progress = $state<PrintProgress | null>(null);
	error = $state<string | null>(null);
	/** Technical detail behind `error` (the raw browser/driver message), if different. */
	errorDetail = $state<string | null>(null);
	lastPrintOk = $state(false);
	/** Family to design for while no printer is connected. */
	preferredFamily = $state<Family>(readFamily());

	private driver: PrinterDriver | null = null;
	private transport: { close(): Promise<void> } | null = null;
	private device: HIDDevice | null = null;
	private port: SerialPort | null = null;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private lastMediaAt = 0;
	private polling = false;
	private abort: AbortController | null = null;

	get connected() {
		return this.state === 'ready' || this.state === 'printing';
	}

	get dpmm() {
		return this.driver?.dpmm ?? this.model?.dpmm ?? DEFAULT_DPMM[this.family];
	}

	get family(): Family {
		return this.model?.family ?? this.preferredFamily;
	}

	setPreferredFamily(f: Family) {
		this.preferredFamily = f;
		try {
			localStorage.setItem(FAMILY_KEY, f);
		} catch {
			// ignore
		}
	}

	canvasSize(label: LabelSpec) {
		return (
			this.driver?.canvasSize(label) ?? {
				width: Math.round(label.lengthMm * this.dpmm),
				height: Math.round(label.widthMm * this.dpmm)
			}
		);
	}

	setError(message: string | null, detail: string | null = null) {
		this.error = message;
		this.errorDetail = message && detail && detail !== message ? detail : null;
	}

	addLog(line: string) {
		if (!this.debug) return;
		const t = new Date().toISOString().slice(11, 23);
		this.log = [...this.log.slice(-299), `${t} ${line}`];
	}

	init() {
		if (this.bluetoothSupported) {
			navigator.serial.addEventListener('disconnect', (e) => {
				if (e.target === this.port) this.teardown('Bluetooth printer disconnected');
			});
		}
		if (this.supported) {
			navigator.hid.addEventListener('disconnect', (e) => {
				if (e.device === this.device) this.teardown('Printer disconnected');
			});
			navigator.hid.addEventListener('connect', () => {
				if (this.state === 'disconnected') void this.autoConnect();
			});
		}
		void this.autoConnect();
	}

	/** Reconnect to an already-granted printer, preferring the link used last time. */
	async autoConnect() {
		try {
			if (readLink() === 'bluetooth' && this.bluetoothSupported) {
				const port = await grantedBluetoothPort();
				if (port) return await this.openBluetooth(port, true);
			}
			if (!this.supported) return;
			const d = await grantedPrinter();
			if (d) await this.open(d);
		} catch (e) {
			console.warn('auto connect failed', e);
		}
	}

	async connectBluetooth() {
		this.setError(null);
		try {
			await this.openBluetooth(await requestBluetoothPort());
		} catch (e) {
			if ((e as Error)?.name === 'NotFoundError') return; // chooser dismissed
			this.setError((e as Error).message);
			this.state = 'disconnected';
		}
	}

	private async openBluetooth(port: SerialPort, quiet = false) {
		if (this.connected) await this.disconnect();
		this.state = 'connecting';
		this.setError(null);
		this.addLog('opening Bluetooth serial port');
		try {
			const { model, driver, transport } = await openBluetoothPrinter(port, this.debug);
			driver.channel.log = (line) => this.addLog(line);
			this.port = port;
			this.model = model;
			this.driver = driver;
			this.transport = transport;
			this.link = 'bluetooth';
			saveLink('bluetooth');
			this.state = 'ready';
			this.lastMediaAt = 0;
			await this.poll();
		} catch (e) {
			this.addLog(`connect failed: ${(e as Error).message}`);
			this.state = 'disconnected';
			this.model = null;
			if (!quiet) this.setError(bluetoothErrorMessage(e), (e as Error).message);
		}
	}

	async connect() {
		this.setError(null);
		try {
			const d = await requestPrinter();
			if (d) await this.open(d);
		} catch (e) {
			if ((e as Error)?.name === 'NotFoundError') return; // chooser dismissed
			this.setError((e as Error).message);
			this.state = 'disconnected';
		}
	}

	private async open(device: HIDDevice) {
		if (this.connected) await this.disconnect();
		this.state = 'connecting';
		this.setError(null);
		try {
			const { model, driver, transport } = await openPrinter(device);
			this.device = device;
			this.model = model;
			this.driver = driver;
			this.transport = transport;
			this.link = 'usb';
			saveLink('usb');
			this.state = 'ready';
			this.lastMediaAt = 0;
			await this.poll();
		} catch (e) {
			this.setError(usbErrorMessage(e), (e as Error).message);
			this.state = 'disconnected';
			this.model = null;
		}
	}

	async disconnect() {
		this.stopPolling();
		this.abort?.abort();
		const t = this.transport;
		this.teardown(null);
		await t?.close().catch(() => {});
	}

	private teardown(error: string | null) {
		this.stopPolling();
		this.driver = null;
		this.transport = null;
		this.device = null;
		this.port = null;
		this.link = null;
		this.model = null;
		this.status = null;
		this.media = null;
		this.progress = null;
		this.state = 'disconnected';
		this.setError(error);
	}

	private stopPolling() {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = null;
	}

	private schedulePoll() {
		this.stopPolling();
		if (this.state === 'ready') this.pollTimer = setTimeout(() => void this.poll(), STATUS_INTERVAL);
	}

	/** Refresh status (and periodically the loaded media) while idle. */
	async poll() {
		const driver = this.driver;
		if (!driver || this.state !== 'ready' || this.polling) return;
		this.polling = true;
		try {
			this.status = await driver.getStatus();
			if (driver.readMedia && Date.now() - this.lastMediaAt > MEDIA_INTERVAL && !this.status.printing) {
				this.lastMediaAt = Date.now();
				this.media = await driver.readMedia();
			}
		} catch (e) {
			console.warn('status poll failed', e);
		} finally {
			this.polling = false;
			this.schedulePoll();
		}
	}

	/** Stop a job the printer is still running (e.g. left over from an interrupted print). */
	async stopPrinter() {
		const driver = this.driver;
		if (!driver?.stop || this.state !== 'ready') return;
		this.stopPolling();
		while (this.polling) await new Promise((r) => setTimeout(r, 20));
		try {
			await driver.stop();
		} catch (e) {
			this.setError((e as Error).message);
		} finally {
			void this.poll();
		}
	}

	async print(pages: Bitmap[], label: LabelSpec, opts: { density: number; copies: number; cutType?: number; offsetX?: number; offsetY?: number }) {
		const driver = this.driver;
		if (!driver) throw new PrinterError('Connect a printer first', 'disconnected');
		if (this.state === 'printing') throw new PrinterError('Already printing', 'busy');
		this.stopPolling();
		// Let an in-flight poll finish so no status request interleaves with the print job.
		while (this.polling) await new Promise((r) => setTimeout(r, 20));
		this.state = 'printing';
		this.setError(null);
		this.lastPrintOk = false;
		this.abort = new AbortController();
		try {
			await driver.print(pages, label, {
				...opts,
				signal: this.abort.signal,
				onProgress: (p) => (this.progress = p)
			});
			this.lastPrintOk = true;
		} catch (e) {
			const err = e as PrinterError;
			this.setError(err.code === 'cancelled' ? 'Printing cancelled' : err.message);
			throw e;
		} finally {
			this.abort = null;
			if (this.state === 'printing') this.state = 'ready';
			this.progress = null;
			this.lastMediaAt = 0;
			void this.poll();
		}
	}

	cancel() {
		this.abort?.abort();
	}
}

export const printer = new PrinterStore();
