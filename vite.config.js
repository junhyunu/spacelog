import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // changeOrigin: false — Host 를 localhost:5173 그대로 넘겨 서버 guard 의 허용 목록과 맞춘다.
      '/api': { target: 'http://127.0.0.1:4747', changeOrigin: false },
    },
  },
  test: {
    root: projectRoot,
    include: ['server/test/**/*.test.js', 'web/src/test/**/*.test.js'],
  },
});
