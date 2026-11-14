import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
	base: '/', // base set to root to support custom domain.
	plugins: [vue()],
	server: {
		host: '127.0.0.1',
		port: 5173,
		strictPort: true,
		fs: {
			deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/server/private/**', '**/knowledge/**', '**/server/.env*']
		},
		proxy: {
			'/api': { target: process.env.ASK_SHUBHAM_API_PROXY || 'http://127.0.0.1:3001', changeOrigin: true }
		}
	},
	resolve: {
		alias: {
		'@': fileURLToPath(new URL('./src', import.meta.url))
		}
	}
})
