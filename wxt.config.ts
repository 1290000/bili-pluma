import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  // Preact 只用于 popup / options / login-window，页内角标仍是原生 DOM
  vite: () => ({
    plugins: [preact()],
  }),

  /**
   * `options_ui.open_in_tab` 只能在这里补。
   *
   * WXT 生成 manifest 时会用**入口自己的** `openInTab` 覆盖 `manifest.options_ui`
   * （见 `node_modules/wxt/dist/core/utils/manifest.mjs`：`openInTab: options.options.openInTab ?? false`），
   * 而 HTML 入口没有地方声明这个选项 —— 结果写在 `manifest.options_ui` 里的
   * `open_in_tab: true` 会被冲成 `false`（2026-10-26 实测：构建产物就是 false）。
   *
   * 后果不小：`false` 时 Edge 用一个小弹窗打开设置页，五分区侧栏布局直接挤爆。
   * 所以必须用 `build:manifestGenerated` 钩子在生成之后改回来。
   */
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      if (manifest.options_ui) manifest.options_ui.open_in_tab = true;
    },
  },

  manifest: {
    name: 'Pluma',
    description: 'B站双账号画质助手',
    version: '0.0.0',
    minimum_chrome_version: '120',
    // ⚠️ 声明 action 是必须的，否则工具栏图标不绑定任何行为、点了毫无反应也不报错。
    // P2 起加了 default_popup：**有 popup 时 `chrome.action.onClicked` 不再触发**，
    // 所以登录入口必须放在 popup 里（原 P1 的"点图标直接开登录窗口"已移除）。
    action: { default_title: 'Pluma', default_popup: 'popup.html' },
    // 设置页（五分区）。原先是把自检页挂成选项页 —— 自检页仍然保留，
    // 从「诊断」分区里的按钮打开（新标签页）。
    // ⚠️ `open_in_tab` 写在这里**不生效**，见上面的 hooks 注释。
    // ⚠️ 改这一行后必须在 edge://extensions 里实际点一次「扩展选项」，
    // 因为自检页是排查 InPrivate 权限的唯一入口，改错了等于把排障手段弄丢。
    options_ui: { page: 'options.html', open_in_tab: true },
    // split = 无痕窗口有自己的 background 实例。
    //   必须用 split：只有它允许把扩展自己的页面加载到无痕标签页主 frame
    //   （spanning 模式官方明确禁止这一点，而我们需要在无痕窗口里显示二维码页）。
    //   代价：两个进程**无法互相通信**，所以开窗动作要避开"跨分区"。
    incognito: 'split',
    // cookies：只在扫码登录那一刻读一次播放账号的 SESSDATA / bili_jct / DedeUserID
    // 原因见 ADR 0007——凭据只通过 Set-Cookie 下发，fetch 读不到
    permissions: ['storage', 'cookies', 'tabs', 'declarativeNetRequestWithHostAccess'],
    host_permissions: ['*://*.bilibili.com/*'],
    // 主世界脚本必须以**文件**形式注入，不能用内联 <script>：
    // MV3 默认 CSP 禁止执行内联脚本，内联方式会被静默拦截
    // （踩过：注入返回成功但脚本从未执行，page/quality 有记录而主世界零输出）。
    web_accessible_resources: [
      {
        resources: ['main-world.js'],
        matches: ['*://*.bilibili.com/*'],
      },
    ],
  },
});
