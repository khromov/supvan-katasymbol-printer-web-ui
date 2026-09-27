/** Lucide icons: lazy-loaded icon nodes + tags, search, canvas and SVG rendering. */

type Attrs = Record<string, string>;
export type IconNode = [tag: string, attrs: Attrs][];

let nodes: Record<string, IconNode> | null = null;
let tags: Record<string, string[]> | null = null;
let loading: Promise<void> | null = null;
const pathCache = new Map<string, { path: Path2D; fill: boolean }[]>();

export function loadIcons(): Promise<void> {
	loading ??= Promise.all([import('lucide-static/icon-nodes.json'), import('lucide-static/tags.json')]).then(([n, t]) => {
		nodes = (n.default ?? n) as unknown as Record<string, IconNode>;
		tags = (t.default ?? t) as unknown as Record<string, string[]>;
	});
	return loading;
}

export const iconsLoaded = () => nodes !== null;

export function iconNames(): string[] {
	return nodes ? Object.keys(nodes) : [];
}

/** Rank icons by name/tag match. Empty query returns a popular starter set. */
export function searchIcons(query: string, limit = 120): string[] {
	if (!nodes || !tags) return [];
	const q = query.trim().toLowerCase();
	if (!q) return STARTER.filter((n) => nodes![n]).slice(0, limit);
	const words = q.split(/\s+/);
	const scored: [string, number][] = [];
	for (const name of Object.keys(nodes)) {
		const t = tags[name] ?? [];
		let score = 0;
		for (const w of words) {
			let s = 0;
			if (name === w) s = 100;
			else if (name.startsWith(w)) s = 60;
			else if (name.split('-').includes(w)) s = 50;
			else if (name.includes(w)) s = 35;
			else if (t.includes(w)) s = 30;
			else if (t.some((tag) => tag.startsWith(w))) s = 20;
			else if (t.some((tag) => tag.includes(w))) s = 10;
			if (!s) {
				score = 0;
				break;
			}
			score += s;
		}
		if (score) scored.push([name, score - name.length * 0.1]);
	}
	return scored
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([n]) => n);
}

const STARTER = [
	'star', 'heart', 'home', 'house', 'box', 'package', 'archive', 'folder', 'file-text', 'tag', 'tags',
	'phone', 'mail', 'wifi', 'zap', 'plug', 'battery', 'cable', 'usb', 'cpu', 'hard-drive', 'printer',
	'wrench', 'hammer', 'scissors', 'ruler', 'paintbrush', 'lightbulb', 'flame', 'snowflake', 'droplet',
	'leaf', 'sprout', 'apple', 'coffee', 'utensils', 'cake', 'pill', 'baby', 'dog', 'cat', 'fish',
	'music', 'camera', 'gamepad-2', 'book', 'bookmark', 'calendar', 'clock', 'bell', 'key', 'lock',
	'shield', 'triangle-alert', 'info', 'check', 'x', 'arrow-up', 'arrow-right', 'recycle', 'trash-2',
	'shirt', 'car', 'bike', 'plane', 'map-pin', 'globe', 'sun', 'moon', 'cloud', 'smile', 'gift'
];

function num(a: Attrs, k: string, d = 0) {
	const v = a[k];
	return v === undefined ? d : parseFloat(v);
}

function points(s: string): number[] {
	return s
		.trim()
		.split(/[\s,]+/)
		.map(Number);
}

function toPaths(name: string) {
	const cached = pathCache.get(name);
	if (cached) return cached;
	const node = nodes?.[name];
	if (!node) return [];
	const out: { path: Path2D; fill: boolean }[] = [];
	for (const [tag, a] of node) {
		let p: Path2D;
		switch (tag) {
			case 'path':
				p = new Path2D(a.d);
				break;
			case 'circle':
				p = new Path2D();
				p.arc(num(a, 'cx'), num(a, 'cy'), num(a, 'r'), 0, Math.PI * 2);
				break;
			case 'ellipse':
				p = new Path2D();
				p.ellipse(num(a, 'cx'), num(a, 'cy'), num(a, 'rx'), num(a, 'ry'), 0, 0, Math.PI * 2);
				break;
			case 'rect': {
				p = new Path2D();
				const rx = num(a, 'rx', num(a, 'ry'));
				p.roundRect(num(a, 'x'), num(a, 'y'), num(a, 'width'), num(a, 'height'), rx);
				break;
			}
			case 'line':
				p = new Path2D();
				p.moveTo(num(a, 'x1'), num(a, 'y1'));
				p.lineTo(num(a, 'x2'), num(a, 'y2'));
				break;
			case 'polyline':
			case 'polygon': {
				p = new Path2D();
				const pts = points(a.points);
				for (let i = 0; i < pts.length; i += 2) (i ? p.lineTo : p.moveTo).call(p, pts[i], pts[i + 1]);
				if (tag === 'polygon') p.closePath();
				break;
			}
			default:
				continue;
		}
		out.push({ path: p, fill: a.fill === 'currentColor' });
	}
	pathCache.set(name, out);
	return out;
}

/** Draw an icon centered in the box (x, y, w, h), in the current canvas units. */
export function drawIcon(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, w: number, h: number, strokeWidth: number, ink: string) {
	const paths = toPaths(name);
	if (!paths.length) return;
	const s = Math.min(w, h) / 24;
	ctx.save();
	ctx.translate(x + (w - 24 * s) / 2, y + (h - 24 * s) / 2);
	ctx.scale(s, s);
	ctx.lineWidth = strokeWidth;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.strokeStyle = ink;
	ctx.fillStyle = ink;
	for (const { path, fill } of paths) {
		if (fill) ctx.fill(path);
		ctx.stroke(path);
	}
	ctx.restore();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function iconSvg(name: string, size = 24, strokeWidth = 2): string {
	const node = nodes?.[name];
	if (!node) return '';
	const children = node
		.map(([tag, a]) => `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${esc(String(v))}"`).join(' ')}/>`)
		.join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;
}
