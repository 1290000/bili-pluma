/**
 * 设置页共用的两个小组件。
 *
 * 只有两个：一个卡片外壳、一个"待实现"说明。**不要往这里加业务组件** ——
 * 各分区的内容归各自文件，这里只管长得一样的东西。
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

/**
 * 「本页待实现」清单。
 *
 * ⚠️ **不要删掉这个组件换成看起来做完了的界面。** 它存在的意义是：
 * 打开设置页的人能立刻知道这一页还没做，而不是以为功能坏了。
 * 每一项做完就把对应条目删掉，全部删完时整个 `Pending` 一起删。
 */
export function Pending(props: { items: string[] }): JSX.Element {
  return (
    <div class="pending">
      <div class="pending-head">本页尚未实现</div>
      <ul class="pending-list">
        {props.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
