// 체험판(서버 없는 공개 데모) 빌드: npm run build:demo → dist-demo/ (Vercel 정적 배포, vercel.json)
// 실제 앱(web/)을 그대로 빌드하되 web/src/api.js 를 브라우저 안 가짜 서버(web/demo/mockApi.js)로 바꿔 끼우고,
// 시작점을 web/demo/main.js(데모 계정 · 안내 띠 · 처음 상태로)로 바꾼다. vite.abtest.config.js 와 같은 방식이지만
// 한 파일로 묶지 않는 보통 빌드다(해시 이름의 여러 파일).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const web = path.join(root, 'web');
const realApi = normalizePath(path.join(web, 'src', 'api.js'));
const mockApi = normalizePath(path.join(web, 'demo', 'mockApi.js'));

function demo() {
  return {
    name: 'spacelog-demo',
    enforce: 'pre',
    // web/src/api.js 를 가져오는 곳은 모두 가짜 api 를 받는다
    async resolveId(source, importer, options) {
      if (!importer || !/api\.js$/.test(source)) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      return r && normalizePath(r.id) === realApi ? mockApi : null;
    },
    // 시작점을 체험판용으로. order: 'pre' — Vite 가 <script>를 묶기 전에 바꿔야 한다
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const out = html
          .replace('<title>spaceLog</title>', '<title>spaceLog 체험판</title>')
          .replace('<script type="module" src="/src/main.js"></script>', '<script type="module" src="/demo/main.js"></script>');
        if (!out.includes('/demo/main.js')) throw new Error('web/index.html에서 시작 스크립트를 찾지 못했어요');
        if (!out.includes('<title>spaceLog 체험판</title>')) throw new Error('web/index.html에서 <title>을 찾지 못했어요');
        return out;
      },
    },
  };
}

export default defineConfig({
  root: 'web',
  base: './',
  publicDir: false,
  plugins: [demo()],
  build: {
    outDir: path.join(root, 'dist-demo'),
    emptyOutDir: true,
    rollupOptions: { input: path.join(web, 'index.html') },
  },
  preview: { port: 4850, strictPort: true },
});
