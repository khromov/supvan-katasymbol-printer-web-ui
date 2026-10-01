import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
	// Relative asset URLs so the build works on GitHub Pages' /<repo>/ subpath (and anywhere else).
	base: './',
	// Serve over HTTPS with a self-signed certificate, because WebHID, Web Serial and Web Bluetooth
	// only work in secure contexts (HTTPS or localhost), e.g. when testing on a phone over the LAN.
	plugins: [svelte(), basicSsl()],
	// Listen on all interfaces so the dev server is reachable from other devices on the LAN.
	server: { host: true }
});
