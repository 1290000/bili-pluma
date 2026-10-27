/**
 * 「需要开启 InPrivate 权限」说明页。
 *
 * ## 为什么它可能会自己关掉
 *
 * split 模式下普通/无痕 background 是两个互不通信的实例，都会收到图标点击。
 * 通常的情况是：**无痕实例成功开出了二维码窗口，普通实例没开成**，
 * 于是这个说明页被误弹。
 *
 * 所以这里做两件事：
 *   1. 监听 `pluma:login-ready` —— 一旦二维码窗口就绪，**自动关闭自己**
 *   2. 超过 8 秒仍未就绪 → 保留在屏幕上，此时说明确实没有权限
 *
 * 用户看到的效果：说明页闪一下 → 二维码窗口出现 → 说明页消失。
 */

import { readLoginReady, watchForLoginReady } from '@/src/background/login-handshake';

import '@/src/design/tokens.css';
import './style.css';

const tipEl = document.getElementById('auto-tip');

/** 已经在别的实例里成功了 → 关掉自己 */
function closeIfReadyElsewhere(): void {
  if (!tipEl) return;

  watchForLoginReady(() => {
    // 二维码窗口出现了，说明这个说明页是误弹的
    window.close();
  });

  // 如果进页面时就已经就绪（时序错开），直接关
  void readLoginReady().then((m) => {
    if (m) window.close();
  });

  // 8 秒后还没就绪 → 说明权限确实没开，把提示高亮出来
  window.setTimeout(() => {
    void readLoginReady().then((m) => {
      if (m) return;
      // 只说"还没开成"，不再复述步骤 —— 上面就是步骤列表
      tipEl.textContent = '登录窗口还没打开 —— 上面的权限应该没生效，开完记得重新点图标。';
      tipEl.classList.add('show');
    });
  }, 8000);
}

closeIfReadyElsewhere();
