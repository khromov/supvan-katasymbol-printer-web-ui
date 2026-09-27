// Sends read-only status commands and dumps the raw responses.
import { NodeHidTransport } from './node-transport.ts';

const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join(' ');

function cmd(index: number, value = 0) {
	return new Uint8Array([0xc0, 0x40, (value >> 8) & 0xff, value & 0xff, index, 0x00, 0x08, 0x00]);
}

const t = await NodeHidTransport.openFirst();
console.log('opened', t.productName, t.vendorId.toString(16), t.productId.toString(16));
t.onReport((d) => console.log('  <-', d.length, hex(d)));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const [name, index] of [
	['INQUIRY_STA 0x11', 0x11],
	['RETURN_MAT 0x30', 0x30],
	['INQUIRY_STA 0x11', 0x11]
] as const) {
	console.log('->', name);
	await t.sendReport(cmd(index));
	await wait(600);
}
await t.close();
