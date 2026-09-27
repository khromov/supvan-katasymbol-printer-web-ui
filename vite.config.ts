import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
	// Relative asset URLs so the build works on GitHub Pages' /<repo>/ subpath (and anywhere else).
	base: './',
	plugins: [svelte()]
});
