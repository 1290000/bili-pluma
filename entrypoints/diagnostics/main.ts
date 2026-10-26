/**
 * 自检页 —— 一键查看扩展当前真实状态。
 *
 * 为什么需要：InPrivate 权限 / 分区可见性这类问题，光看现象猜不出来。
 * 让用户一键打开这个页面，比反复试探快得多。
 *
 * ## 取数逻辑已抽到 `platform/diagnostics/collect.ts`
 *
 * options 的「诊断」分区显示同一批事实，两处共用一份代码 ——
 * 抄两遍必然漂移，而漂移的后果是**排障时两个页面给出不同结论**。
 *
 * ## 这个页面本身正在被取代（2026-10-26）
 *
 * 迁移顺序：先让 options 的诊断分区显示同样的数据 → 你逐行核对 →
 * 再删掉这个入口。**核对之前不要删**，它是排查 InPrivate 权限的唯一手段。
 */

import '@/src/design/tokens.css';
import './style.css';

import { collectFacts, readDiag, tipFor, type DiagRow } from '@platform/diagnostics/collect';

function renderFacts(rows: DiagRow[]): HTMLElement {
  const list = document.createElement('div');
  list.className = 'rows';

  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row';

    const k = document.createElement('span');
    k.className = 'key';
    k.textContent = r.label;

    const v = document.createElement('span');
    v.className = 'val' + (r.ok === true ? ' good' : r.ok === false ? ' bad' : '');
    v.textContent = r.value;

    row.append(k, v);
    list.appendChild(row);
  }
  return list;
}

async function render(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;

  const rows = await collectFacts();
  const logs = await readDiag();

  root.innerHTML = '';

  const h = document.createElement('h1');
  h.className = 'title';
  h.textContent = 'Pluma 自检';
  root.appendChild(h);

  root.appendChild(renderFacts(rows));

  // 诊断日志单独一块：它是"刚才发生了什么"，和状态快照不是一类东西
  const logTitle = document.createElement('h2');
  logTitle.className = 'subtitle';
  logTitle.textContent = `诊断日志（最近 ${String(logs.length)} 条）`;
  root.appendChild(logTitle);

  if (logs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tip';
    empty.textContent = '（空）';
    root.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'rows';
    for (const e of logs.slice(-12)) {
      const row = document.createElement('div');
      row.className = 'row';
      const k = document.createElement('span');
      k.className = 'key';
      const time = new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false });
      k.textContent = `${time} ${e.from ? `[${e.from}] ` : ''}${e.step}`;
      const v = document.createElement('span');
      v.className = 'val';
      v.textContent = e.detail ?? '';
      row.append(k, v);
      list.appendChild(row);
    }
    root.appendChild(list);
  }

  const tip = document.createElement('p');
  tip.className = 'tip';
  tip.textContent = tipFor(rows);
  root.appendChild(tip);
}

void render();
