// A stand-in E10/T10-series printer on a byte transport, for testing the T15 driver without
// hardware. Mirrors scripts/suprint-oracle/harness/Emu.java, which runs the SUPRINT app's own print
// code, byte for byte: both answer the same way, so both sides must send the same bytes.
//
// State only changes on commands, never on time: never busy, START sets printing, the buffer is
// never full, and the BUF_FULL that commits a buffer with the job-end flag clears printing.
import LZMA from '../src/lib/printer/lzma.js';
import type { ByteTransport } from '../src/lib/printer/serial.ts';

const u16 = (f: Uint8Array, at: number) => f[at] | (f[at + 1] << 8);
const sum = (f: Uint8Array, from: number, to: number) => {
	let s = 0;
	for (let i = from; i < to; i++) s += f[i];
	return s & 0xffff;
};

export class T15Emulator implements ByteTransport {
	readonly name = 'emulator';
	/** Every write, as sent. */
	readonly writes: Uint8Array[] = [];
	/** Commands as "cmd <hex> <a> <b>", like the Java side's events. */
	readonly events: string[] = [];
	/** LZMA streams as committed by BUF_FULL, and what they decode to. */
	readonly streams: Uint8Array[] = [];
	readonly buffers: Uint8Array[] = [];
	busy = false;
	printing = false;
	/** Extra status bits OR-ed into INQUIRY bytes 0..3 (error injection). */
	extra = [0, 0, 0, 0];
	batteryMv = 4000;
	material: Uint8Array | null = null;
	private listeners = new Set<(chunk: Uint8Array) => void>();
	private pending = new Uint8Array(0);
	private stream: number[] = [];
	private expectFrames = 0;
	private gotFrames = 0;

	constructor(public deviceName = 'T0126E2507010001') {}

	onData(listener: (chunk: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close() {
		this.listeners.clear();
	}

	async write(data: Uint8Array) {
		this.writes.push(data.slice());
		const buf = new Uint8Array(this.pending.length + data.length);
		buf.set(this.pending);
		buf.set(data, this.pending.length);
		let i = 0;
		while (buf.length - i >= 4) {
			if (buf[i] !== 0x7e || buf[i + 1] !== 0x5a) throw new Error(`bad frame start at ${i}`);
			const total = u16(buf, i + 2) + 4;
			if (buf.length - i < total) break;
			const f = buf.slice(i, i + total);
			i += total;
			this.frame(f);
		}
		this.pending = buf.slice(i);
	}

	private frame(f: Uint8Array) {
		if (f.length === 512 && f[5] === 2) return this.data(f);
		if (sum(f, 10, f.length) !== u16(f, 8)) throw new Error('bad command checksum');
		const cmd = f[7];
		const a = u16(f, 12);
		const b = f.length >= 16 ? u16(f, 14) : 0;
		this.events.push(`cmd ${cmd.toString(16).padStart(2, '0')} ${a} ${b}`);
		switch (cmd) {
			case 0x11:
				return this.reply(cmd, this.status());
			case 0x13:
				this.printing = true;
				break;
			case 0x14:
				this.printing = false;
				break;
			case 0x5c:
				if (a !== 512) throw new Error(`0x5c block size ${a}`);
				this.expectFrames = b;
				this.gotFrames = 0;
				this.stream = [];
				break;
			case 0x10:
				this.commit();
				break;
			case 0x16: {
				const p = new Uint8Array(40);
				const n = new TextEncoder().encode(this.deviceName);
				p.set(n, 12);
				return this.reply(cmd, p, 18 + n.length);
			}
			case 0x30:
				if (this.material) return this.reply(cmd, this.material);
				break;
		}
		this.reply(cmd, new Uint8Array(16));
	}

	private status() {
		const p = new Uint8Array(16);
		p[4] = this.extra[0];
		p[5] = (this.busy ? 4 : 0) | this.extra[1];
		p[6] = (this.printing ? 0x40 : 0) | this.extra[2];
		p[7] = this.extra[3];
		p[14] = this.batteryMv & 0xff;
		p[15] = (this.batteryMv >> 8) & 0xff;
		return p;
	}

	/** Reply: 7E 5A <len> 10 01 AA <cmd> <sum of [10..end]> then the payload from [10]. */
	private reply(cmd: number, payload: Uint8Array, len = payload.length + 6) {
		const r = new Uint8Array(10 + payload.length);
		r.set([0x7e, 0x5a, len & 0xff, len >> 8, 0x10, 0x01, 0xaa, cmd]);
		r.set(payload, 10);
		const s = sum(r, 10, r.length);
		r[8] = s & 0xff;
		r[9] = s >> 8;
		queueMicrotask(() => {
			for (const l of this.listeners) l(r);
		});
	}

	private data(f: Uint8Array) {
		if (f[6] !== 0xaa || f[7] !== 0xbb) throw new Error('bad data frame header');
		if (sum(f, 10, 512) !== u16(f, 8)) throw new Error('bad data checksum');
		if (f[10] !== this.gotFrames || f[11] !== this.expectFrames) throw new Error(`frame index ${f[10]}/${f[11]}`);
		this.stream.push(...f.subarray(12, 512));
		this.gotFrames++;
		this.reply(0xbb, new Uint8Array(16));
	}

	private commit() {
		if (this.gotFrames !== this.expectFrames) throw new Error(`got ${this.gotFrames} of ${this.expectFrames} frames`);
		const z = Uint8Array.from(this.stream);
		let size = 0;
		for (let k = 0; k < 4; k++) size += z[5 + k] * 2 ** (8 * k);
		const out = LZMA.decompress(z) as ArrayLike<number>;
		const raw = Uint8Array.from(out, (b) => b & 0xff);
		if (raw.length !== size) throw new Error(`LZMA stream does not decode (${raw.length} of ${size} bytes)`);
		this.streams.push(z);
		this.buffers.push(raw);
		if (raw[2] & 0x08) this.printing = false;
	}
}
