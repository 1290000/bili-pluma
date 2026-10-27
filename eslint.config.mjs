/**
 * ESLint 配置 —— 分层规则的**强制手段**，不是可选项。
 *
 * 核心职责：阻止 `core/` `shared/` 触碰浏览器 API。
 *
 * 为什么靠 ESLint 而不是只靠 code review：
 *   `core/` 的纯净性是「192 个单测能在 Node 里跑」的前提。
 *   一旦有人在 core 里写 `chrome.storage`，那个文件的测试会全挂，
 *   然后很可能有人为了"让它通过"去 mock —— 测试从此失去意义。
 *   这个塌陷过程是渐进的，靠人工审查发现不了。
 *
 * 依赖方向（docs/04-project-structure.md §0）：
 *   entrypoints → background / content → core → shared
 *
 * ⚠️ ESLint 只看**静态 import**。`globalThis.chrome` 这类隐蔽绕过
 * 由 `scripts/check-boundaries.ts` 兜底。两者互补，缺一不可。
 */

import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/** 严禁出现在 core / shared 的模块 */
const BROWSER_AND_UI_MODULES = [
  // 浏览器扩展 API
  {
    name: 'wxt/browser',
    message: 'core/shared 层禁止依赖浏览器 API，请通过接口注入（见 AGENTS.md §5.1）',
  },
  { name: 'wxt', message: 'core/shared 层禁止依赖 WXT，请通过接口注入' },
  // 各层之间不许反向依赖
  { name: '@/src/platform', message: 'upper 层不能反向依赖：core/shared 不许 import platform' },
  { name: '@/src/background', message: '不许反向依赖 background（应在 platform 注入）' },
  { name: '@/src/content', message: '不许反向依赖 content' },
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.output/**',
      '.wxt/**',
      'dist/**', // 发布产物：构建结果 + 用户解压出来的副本，不该参与 lint
      'poc/**', // Q2 是独立扩展，裸 JS，不参与主项目 lint
      'public/**', // 注入页面的裸 JS
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── 全局规则 ──
  {
    rules: {
      // 未使用变量：允许下划线开头（约定俗成的"故意不用"）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 禁止用 any 逃避类型；确实需要时写 unknown 再收窄
      '@typescript-eslint/no-explicit-any': 'error',
      // 允许空接口（用于标记协议类型）
      '@typescript-eslint/no-empty-interface': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // 禁止空 catch 块之外的 console（我们会在 SW 里用 console.warn）
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ── ★ 分层规则：core/ 与 shared/ 不许碰浏览器 ──
  {
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: BROWSER_AND_UI_MODULES,
          patterns: [
            {
              group: ['@platform/*', '@platform'],
              message: 'core/shared 不许依赖 platform（依赖只能从外往里流）',
            },
            {
              group: ['@background/*', '@/src/background/*', '@content/*', '@/src/content/*'],
              message: 'core/shared 不许依赖上层',
            },
            {
              group: ['wxt', 'wxt/*'],
              message: 'core/shared 禁止依赖 WXT',
            },
          ],
        },
      ],
      // 禁止直接引用浏览器全局对象（import 之外的另一条路）
      'no-restricted-globals': [
        'error',
        { name: 'chrome', message: 'core/shared 层禁止直接使用 chrome 全局' },
        { name: 'browser', message: 'core/shared 层禁止直接使用 browser 全局' },
      ],
    },
  },

  // ── platform/ 允许 chrome，但不许依赖上层 ──
  {
    files: ['src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@/src/background', message: 'platform 不许依赖 background' },
            { name: '@/src/content', message: 'platform 不许依赖 content' },
          ],
        },
      ],
    },
  },

  // ── 测试文件宽松一点 ──
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // ── 配置文件允许默认导出与 console ──
  {
    files: ['*.config.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // ── 检查脚本（.mjs）：Node 环境，允许 console / process ──
  // 2026-10-26 加：check-messages / check-design-imports / check-docs / verify
  // 是 Node 脚本，不是浏览器代码。不声明 globals 会报 71 个 no-undef。
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ── ★ 必须放最后：关掉与 Prettier 冲突的纯格式规则 ──
  // 分工：ESLint 管"对不对"，Prettier 管"好不好看"。
  // 两者都管缩进/换行会互相打架（一个报错、一个改回去，无限循环）。
  prettierConfig,
);
