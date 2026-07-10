/**
 * mizu-ni-naru のアーキテクチャ境界を強制する dependency-cruiser 設定。
 * master-plan.md §6 / design-sim.md §7.4 に基づく明示的 forbidden ルール
 * (境界ルールは全て severity: 'error')。
 *
 * レイヤ構造:
 *   contract/  型と定数のみ・依存ゼロの最下層(sim と render の唯一の接点)
 *   sim/       純ロジック。DOM / three.js / npm パッケージ 完全非依存
 *   render/    three.js 隔離層(three を import できる唯一の場所)
 *   app/       合成ルート(DI)。全レイヤを組み立てる
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /* ── アーキテクチャ境界 ─────────────────────────────── */
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循環依存の禁止',
      from: {},
      to: { circular: true },
    },
    {
      name: 'contract-imports-nothing',
      severity: 'error',
      comment:
        'contract は依存ゼロの最下層 — contract 以外を一切 import しない(npm / node コア含む)',
      from: { path: '^src/contract' },
      to: { pathNot: '^src/contract' },
    },
    {
      name: 'sim-not-to-render',
      severity: 'error',
      comment:
        'sim は render(three.js 隔離層)に依存してはならない — 両者は contract 型のみで会話する',
      from: { path: '^src/sim' },
      to: { path: '^src/render' },
    },
    {
      name: 'sim-not-to-app',
      severity: 'error',
      comment: 'sim は app(合成ルート)に依存してはならない',
      from: { path: '^src/sim' },
      to: { path: '^src/app' },
    },
    {
      name: 'sim-not-to-packages',
      severity: 'error',
      comment:
        'sim はランタイム依存ゼロ(three を含む npm パッケージの import 禁止)',
      from: { path: '^src/sim' },
      to: {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-bundled',
          'npm-no-pkg',
        ],
      },
    },
    {
      name: 'render-not-to-sim',
      severity: 'error',
      comment:
        'render は sim に依存してはならない(view の型は contract から取る)',
      from: { path: '^src/render' },
      to: { path: '^src/sim' },
    },
    {
      name: 'render-not-to-app',
      severity: 'error',
      comment: 'render は app(合成ルート)に依存してはならない',
      from: { path: '^src/render' },
      to: { path: '^src/app' },
    },
    {
      name: 'three-only-in-render',
      severity: 'error',
      comment: 'three.js を import できるのは render/ のみ',
      from: { path: '^src', pathNot: '^src/render' },
      to: { path: 'node_modules/three' },
    },

    /* ── sim 内レイヤ順序(design-sim.md §9: core ← chem/physics/droplets/water
          ← bubble ← view ← MizuNiNaruSim)──────────────────────────── */
    {
      name: 'sim-core-is-base',
      severity: 'error',
      comment:
        'sim/core は sim の最下層 — core 以外の sim モジュールに依存してはならない',
      from: { path: '^src/sim/core' },
      to: { path: '^src/sim/(?!core)' },
    },
    {
      name: 'sim-mid-layering',
      severity: 'error',
      comment:
        'sim/chem・physics・droplets・water は上位レイヤ(bubble/view/MizuNiNaruSim)に依存してはならない',
      from: { path: '^src/sim/(chem|physics|droplets|water|reactions)' },
      to: { path: '^src/sim/(bubble|view|MizuNiNaruSim)' },
    },
    {
      name: 'sim-bubble-layering',
      severity: 'error',
      comment: 'sim/bubble は view / MizuNiNaruSim に依存してはならない',
      from: { path: '^src/sim/bubble' },
      to: { path: '^src/sim/(view|MizuNiNaruSim)' },
    },

    /* ── 一般衛生 ──────────────────────────────────────── */
    {
      name: 'not-to-test',
      severity: 'error',
      comment: 'プロダクションコードからテストコードへの依存禁止',
      from: {},
      to: { path: '(^tests|[.](spec|test)[.](js|mjs|cjs|ts|mts|cts)$)' },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: 'src から devDependencies への依存禁止(型宣言 .d.ts は除く)',
      from: { path: '^src' },
      to: {
        dependencyTypes: ['npm-dev'],
        pathNot: ['[.]d[.]ts$'],
      },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: '解決できないモジュールへの依存禁止',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-deprecated',
      severity: 'error',
      comment: '非推奨 npm モジュールへの依存禁止',
      from: {},
      to: { dependencyTypes: ['deprecated'] },
    },
    {
      name: 'no-duplicate-dep-types',
      severity: 'warn',
      comment:
        '同一パッケージが複数の依存種別(dependencies と devDependencies 等)に登場している',
      from: {},
      to: {
        moreThanOneDependencyType: true,
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: '参照されていない孤児モジュール(設定ファイル・型宣言は除外)',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)[.][^/]+[.](?:js|cjs|mjs|ts|cts|mts|json)$',
          '[.]d[.]ts$',
          '(^|/)tsconfig[.]json$',
          '(^|/)(?:babel|webpack)[.]config[.](?:js|cjs|mjs|ts|cts|mts|json)$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    // 型 import(import type)も依存として解析する — contract 純度の強制に必須
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)',
      },
    },
  },
};
