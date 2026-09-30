import qrcode from 'qrcode-generator';
import type { Bitmap } from '../printer/types';
import { drawIcon, loadIcons } from './icons';
import { PT_TO_MM, type Design, type DesignElement, type ImageElement, type TextElement } from './model';

const images = new Map<string, HTMLImageElement>();

function loadImage(src: string): Promise<HTMLImageElement> {
	const cached = images.get(src);
	if (cached?.complete) return Promise.resolve(cached);
	return new Promise((resolve, reject) => {
		const img = cached ?? new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		if (!cached) {
			img.src = src;
			images.set(src, img);
		}
	});
}

const fontSpec = (el: TextElement, px: number) =>
	`${el.italic ? 'italic ' : ''}${el.bold ? 700 : 400} ${px}px "${el.font}", system-ui, sans-serif`;

/** Make sure fonts, icons and images used by the design are ready for synchronous drawing. */
export async function prepareAssets(design: Design): Promise<void> {
	const jobs: Promise<unknown>[] = [];
	for (const el of design.elements) {
		if (el.type === 'text') jobs.push(document.fonts.load(fontSpec(el, 20), el.text || 'A'));
		else if (el.type === 'icon') jobs.push(loadIcons());
		else if (el.type === 'image') jobs.push(loadImage(el.src).catch(() => {}));
	}
	await Promise.all(jobs);
}

interface Layout {
	lines: string[];
	px: number;
	lineH: number;
	/** A word had to be split to fit the width. */
	broke: boolean;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): { lines: string[]; broke: boolean } {
	const out: string[] = [];
	let broke = false;
	for (const para of text.split('\n')) {
		const words = para.split(/(\s+)/);
		let line = '';
		for (const w of words) {
			const next = line + w;
			if (line && ctx.measureText(next.trimEnd()).width > maxW && w.trim()) {
				out.push(line.trimEnd());
				line = w.trimStart();
				// Break single words that are too long.
				while (ctx.measureText(line).width > maxW && line.length > 1) {
					broke = true;
					let i = line.length - 1;
					while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
					out.push(line.slice(0, i));
					line = line.slice(i);
				}
			} else line = next;
		}
		if (ctx.measureText(line.trimEnd()).width > maxW && line.trim().length > 1) broke = true;
		out.push(line.trimEnd());
	}
	return { lines: out, broke };
}

/**
 * Horizontal ink extent of a line relative to the pen position. Script and display fonts draw
 * past their advance width (e.g. Caveat's "d"), so fitting and aligning by the advance lets ink
 * spill out of the box.
 */
function inkExtent(ctx: CanvasRenderingContext2D, line: string) {
	const m = ctx.measureText(line);
	if (!line || m.actualBoundingBoxRight === undefined) return { left: 0, right: m.width, width: m.width };
	const left = m.actualBoundingBoxLeft;
	const right = m.actualBoundingBoxRight;
	return { left, right, width: Math.max(0, left + right) };
}

/**
 * Baseline of the first line, with lines stacked `lineH` apart and the block placed by `valign` on
 * the font's line box (ascent + descent). Also the ink's top and bottom: accents (Ö) and
 * descenders can reach past that box.
 */
function verticalLayout(ctx: CanvasRenderingContext2D, lines: string[], px: number, lineH: number, h: number, valign: TextElement['valign']) {
	const metrics = ctx.measureText('Hg');
	const ascent = metrics.fontBoundingBoxAscent ?? px * 0.8;
	const descent = metrics.fontBoundingBoxDescent ?? px * 0.2;
	const blockH = (lines.length - 1) * lineH + ascent + descent;
	const top = valign === 'top' ? 0 : valign === 'bottom' ? h - blockH : (h - blockH) / 2;
	const baseline = top + ascent;
	let inkTop = Infinity;
	let inkBottom = -Infinity;
	lines.forEach((line, i) => {
		if (!line) return;
		const m = ctx.measureText(line);
		const y = baseline + i * lineH;
		inkTop = Math.min(inkTop, y - (m.actualBoundingBoxAscent ?? ascent));
		inkBottom = Math.max(inkBottom, y + (m.actualBoundingBoxDescent ?? descent));
	});
	return { baseline, inkTop, inkBottom };
}

