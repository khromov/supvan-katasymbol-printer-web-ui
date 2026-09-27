export type Platform = 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'other';

/** Best-effort platform detection, used only to pick which connection instructions to show. */
export function detectPlatform(): Platform {
	if (typeof navigator === 'undefined') return 'other';
	const ua = navigator.userAgent;
	// iPadOS 13+ reports a Mac user agent; touch support gives it away.
	if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
	if (/Android/.test(ua)) return 'android';
	if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
	if (/Windows/.test(ua)) return 'windows';
	if (/Linux|CrOS/.test(ua)) return 'linux';
	return 'other';
}
