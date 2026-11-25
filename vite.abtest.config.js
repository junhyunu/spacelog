// 비교 테스트용 3D 우주 빌드: npm run build:abtest
// 실제 앱(web/)을 그대로 빌드하되 서버 대신 더미 데이터를 쓰는 가짜 api(web/abtest/mockApi.js)를 끼우고,
// 결과를 파일 하나(docs/research/ab-test/universe.html)로 묶는다. JS · CSS · 서체를 모두 HTML 안에 넣어
// 서버 없이 파일을 더블클릭해도 열린다. 같은 폴더의 data.js(더미 데이터)와 spacelog-home.html(테스트 홈)과 함께 쓴다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const web = path.join(root, 'web');
const outDir = path.join(root, 'docs', 'research', 'ab-test');
const realApi = path.normalize(path.join(web, 'src', 'api.js'));
const mockApi = path.join(web, 'abtest', 'mockApi.js');

function abtest() {
  return {
    name: 'spacelog-abtest',
    enforce: 'pre',
    // web/src/api.js를 가져오는 곳은 모두 가짜 api를 받는다
    async resolveId(source, importer, options) {
      if (!importer || !/api\.js$/.test(source)) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      return r && path.normalize(r.id) === realApi ? mockApi : null;
    },
    // 시작점을 테스트용으로 바꾼다. 실제 앱의 홈 화면은 숨긴다(테스트 홈이 대신한다).
    // order: 'pre' — Vite가 <script>를 묶기 전에 바꿔야 한다(뒤에 돌면 원래 시작점이 이미 묶인다)
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // 잉크 막(#abtCover): 테스트 홈의 블랙홀 전환이 화면을 잉크로 덮은 채 넘어오므로, 이 페이지도 첫 화면부터 같은 막과
        // 무지개 고리(앱의 #veil.waiting과 같은 모양)로 시작한다. 앱의 전환이 4단계(준비)에 이르면 web/abtest/main.js가 걷는다
        const cover =
          '<style>#home .home-wrap{visibility:hidden}' +
          'html,body{background:#1a1430}' +
          '#abtCover{position:fixed;inset:0;z-index:60;background:#1a1430;display:grid;place-items:center}' +
          '#abtCover i{width:54px;height:54px;border-radius:50%;background:conic-gradient(#ffd23f,#ff5d8f,#7a6cff,#ffd23f);' +
          '-webkit-mask:radial-gradient(circle,transparent 16px,#000 17px);mask:radial-gradient(circle,transparent 16px,#000 17px);animation:abtSpin .8s linear infinite}' +
          '@keyframes abtSpin{to{transform:rotate(1turn)}}</style>';
        const out = html
          .replace('<title>spaceLog</title>', `<title>spaceLog · 우주 (비교 테스트용)</title>\n${cover}`)
          .replace('<body>', '<body>\n<div id="abtCover" aria-hidden="true"><i></i></div>')
          .replace('<script type="module" src="/src/main.js"></script>', '<script type="module" src="/abtest/main.js"></script>');
        if (!out.includes('/abtest/main.js')) throw new Error('web/index.html에서 시작 스크립트를 찾지 못했어요');
        return out;
      },
    },
  };
}

// 묶인 JS · CSS를 HTML 안에 넣고 universe.html 하나만 남긴다(Vite가 HTML을 만든 뒤에 돌아야 한다)
function inline() {
  return {
    name: 'spacelog-abtest-inline',
    enforce: 'post',
    generateBundle(_, bundle) {
      const page = bundle['index.html'];
      let html = String(page.source);
      for (const [name, item] of Object.entries(bundle)) {
        if (name === 'index.html') continue;
        const file = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (item.type === 'chunk') {
          const code = item.code.replace(/<\/script/gi, '<\\/script');
          html = html.replace(new RegExp(`<script[^>]*src="\\./${file}"[^>]*></script>`), () => `<script type="module">${code}</script>`);
        } else if (name.endsWith('.css')) {
          html = html.replace(new RegExp(`<link[^>]*href="\\./${file}"[^>]*>`), () => `<style>${String(item.source)}</style>`);
        } else {
          this.error(`HTML 안에 넣지 못한 파일이 있어요: ${name}`);
        }
        delete bundle[name];
      }
      // 더미 데이터(같은 폴더의 data.js)는 Vite가 묶지 않는 일반 스크립트라 여기서 넣는다. 모듈보다 먼저 실행된다
      html = html.replace('</head>', '<script src="data.js"></script>\n</head>');
      delete bundle['index.html'];
      this.emitFile({ type: 'asset', fileName: 'universe.html', source: html });
    },
  };
}

export default defineConfig({
  root: 'web',
  base: './',
  publicDir: false,
  plugins: [abtest(), inline()],
  build: {
    outDir,
    emptyOutDir: false, // 같은 폴더의 테스트 홈 · data.js를 지우지 않는다
    assetsInlineLimit: 100_000_000, // 서체까지 모두 CSS 안에
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { input: path.join(web, 'index.html'), output: { inlineDynamicImports: true } },
  },
});
