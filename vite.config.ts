import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
	// Relative asset URLs so the build works on GitHub Pages' /<repo>/ subpath (and anywhere else).
	base: './',
	// `npm run dev:lan` serves over HTTPS with a self-signed certificate, because WebHID and
	// Web Serial only work in secure contexts (HTTPS or localhost), e.g. for testing on a phone.
	plugins: [svelte(), ...(process.env.HTTPS ? [basicSsl()] : [])],
	// Listen on all interfaces so the dev server is reachable from other devices on the LAN.
	server: { host: true }
});
