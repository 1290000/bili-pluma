import { describe, expect, it } from 'vitest';

import { compareVersions, isNewer, parseVersion } from '@core/update/version';

describe('compareVersions：数字段必须逐段比', () => {
  it('1.10.0 比 1.9.9 新（字符串比较会得出相反结论）', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    // 反向断言：如果谁把它改成字符串比较，这一行会先红
    expect('1.10.0' > '1.9.9').toBe(false);
  });

  it('同版本返回 0', () => {
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
    expect(compareVersions('v1.1.0', '1.1.0')).toBe(0);
  });

  it('git tag 的 v 前缀不影响结果', () => {
    expect(compareVersions('v1.2.0', '1.1.0')).toBe(1);
    expect(compareVersions('1.1.0', 'v1.2.0')).toBe(-1);
  });

  it('缺段按 0 补齐：1.2 等于 1.2.0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('第 4 段参与比较（Chrome manifest 允许 4 段）', () => {
    expect(compareVersions('1.1.0.1', '1.1.0')).toBe(1);
    expect(compareVersions('1.1.0', '1.1.0.1')).toBe(-1);
  });

  it('同号之下预发布比正式版旧', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0-beta.1')).toBe(1);
  });

  it('预发布之间按字典序（够用，不做 semver 分段比较）', () => {
    expect(compareVersions('1.2.0-alpha', '1.2.0-beta')).toBe(-1);
    expect(compareVersions('1.2.0-beta', '1.2.0-beta')).toBe(0);
  });
});

describe('compareVersions：解析失败必须抛错，不许返回 0', () => {
  const bad = ['', 'abc', '1.2.3.4.5', 'v', '1..2', '  ', '20261026x'];

  for (const input of bad) {
    it(`拒绝 ${JSON.stringify(input)}`, () => {
      expect(parseVersion(input)).toBeNull();
      expect(() => compareVersions(input, '1.0.0')).toThrow(/无法解析版本号/);
    });
  }

  it('日期式版本号被拦下（每段上限 65535）', () => {
    expect(parseVersion('20261026')).toBeNull();
    expect(() => compareVersions('20261026', '1.0.0')).toThrow();
  });
});

describe('isNewer', () => {
  it('相等不算"有更新"', () => {
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
  });

  it('旧版本不算"有更新"', () => {
    expect(isNewer('1.0.0', '1.1.0')).toBe(false);
  });

  it('新版本才算', () => {
    expect(isNewer('1.1.1', '1.1.0')).toBe(true);
  });
});
