import { DEFAULT_QUICK, type QuickLabel } from '../design/quick';

const KEY = 'katasymbol-web:quick';

function load(): QuickLabel {
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? { ...DEFAULT_QUICK, ...JSON.parse(raw) } : { ...DEFAULT_QUICK };
	} catch {
		return { ...DEFAULT_QUICK };
	}
}

/** The quick label being edited (remembered on this device). */
export const quick = $state<QuickLabel>(load());

export function saveQuick() {
	try {
		localStorage.setItem(KEY, JSON.stringify($state.snapshot(quick)));
	} catch {
		// Storage unavailable; the quick label just won't persist.
	}
}
