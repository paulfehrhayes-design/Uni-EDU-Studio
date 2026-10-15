import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './', 
  build: {
    // 关键：构建输出到后端的 static 目录
    outDir: 'backend/static',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // 代理：让本地开发时能连上本地跑的 python server
      '/api': {
        target: 'http://127.0.0.1:5179',
        changeOrigin: true,
        ws: true,
      }
    }
  }
})