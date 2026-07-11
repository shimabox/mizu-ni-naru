import { defineConfig } from 'vite';

export default defineConfig({
  // 公開先は Cloudflare の任意サブパス(裁定 A49)。base は常に相対 —
  // dist/ をそのままどのサブパスに置いても資産解決が壊れない。
  base: './',
});
