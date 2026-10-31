import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages（https://ds729.github.io/hydro-sim/）に合わせる。開発サーバーも同じパスで動かし、パスの問題を早く見つける
  base: '/hydro-sim/',
  server: { host: '127.0.0.1', port: 8123, strictPort: true },
  preview: { host: '127.0.0.1', port: 8123, strictPort: true },
  // three.js 本体だけで約 560KB あるため、警告の閾値を上げる（初回読み込みの目安は roadmap Phase 2 の 3MB）
  build: { chunkSizeWarningLimit: 1000 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
