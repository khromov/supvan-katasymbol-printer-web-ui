import { G_SIGN_LABELS } from './families/g';
import { TP_CUT_TYPES, TP_DENSITY } from './families/tp';
import type { Family, LabelSpec } from './types';

export interface FamilyOptions {
	/** Omitted when the printer ignores it (SP always prints at the official default). */
	density?: { min: number; max: number; default: number };
	cutTypes?: { value: number; label: string }[];
}

const DENSITY_1_9 = { min: 1, max: 9, default: 4 };

/** Print dialog options per family and label, as exposed by the official app. */
export function familyOptions(family: Family, label?: LabelSpec): FamilyOptions {
	switch (family) {
		case 't5080':
			return { density: DENSITY_1_9 };
		case 'sp':
			return {};
		case 'tp':
		case 'tp86a':
			return { density: { ...TP_DENSITY }, cutTypes: TP_CUT_TYPES.map((c) => ({ ...c })) };
		case 'g': {
			// PcEdit's G branch: sign labels offer None/Full, then the paper type wins: gap (1) only
			// None, continuous (0) and heat-shrink tube (7) None/Line/Full.
			const none = { value: 0, label: 'None' };
			const line = { value: 1, label: 'Dotted line' };
			const full = { value: 3, label: 'Full cut' };
			let cutTypes: FamilyOptions['cutTypes'];
			if (label && G_SIGN_LABELS.has(label.id)) cutTypes = [none, full];
			if (label?.paperType === 1) cutTypes = [none];
			if (label?.paperType === 0 || label?.paperType === 7) cutTypes = [none, line, full];
			return { density: DENSITY_1_9, cutTypes };
		}
	}
}
