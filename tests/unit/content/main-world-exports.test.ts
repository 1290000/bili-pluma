// @vitest-environment jsdom
/**
 * 测试侧出口工具的测试（S4.1 的元测试）
 *
 * 这个文件本身**不测业务逻辑**，它测的是「防假通过的那道闸门自己好不好使」。
 * 理由：如果出口工具本身静默失效，后面所有依赖它的测试都会假绿 ——
 * 那比没有测试更危险（因为看起来有覆盖）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  MainWorldSpliceError,
  TEST_EXPOSED_FNS,
  assertTestExports,
  spliceTestExports,
} from './helpers/main-world-exports';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');

function freshPage(): Record<string, unknown> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    pretendToBeVisual: true,
  });
  return dom.window as unknown as Record<string, unknown>;
}

describe('spliceTestExports（S4.1 出口工具）', () => {
  it('真实源码能拼上，且 eval 后出口齐全', () => {
    const page = freshPage();
    const spliced = spliceTestExports(SOURCE);

    (page as unknown as { eval: (s: string) => void }).eval(spliced);
    assertTestExports(page);

    const bag = page.__PLUMA_TEST__ as Record<string, unknown>;
    for (const fn of TEST_EXPOSED_FNS) {
      expect(typeof bag[fn], `${fn} 应该是 function`).toBe('function');
    }
  });

  it('原源码（不拼接）eval 后**没有**出口 —— 证明拼接确实在起作用', () => {
    /**
     * 这条是"反向基线"：如果原源码本来就有出口，
     * 那上面的测试就证明不了拼接干过任何事。
     */
    const page = freshPage();
    (page as unknown as { eval: (s: string) => void }).eval(SOURCE);
    expect(page.__PLUMA_TEST__).toBeUndefined();
  });

  describe('假通过防线：结构变了必须 throw，不能静默', () => {
    it('找不到 IIFE 收尾字面量 → throw', () => {
      expect(() => spliceTestExports('var a = 1;\nvar b = 2;\n')).toThrow(MainWorldSpliceError);
    });

    it('收尾字面量出现多次 → throw（不猜该拼哪一处）', () => {
      expect(() => spliceTestExports('(() => {})();\n(() => {})();\n')).toThrow(
        MainWorldSpliceError,
      );
    });

    it('出口缺失时 assertTestExports 抛错（而不是让测试拿到 undefined 后假绿）', () => {
      const page = freshPage();
      expect(() => assertTestExports(page)).toThrow(MainWorldSpliceError);
    });

    it('函数名被改掉时 assertTestExports 抛错并指出是哪个', () => {
      const page = freshPage();
      page.__PLUMA_TEST__ = { applyProgressToJson: () => {} };

      expect(() => assertTestExports(page)).toThrow(/matchPath/);
    });

    it('函数存在但不是 function（比如被改成变量）也要抛', () => {
      const page = freshPage();
      page.__PLUMA_TEST__ = Object.fromEntries(TEST_EXPOSED_FNS.map((f) => [f, 42]));

      expect(() => assertTestExports(page)).toThrow(MainWorldSpliceError);
    });
  });

  describe('可指定要暴露的函数', () => {
    it('只暴露子集', () => {
      const page = freshPage();
      const spliced = spliceTestExports(SOURCE, ['matchPath']);

      (page as unknown as { eval: (s: string) => void }).eval(spliced);
      assertTestExports(page, ['matchPath']);

      const bag = page.__PLUMA_TEST__ as Record<string, unknown>;
      expect(typeof bag.matchPath).toBe('function');
      expect(bag.applyProgressToJson).toBeUndefined();
    });

    it('指定一个不存在的函数 → throw（拼了也是 undefined）', () => {
      const page = freshPage();
      const spliced = spliceTestExports(SOURCE, ['__doesNotExist__']);
      (page as unknown as { eval: (s: string) => void }).eval(spliced);

      expect(() => assertTestExports(page, ['__doesNotExist__'])).toThrow(MainWorldSpliceError);
    });
  });
});
