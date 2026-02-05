import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './', 
  build: {
    // 关键：构建输出到后端的 static 目录
    outDir: 'backend/static',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // 代理：让本地开发时能连上本地跑的 python server (如果有的话)
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      }
    }
  }
})