import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  // Preact 只用于 popup / login-window，页内角标与面板仍是原生 DOM
  vite: () => ({
    plugins: [preact()],
  }),

  /**
   * ## `build:manifestGenerated` 钩子已删除（2026-11-10，ADR 0033 阶段 4）
   *
   * 它原来只做一件事：把 `manifest.options_ui.open_in_tab` 补回 `true`。
   * WXT 生成 manifest 时会用**入口自己的** `openInTab` 覆盖它
   * （`openInTab: options.options.openInTab ?? false`），而 HTML 入口没地方声明。
   *
   * **options 页已废除**（功能全部迁入页内面板），所以：
   *   - manifest 里不再有 `options_ui`
   *   - 这个钩子没有作用对象，删掉
   *
   * ⚠️ 若将来加回任何 `options_ui`，必须把钩子一起加回来 ——
   * 否则它会静默变成 `open_in_tab: false`，用一个挤爆布局的小弹窗打开。
   */

  manifest: {
    name: 'Pluma',
    description: 'B站助手 · 画质与净化',
    /**
     * ⚠️ **每段上限 65535**（Chrome 扩展版本号规范）。
     * 别把日期往里塞（`20261026` 超限，装不上）。
     *
     * `1.0.0` = 首个稳定版：番剧 / 国创 / 电影已进发行包，六条验收与 PGC 三条
     * 都在 1.0.0 的构建上真机重跑过（`docs/guides/v1-acceptance-checklist.md`）。
     * `0.9.0` 曾表示「v1 范围已落地但仍在观察期」。
     * 与白名单修订号（`ROUTES_REVISION`）**是两个号，不同步变化**。
     */
    version: '1.1.0',
    minimum_chrome_version: '120',
    // ⚠️ 声明 action 是必须的，否则工具栏图标不绑定任何行为、点了毫无反应也不报错。
    // P2 起加了 default_popup：**有 popup 时 `chrome.action.onClicked` 不再触发**，
    // 所以登录入口必须放在 popup 里（原 P1 的"点图标直接开登录窗口"已移除）。
    //
    // `default_icon` 与顶层 `icons` 是**两份不同的图**，都要给：
    //   - `icons` 用于扩展管理页 / 商店列表 / 权限提示（最大用 128）
    //   - `action.default_icon` 用于**工具栏**，实际只渲染 16（高分屏 32）
    // 少写 `default_icon` 时 Chrome 会退回用 `icons` 里的图，但 Edge 在部分版本会
    // 显示成灰色拼图占位 —— 所以两份都显式写。
    //
    // 路径不带 `public/`：`public/` 下的内容会被原样复制到产物根目录，
    // 所以仓库里的 `public/icon/16.png` 在 manifest 里是 `icon/16.png`。
    // 图标母版（1920×1920，带 alpha）在 `assets/icon-source.png`，那四个 PNG 是它的
    // LANCZOS 缩放结果。母版**不要**放回 `public/`——它 600KB，会被打进 zip。
    action: {
      default_title: 'Pluma',
      default_popup: 'popup.html',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    /**
     * ## `options_ui` 已删除（2026-11-10，ADR 0033 阶段 4）
     *
     * 用户明确要求**完全废除 options 页**。原 options 的全部功能已迁入页内面板：
     *
     * | 原 options 分区 | 现在在哪 |
     * | --- | --- |
     * | 账号（配置 / 重登 / 退出） | 面板「账号」Tab |
     * | 净化（4 开关 + 9 分类） | 面板「净化」Tab + 二级浮层 |
     * | 显示（角标开关） | 面板「净化」Tab 底部 |
     * | 诊断（自检 / 日志 / 导出） | 面板「净化 ▸ 诊断」二级浮层 |
     *
     * ⚠️ **诊断不能丢**：它曾是排查 InPrivate 权限的**唯一入口**。
     * 现在那个入口是面板的「诊断」浮层 —— 改动那里之前先想清楚。
     */
    // split = 无痕窗口有自己的 background 实例。
    //   必须用 split：只有它允许把扩展自己的页面加载到无痕标签页主 frame
    //   （spanning 模式官方明确禁止这一点，而我们需要在无痕窗口里显示二维码页）。
    //   代价：两个进程**无法互相通信**，所以开窗动作要避开"跨分区"。
    incognito: 'split',
    // cookies：只在扫码登录那一刻读一次播放账号的 SESSDATA / bili_jct / DedeUserID
    // 原因见 ADR 0008——凭据只通过 Set-Cookie 下发（httpOnly），fetch 读不到
    permissions: ['storage', 'cookies', 'tabs', 'declarativeNetRequestWithHostAccess'],
    /**
     * ⚠️ **`live.bilibili.com` 是独立条目，不能靠 `*.bilibili.com` 覆盖**（ADR 0031）。
     *
     * 直播间的 URL 是 `live.bilibili.com/<房间号>`，加它之后
     * **安装时用户看到的权限提示会变**（"bilibili.com 和 live.bilibili.com"）。
     * 这是 ADR 0031 明示接受的代价，换来直播间的水印清理能力。
     *
     * ⚠️ 加这个域**不等于**支持直播取流：
     * `routes.ts` 里两条直播路径**必须保持 `enabled: false`**。
     * 直播间只做样式层清理（隐藏水印 logo），不换 Cookie、不发取流请求。
     */
    host_permissions: ['*://*.bilibili.com/*', '*://live.bilibili.com/*'],
    /**
     * ⚠️ 这里**没有** `web_accessible_resources`。
     *
     * 主世界脚本曾经是 `public/main-world.js` + WAR 声明 + `<script src>` 注入；
     * 现在改为 `entrypoints/main-hook.content.ts` 里 `import` 它，由 `world: 'MAIN'`
     * 的内容脚本在 `document_start` 直接注入。脚本因此不再需要对外可访问 ——
     * 留着 WAR 只会让任何 B站 页面都能 fetch 到它，且产物里多一份重复副本。
     */
  },
});