function layoutText(ctx: CanvasRenderingContext2D, el: TextElement, w: number, h: number, scale: number): Layout {
	const measure = (px: number): Layout => {
		ctx.font = fontSpec(el, px);
		return { ...wrap(ctx, el.text, w), px, lineH: px * el.lineHeight };
	};
	if (!el.fit) return measure(el.size * PT_TO_MM * scale);
	// Largest font size whose wrapped text fits the box, ink included (accents, descenders).
	let lo = 1,
		hi = Math.max(2, h * 1.2),
		best = measure(lo);
	for (let i = 0; i < 18; i++) {
		const mid = (lo + hi) / 2;
		const l = measure(mid);
		const widest = Math.max(...l.lines.map((s) => inkExtent(ctx, s).width));
		const { inkTop, inkBottom } = verticalLayout(ctx, l.lines, l.px, l.lineH, h, el.valign);
		const fits = !l.broke && l.lines.length * l.lineH - (l.lineH - l.px) <= h && widest <= w + 0.5 && inkTop >= -0.5 && inkBottom <= h + 0.5;
		if (fits) {
			best = l;
			lo = mid;
		} else hi = mid;
	}
	return best;
}

/** Graphemes that render as color emoji (default emoji presentation, VS16, flags, keycaps). */
const EMOJI = /\p{Emoji_Presentation}|\uFE0F|\p{Regional_Indicator}|\u20E3/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Split a line into alternating runs of plain text and emoji. */
function emojiRuns(line: string): { text: string; emoji: boolean }[] {
	const out: { text: string; emoji: boolean }[] = [];
	for (const { segment } of graphemes.segment(line)) {
		const emoji = EMOJI.test(segment);
		const last = out[out.length - 1];
		if (last && last.emoji === emoji) last.text += segment;
		else out.push({ text: segment, emoji });
	}
	return out;
}

/** Draws text; emoji go to `tone` (when given) so they can be dithered. Returns true if it drew any. */
function drawText(ctx: CanvasRenderingContext2D, el: TextElement, w: number, h: number, scale: number, ink: string, tone?: CanvasRenderingContext2D) {
	const { lines, px, lineH } = layoutText(ctx, el, w, h, scale);
	ctx.font = fontSpec(el, px);
	ctx.fillStyle = ink;
	ctx.textBaseline = 'alphabetic';
	if (tone) {
		tone.font = ctx.font;
		tone.fillStyle = ink;
		tone.textBaseline = 'alphabetic';
	}
	let y = verticalLayout(ctx, lines, px, lineH, h, el.valign).baseline;
	let drewTone = false;
	for (const line of lines) {
		// Align by ink, so overhanging glyphs stay inside the box and script fonts center visually.
		const inkX = inkExtent(ctx, line);
		const x = el.align === 'left' ? inkX.left : el.align === 'right' ? w - inkX.right : (w - inkX.width) / 2 + inkX.left;
		if (tone && EMOJI.test(line)) {
			let cx = x;
			for (const run of emojiRuns(line)) {
				(run.emoji ? tone : ctx).fillText(run.text, cx, y);
				cx += ctx.measureText(run.text).width;
				drewTone ||= run.emoji;
			}
		} else ctx.fillText(line, x, y);
		if (el.underline && line) {
			const t = Math.max(1, px * 0.07);
			ctx.fillRect(x - inkX.left, y + px * 0.12, inkX.width, t);
		}
		y += lineH;
	}
	return drewTone;
}

function drawQr(ctx: CanvasRenderingContext2D, value: string, w: number, h: number, ink: string) {
	const qr = qrcode(0, 'M');
	qr.addData(value || ' ');
	qr.make();
	const n = qr.getModuleCount();
	const size = Math.min(w, h);
	// Snap modules to whole device pixels so printed modules have equal size.
	const t = ctx.getTransform();
	const devScale = Math.hypot(t.a, t.b) || 1;
	const modDev = Math.max(1, Math.floor((size * devScale) / n));
	const mod = modDev / devScale;
	const ox = (w - mod * n) / 2;
	const oy = (h - mod * n) / 2;
	ctx.fillStyle = ink;
	for (let r = 0; r < n; r++)
		for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(ox + c * mod, oy + r * mod, mod + 0.01, mod + 0.01);
}

const processedImages = new Map<string, HTMLCanvasElement>();

