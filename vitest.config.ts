import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 既定はヘッドレス(node)— sim / contract のテストは DOM なしで走り、
    // sim コアのヘッドレス性を実行レベルでも証明する。
    // DOM が必要な app 系テストはファイル先頭の
    // `// @vitest-environment jsdom` で個別に jsdom を指定する。
    environment: 'node',
    // 並行エージェントの git worktree(.claude/worktrees/ 配下のリポジトリコピー)を
    // 拾ってテストを重複計上しないための除外(node_modules 等は既定除外に含まれる)。
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
});
