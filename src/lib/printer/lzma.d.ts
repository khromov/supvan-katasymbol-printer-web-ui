declare const LZMA: {
	/** Synchronous when no callback is passed. Returns signed bytes (-128..127). */
	compress(data: Uint8Array | number[] | string, mode: number): number[];
	decompress(data: Uint8Array | number[]): Uint8Array | string;
};
export default LZMA;
