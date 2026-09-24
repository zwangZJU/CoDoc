import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 允许从项目外引入 design-system/tokens.css
    fs: { allow: [__dirname, path.resolve(__dirname, '../design-system')] },
    // 开发期把前端请求代理到后端（1234），避免跨域
    proxy: {
      '/api': { target: 'http://localhost:1234', changeOrigin: true },
      '/collab': {
        target: 'ws://localhost:1234',
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/collab/, ''),
      },
    },
  },
  resolve: {
    alias: { '@codoc': path.resolve(__dirname, 'src') },
  },
})
