/**
 * 设置页骨架 —— 只做壳：导航 + 分区切换 + 占位说明。
 *
 * ## 为什么先只做壳
 *
 * `02-ui-spec.md` §4 的五个分区里，四个都需要还没做的能力（体检表要 Q9 校准、
 * 音质自检要 Q14、诊断要日志聚合、显示要角标开关）。先画界面等于画空壳 ——
 * P2 已经栽过一次（popup 七态做完却漏了核心区）。
 *
 * 所以这里**只铺结构**，每个分区如实写明"将要放什么"，避免后来者以为已经做完了。
 *
 * ## 路由
 *
 * 用 hash（`#/account`）而不是引入路由库：只有五个静态分区，`hashchange` 十行够用，
 * 而且 popup 将来可以直接 `chrome.tabs.create({ url: 'options.html#/quality' })` 深链。
 * **不加新依赖**（AGENTS §7）。
 */

import { render } from 'preact';
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import '@/src/design/tokens.css';
import './style.css';

import { AccountSection } from './sections/account';
import { AudioSection } from './sections/audio';
import { DiagnosticsSection } from './sections/diagnostics';
import { DisplaySection } from './sections/display';
import { QualitySection } from './sections/quality';

interface Section {
  id: string;
  label: string;
  /** 一句话说明这一页回答什么问题 —— 分区按"回答什么"切，不是按功能数量切 */
  hint: string;
  render: ComponentType;
}

const SECTIONS: Section[] = [
  { id: 'account', label: '账号', hint: '两个身份分别是谁', render: AccountSection },
  { id: 'quality', label: '画质体检', hint: '当前页解锁了什么', render: QualitySection },
  { id: 'audio', label: '音质自检', hint: '你的环境能放什么', render: AudioSection },
  { id: 'diagnostics', label: '诊断', hint: '出问题时看这里', render: DiagnosticsSection },
  { id: 'display', label: '显示', hint: '界面上显示什么', render: DisplaySection },
];

const DEFAULT_ID = 'account';

/** 从 hash 读当前分区；非法值一律回默认（不报错，避免深链写错就白屏） */
function readSectionId(): string {
  const raw = location.hash.replace(/^#\/?/, '');
  return SECTIONS.some((s) => s.id === raw) ? raw : DEFAULT_ID;
}

function App() {
  const [activeId, setActiveId] = useState<string>(readSectionId);

  useEffect(() => {
    const onHash = (): void => setActiveId(readSectionId());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const active = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0];
  const Body = active?.render ?? AccountSection;

  return (
    <div class="page">
      <header class="head">
        <div class="brand">
          Pluma <span class="brand-sub">B站双账号画质助手</span>
        </div>
        <div class="head-hint">{active?.hint}</div>
      </header>

      <div class="layout">
        <nav class="nav" aria-label="设置分区">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              class={`nav-item ${s.id === activeId ? 'active' : ''}`}
              href={`#/${s.id}`}
              aria-current={s.id === activeId ? 'page' : undefined}
            >
              {s.label}
            </a>
          ))}
        </nav>

        <main class="content">
          <Body />
        </main>
      </div>

      <footer class="foot">
        <span>主账号无需配置，自动沿用浏览器当前登录状态</span>
        <span class="ver">v{chrome.runtime.getManifest().version}</span>
      </footer>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