function processImage(el: ImageElement, img: HTMLImageElement, wPx: number, hPx: number, invert: boolean) {
	const key = `${el.src.length}:${el.src.slice(-64)}:${wPx}x${hPx}:${el.threshold}:${el.dither}:${invert}`;
	const hit = processedImages.get(key);
	if (hit) return hit;
	const c = document.createElement('canvas');
	c.width = Math.max(1, wPx);
	c.height = Math.max(1, hPx);
	const cx = c.getContext('2d', { willReadFrequently: true })!;
	cx.fillStyle = '#fff';
	cx.fillRect(0, 0, c.width, c.height);
	cx.drawImage(img, 0, 0, c.width, c.height);
	const d = cx.getImageData(0, 0, c.width, c.height);
	const gray = new Float32Array(c.width * c.height);
	for (let i = 0; i < gray.length; i++) gray[i] = d.data[i * 4] * 0.3 + d.data[i * 4 + 1] * 0.59 + d.data[i * 4 + 2] * 0.11;
	for (let y = 0; y < c.height; y++) {
		for (let x = 0; x < c.width; x++) {
			const i = y * c.width + x;
			const old = gray[i];
			const on = old < el.threshold;
			if (el.dither) {
				const err = old - (on ? 0 : 255);
				if (x + 1 < c.width) gray[i + 1] += (err * 7) / 16;
				if (y + 1 < c.height) {
					if (x > 0) gray[i + c.width - 1] += (err * 3) / 16;
					gray[i + c.width] += (err * 5) / 16;
					if (x + 1 < c.width) gray[i + c.width + 1] += err / 16;
				}
			}
			const black = on !== invert;
			const v = black ? 0 : 255;
			d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v;
			d.data[i * 4 + 3] = black ? 255 : 0;
		}
	}
	cx.clearRect(0, 0, c.width, c.height);
	cx.putImageData(d, 0, 0);
	if (processedImages.size > 40) processedImages.clear();
	processedImages.set(key, c);
	return c;
}

/**
 * Draw one element. Continuous-tone content (emoji) goes to `tone` when given, so the caller can
 * dither it instead of thresholding. Returns true if anything was drawn to `tone`.
 */
let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * Font size (mm) a fitted text element gets in its box, as drawn at `dpmm`; 0 for other elements
 * and empty text. For sizing a label around its text; fonts must be loaded (prepareAssets).
 */
export function fittedTextSize(el: DesignElement, dpmm: number): number {
	if (el.type !== 'text' || !el.fit || !el.text.trim()) return 0;
	measureCtx ??= document.createElement('canvas').getContext('2d')!;
	const quarter = el.rotation === 90 || el.rotation === 270;
	const w = (quarter ? el.h : el.w) * dpmm;
	const h = (quarter ? el.w : el.h) * dpmm;
	return layoutText(measureCtx, el, w, h, dpmm).px / dpmm;
}

/**
 * Width (mm) of a fitted text element's widest line, ink or advance, whichever is wider; 0 for
 * other elements and empty text. A box this wide (plus a little) keeps the same font size.
 */
export function fittedTextWidth(el: DesignElement, dpmm: number): number {
	if (el.type !== 'text' || !el.fit || !el.text.trim()) return 0;
	measureCtx ??= document.createElement('canvas').getContext('2d')!;
	const ctx = measureCtx;
	const quarter = el.rotation === 90 || el.rotation === 270;
	const { lines, px } = layoutText(ctx, el, (quarter ? el.h : el.w) * dpmm, (quarter ? el.w : el.h) * dpmm, dpmm);
	ctx.font = fontSpec(el, px);
	return Math.max(0, ...lines.map((l) => Math.max(inkExtent(ctx, l).width, ctx.measureText(l).width))) / dpmm;
}

