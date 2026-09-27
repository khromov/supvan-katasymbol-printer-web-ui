import {
	grantedPrinter,
	openPrinter,
	PrinterError,
	requestPrinter,
	webHidSupported,
	type Bitmap,
	type DeviceModel,
	type LabelSpec,
	type MediaInfo,
	type PrintProgress,
	type PrinterDriver,
	type PrinterStatus
} from '../printer';
import type { WebHidTransport } from '../printer/transport';
import type { Family } from '../printer/types';

const FAMILY_KEY = 'katasymbol-web:family';
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

const STATUS_INTERVAL = 2500;
const MEDIA_INTERVAL = 6000;

class PrinterStore {
	supported = webHidSupported();
	state = $state<ConnState>('disconnected');
	model = $state<DeviceModel | null>(null);
	status = $state<PrinterStatus | null>(null);
	media = $state<MediaInfo | null>(null);
	progress = $state<PrintProgress | null>(null);
	error = $state<string | null>(null);
	lastPrintOk = $state(false);
	/** Family to design for while no printer is connected. */
	preferredFamily = $state<Family>(readFamily());

	private driver: PrinterDriver | null = null;
	private transport: WebHidTransport | null = null;
	private device: HIDDevice | null = null;
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

	init() {
		if (!this.supported) return;
		navigator.hid.addEventListener('disconnect', (e) => {
			if (e.device === this.device) this.teardown('Printer disconnected');
		});
		navigator.hid.addEventListener('connect', () => {
			if (this.state === 'disconnected') void this.autoConnect();
		});
		void this.autoConnect();
	}

	async autoConnect() {
		try {
			const d = await grantedPrinter();
			if (d) await this.open(d);
		} catch (e) {
			console.warn('auto connect failed', e);
		}
	}

	async connect() {
		this.error = null;
		try {
			const d = await requestPrinter();
			if (d) await this.open(d);
		} catch (e) {
			if ((e as Error)?.name === 'NotFoundError') return; // chooser dismissed
			this.error = (e as Error).message;
			this.state = 'disconnected';
		}
	}

	private async open(device: HIDDevice) {
		if (this.connected) await this.disconnect();
		this.state = 'connecting';
		this.error = null;
		try {
			const { model, driver, transport } = await openPrinter(device);
			this.device = device;
			this.model = model;
			this.driver = driver;
			this.transport = transport;
			this.state = 'ready';
			this.lastMediaAt = 0;
			await this.poll();
		} catch (e) {
			this.error = (e as Error).message;
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
		this.model = null;
		this.status = null;
		this.media = null;
		this.progress = null;
		this.state = 'disconnected';
		this.error = error;
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

	async print(pages: Bitmap[], label: LabelSpec, opts: { density: number; copies: number; cutType?: number }) {
		const driver = this.driver;
		if (!driver) throw new PrinterError('Connect a printer first', 'disconnected');
		if (this.state === 'printing') throw new PrinterError('Already printing', 'busy');
		this.stopPolling();
		// Let an in-flight poll finish so no status request interleaves with the print job.
		while (this.polling) await new Promise((r) => setTimeout(r, 20));
		this.state = 'printing';
		this.error = null;
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
			this.error = err.code === 'cancelled' ? 'Printing cancelled' : err.message;
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
