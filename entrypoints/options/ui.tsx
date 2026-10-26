/**
 * 设置页共用的小组件。
 *
 * 现在只有一个卡片外壳。**不要往这里加业务组件** ——
 * 各分区的内容归各自文件，这里只管长得一样的东西。
 *
 * ## `Pending` 已删除（2026-10-26，P3 验收 3a）
 *
 * 它原来渲染「本页尚未实现」清单，三项分区都做完后已无调用方。
 * 按它自己的规矩——「全部删完时整个 `Pending` 一起删」——连组件一起删掉，
 * 而不是留一个没人用的导出。**留着就是下一个验收者要重新判断一次的疑问。**
 */

import type { ComponentChildren } from 'preact';
import type { JSX } from 'preact';

export function Card(props: { title: string; children: ComponentChildren }): JSX.Element {
  return (
    <section class="card">
      <h2 class="card-title">{props.title}</h2>
      {props.children}
    </section>
  );
}