function drawElement(ctx: CanvasRenderingContext2D, el: DesignElement, scale: number, tone?: CanvasRenderingContext2D): boolean {
	const quarter = el.rotation === 90 || el.rotation === 270;
	const w = (quarter ? el.h : el.w) * scale;
	const h = (quarter ? el.w : el.h) * scale;
	let drewTone = false;
	for (const c of tone ? [ctx, tone] : [ctx]) {
		c.save();
		c.translate((el.x + el.w / 2) * scale, (el.y + el.h / 2) * scale);
		c.rotate((el.rotation * Math.PI) / 180);
		c.translate(-w / 2, -h / 2);
	}
	const invert = !!el.invert;
	const ink = invert ? '#fff' : '#000';
	if (invert) {
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, w, h);
	}
	switch (el.type) {
		case 'text':
			drewTone = drawText(ctx, el, w, h, scale, ink, el.ditherEmoji === false ? undefined : tone);
			break;
		case 'icon':
			drawIcon(ctx, el.name, 0, 0, w, h, el.strokeWidth, ink);
			break;
		case 'shape': {
			const t = Math.max(0.1, el.thickness) * scale;
			ctx.fillStyle = ink;
			ctx.strokeStyle = ink;
			ctx.lineWidth = t;
			if (el.shape === 'line' && el.dashed) {
				// Dashes twice the thickness (at least 0.6 mm) with equal gaps.
				const dash = Math.max(t * 2, 0.6 * scale);
				for (let x = 0; x < w; x += dash * 2) ctx.fillRect(x, (h - t) / 2, Math.min(dash, w - x), t);
			} else if (el.shape === 'line') {
				ctx.fillRect(0, (h - t) / 2, w, t);
			} else {
				const p = new Path2D();
				if (el.shape === 'rect') p.roundRect(t / 2, t / 2, w - t, h - t, Math.max(0, el.radius * scale - t / 2));
				else p.ellipse(w / 2, h / 2, Math.max(0, w / 2 - t / 2), Math.max(0, h / 2 - t / 2), 0, 0, Math.PI * 2);
				if (el.fill) ctx.fill(p);
				else ctx.stroke(p);
			}
			break;
		}
		case 'qr':
			drawQr(ctx, el.value, w, h, ink);
			break;
		case 'image': {
			const img = images.get(el.src);
			if (img?.complete && img.naturalWidth) {
				const t = ctx.getTransform();
				const devScale = Math.hypot(t.a, t.b) || 1;
				const processed = processImage(el, img, Math.round(w * devScale), Math.round(h * devScale), invert);
				ctx.imageSmoothingEnabled = false;
				ctx.drawImage(processed, 0, 0, w, h);
			} else void loadImage(el.src);
			break;
		}
	}
	ctx.restore();
	tone?.restore();
	return drewTone;
}

/** Draw the design with `scale` canvas units per mm onto a white background. */
export function renderDesign(ctx: CanvasRenderingContext2D, design: Design, widthMm: number, heightMm: number, scale: number) {
	ctx.save();
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, widthMm * scale, heightMm * scale);
	for (const el of design.elements) drawElement(ctx, el, scale);
	ctx.restore();
}

