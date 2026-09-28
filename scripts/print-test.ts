// Prints an orientation test pattern on the loaded label using the T5080 driver over node-hid.
// Usage: npx tsx scripts/print-test.ts [lengthMm widthMm paperDirection]
import { NodeHidTransport } from './node-transport.ts';
import { T5080Driver } from '../src/lib/printer/families/t5080.ts';
import type { LabelSpec } from '../src/lib/printer/types.ts';

const t = await NodeHidTransport.openFirst();
const driver = new T5080Driver(t);
driver.channel.debug = process.env.DEBUG === '1';

const media = await driver.readMedia();
console.log('media', { ...media, raw: undefined });
const status = await driver.getStatus();
console.log('status', { ...status, raw: undefined });

const [len, wid, dir] = process.argv.slice(2).map(Number);
const label: LabelSpec = {
	id: String(media?.labelId ?? 'custom'),
	name: 'test',
	lengthMm: len || media?.lengthMm || 50,
	widthMm: wid || media?.widthMm || 80,
	paperDirection: Number.isFinite(dir) ? dir : 1,
	paperType: 1,
	gap: media?.gap ?? 3,
	padding: { top: 1, bottom: 1, left: 2, right: 2 }
};
const { width: W, height: H } = driver.canvasSize(label);
const data = new Uint8Array(W * H);
const set = (x: number, y: number) => {
	if (x >= 0 && y >= 0 && x < W && y < H) data[y * W + x] = 1;
};
const rect = (x0: number, y0: number, x1: number, y1: number) => {
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y);
};
// Border 2 mm in, 3 dots thick.
const m = 16;
rect(m, m, W - m, m + 3);
rect(m, H - m - 3, W - m, H - m);
rect(m, m, m + 3, H - m);
rect(W - m - 3, m, W - m, H - m);
// Top-left marker square.
rect(m + 8, m + 8, m + 48, m + 48);
// Upward triangle at top center.
const cx = W >> 1;
for (let y = 0; y < 80; y++) rect(cx - Math.round(y * 0.75), m + 12 + y, cx + Math.round(y * 0.75) + 1, m + 13 + y);
// Stripes of 1,2,3,4,6,8 dots near the bottom.
let y = H - m - 20;
for (const th of [1, 2, 3, 4, 6, 8]) {
	y -= th + 6;
	rect(m + 20, y, W - m - 20, y + th);
}
// Vertical ruler ticks every mm on the left edge.
for (let mm = 0; mm * 8 < H; mm++) rect(m + 6, mm * 8, m + (mm % 10 === 0 ? 30 : mm % 5 === 0 ? 22 : 14), mm * 8 + 1);

console.log(`printing ${label.lengthMm}x${label.widthMm}mm (${W}x${H} dots) dir=${label.paperDirection}`);
await driver.print([{ width: W, height: H, data }], label, {
	density: 4,
	copies: 1,
	onProgress: (p) => console.log('progress', p.phase, `${p.page}/${p.pages}`)
});
console.log('done', { ...(await driver.getStatus()), raw: undefined });
await t.close();
