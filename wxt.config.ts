import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  // Preact 只用于 popup / options / login-window，页内角标仍是原生 DOM
  vite: () => ({
    plugins: [preact()],
  }),

  manifest: {
    name: 'Pluma',
    description: 'B站双账号画质助手',
    version: '0.0.0',
    minimum_chrome_version: '120',
    // ⚠️ 声明 action 是必须的，否则工具栏图标不绑定任何行为、点了毫无反应也不报错。
    // P2 起加了 default_popup：**有 popup 时 `chrome.action.onClicked` 不再触发**，
    // 所以登录入口必须放在 popup 里（原 P1 的"点图标直接开登录窗口"已移除）。
    action: { default_title: 'Pluma', default_popup: 'popup.html' },
    // 把自检页注册成「扩展选项」，这样在 edge://extensions 的「详细信息」页里
    // 会有可点击的入口，不用手动拼 chrome-extension:// 地址。
    options_ui: { page: 'diagnostics.html', open_in_tab: true },
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
