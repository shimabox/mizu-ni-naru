import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages デプロイ時はリポジトリ名をベースパスにする(Mizu シリーズ踏襲)
  base: process.env.GITHUB_PAGES ? '/mizu-ni-naru/' : './',
});