/** Pixel rect (clamped) an element can paint into, with room for strokes and overflowing text. */
function elementRect(el: DesignElement, dpmm: number, width: number, height: number) {
	if (el.type === 'text' && !el.fit) return { x: 0, y: 0, w: width, h: height };
	const m = Math.max(4, Math.max(el.w, el.h) * dpmm * 0.1);
	const x = Math.max(0, Math.floor(el.x * dpmm - m));
	const y = Math.max(0, Math.floor(el.y * dpmm - m));
	const x2 = Math.min(width, Math.ceil((el.x + el.w) * dpmm + m));
	const y2 = Math.min(height, Math.ceil((el.y + el.h) * dpmm + m));
	return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

/** The official app's cut-off: opaque pixels darker than 180 print. */
const THRESHOLD = 180;
/**
 * Default gamma applied before dithering emoji. Values above 1 darken mid-tones so pastel emoji
 * colors still get enough dots on thermal paper. Saturation weighting does most of the darkening;
 * a high gamma on top of it turns saturated reds solid black.
 */
export const DEFAULT_EMOJI_GAMMA = 1.15;

/** How much color saturation darkens dithered tones (yellow/pastel emoji are bright but colorful). */
const SATURATION_WEIGHT = 0.45;

interface ToneOptions {
	gamma: number;
	/** Force a 1-dot outline where the layer's shapes meet transparency. */
	outline: boolean;
}

/**
 * Composite one rendered layer over `bits`. Partially transparent pixels blend with the dots
 * already there. Line art is thresholded like the official app. Tone layers (emoji) are mapped
 * so saturated colors count as darker, gamma adjusted, optionally outlined, then dithered with
 * Atkinson error diffusion restricted to the pixels the layer covers.
 */
function composite(bits: Uint8Array, width: number, img: ImageData, r: { x: number; y: number; w: number; h: number }, tone?: ToneOptions) {
	const { data } = img;
	const n = r.w * r.h;
	const v = new Float32Array(n);
	const alpha = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const a = data[i * 4 + 3] / 255;
		alpha[i] = a;
		if (a < 0.04) continue;
		const idx = (r.y + Math.floor(i / r.w)) * width + r.x + (i % r.w);
		const R = data[i * 4];
		const G = data[i * 4 + 1];
		const B = data[i * 4 + 2];
		let gray = R * 0.3 + G * 0.59 + B * 0.11;
		if (tone) {
			const max = Math.max(R, G, B);
			const sat = max ? (max - Math.min(R, G, B)) / max : 0;
			gray *= 1 - SATURATION_WEIGHT * sat;
			if (tone.gamma !== 1) gray = 255 * Math.pow(gray / 255, tone.gamma);
		}
		v[i] = gray * a + (bits[idx] ? 0 : 255) * (1 - a);
	}
	const covered = (x: number, y: number) => x >= 0 && y >= 0 && x < r.w && y < r.h && alpha[y * r.w + x] >= 0.5;
	const spread = (x: number, y: number, e: number) => {
		if (x < 0 || x >= r.w || y >= r.h) return;
		const j = y * r.w + x;
		if (alpha[j] >= 0.04) v[j] += e;
	};
	for (let y = 0; y < r.h; y++) {
		for (let x = 0; x < r.w; x++) {
			const i = y * r.w + x;
			if (alpha[i] < 0.04) continue;
			const idx = (r.y + y) * width + r.x + x;
			if (!tone) {
				bits[idx] = v[i] < THRESHOLD ? 1 : 0;
				continue;
			}
			const edge = tone.outline && alpha[i] >= 0.5 && !(covered(x - 1, y) && covered(x + 1, y) && covered(x, y - 1) && covered(x, y + 1));
			const on = edge || v[i] < 128;
			bits[idx] = on ? 1 : 0;
			if (edge) continue;
			const e = (v[i] - (on ? 0 : 255)) / 8;
			spread(x + 1, y, e);
			spread(x + 2, y, e);
			spread(x - 1, y + 1, e);
			spread(x, y + 1, e);
			spread(x + 1, y + 1, e);
			spread(x, y + 2, e);
		}
	}
}

function layer(width: number, height: number) {
	const c = document.createElement('canvas');
	c.width = width;
	c.height = height;
	return c.getContext('2d', { willReadFrequently: true })!;
}

/**
 * Render to a printer bitmap of exactly `width` x `height` dots. Elements are composited one at a
 * time in stacking order: line art (text, icons, shapes, QR) is thresholded like the official app,
 * emoji are dithered so their shading survives, images carry their own threshold/dither setting.
 */
export async function renderBitmap(design: Design, _widthMm: number, _heightMm: number, width: number, height: number, dpmm: number): Promise<Bitmap> {
	await prepareAssets(design);
	const line = layer(width, height);
	const tone = layer(width, height);
	const bits = new Uint8Array(width * height);
	for (const el of design.elements) {
		const r = elementRect(el, dpmm, width, height);
		if (!r) continue;
		line.clearRect(0, 0, width, height);
		tone.clearRect(0, 0, width, height);
		const hasTone = drawElement(line, el, dpmm, tone);
		composite(bits, width, line.getImageData(r.x, r.y, r.w, r.h), r);
		if (hasTone && el.type === 'text') {
			composite(bits, width, tone.getImageData(r.x, r.y, r.w, r.h), r, {
				gamma: el.emojiGamma ?? DEFAULT_EMOJI_GAMMA,
				outline: el.emojiOutline !== false
			});
		}
	}
	return { width, height, data: bits };
}

export function bitmapToCanvas(bmp: Bitmap, canvas: HTMLCanvasElement, ink = [17, 17, 17], paper = [255, 255, 255]) {
	canvas.width = bmp.width;
	canvas.height = bmp.height;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(bmp.width, bmp.height);
	for (let i = 0; i < bmp.data.length; i++) {
		const c = bmp.data[i] ? ink : paper;
		img.data[i * 4] = c[0];
		img.data[i * 4 + 1] = c[1];
		img.data[i * 4 + 2] = c[2];
		img.data[i * 4 + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
}
