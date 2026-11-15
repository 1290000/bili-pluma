import { describe, expect, it } from 'vitest';

import { parseLatestRelease } from '@core/update/release';

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v1.2.0',
    draft: false,
    prerelease: false,
    published_at: '2026-11-16T00:00:00Z',
    assets: [
      {
        name: 'pluma-1.2.0-with-source.zip',
        size: 3_255_191,
        browser_download_url:
          'https://github.com/o/r/releases/download/v1.2.0/pluma-1.2.0-with-source.zip',
      },
      {
        name: 'pluma-1.2.0.zip',
        size: 289_831,
        browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/pluma-1.2.0.zip',
      },
    ],
    ...over,
  };
}

describe('parseLatestRelease：正常响应', () => {
  it('剥掉 v 前缀，挑的是精简包而不是 -with-source', () => {
    const release = parseLatestRelease(body());
    expect(release.version).toBe('1.2.0');
    expect(release.zipUrl.endsWith('/pluma-1.2.0.zip')).toBe(true);
    expect(release.sizeBytes).toBe(289_831);
    expect(release.publishedAt).toBe('2026-11-16T00:00:00Z');
  });

  it('没有精确匹配时按前缀退化，但仍然排除 -with-source', () => {
    const release = parseLatestRelease(
      body({
        assets: [
          { name: 'pluma-1.2.0-with-source.zip', size: 1, browser_download_url: 'https://x/a.zip' },
          { name: 'pluma-1.2.0.zip', size: 2, browser_download_url: 'https://x/b.zip' },
        ],
      }),
    );
    expect(release.zipUrl).toBe('https://x/b.zip');
  });

  it('tag 不带 v 也认', () => {
    expect(parseLatestRelease(body({ tag_name: '1.2.0' })).version).toBe('1.2.0');
  });
});

describe('parseLatestRelease：拒绝"不像我们的发行包"的响应', () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ['不是对象', 42, /不是对象/],
    ['tag_name 类型不对', { tag_name: 1 }, /缺 tag_name/],
    ['draft', body({ draft: true }), /draft/],
    ['预发布', body({ prerelease: true }), /预发布/],
    ['缺 tag_name', body({ tag_name: undefined }), /缺 tag_name/],
    ['tag 不是版本号', body({ tag_name: 'nightly' }), /不是合法版本号/],
    ['tag 是预发布后缀', body({ tag_name: 'v1.2.0-beta.1' }), /预发布/],
    ['缺 assets', body({ assets: undefined }), /缺 assets/],
    [
      '没有精简包',
      body({
        assets: [
          { name: 'pluma-1.2.0-with-source.zip', size: 9, browser_download_url: 'https://x/a.zip' },
        ],
      }),
      /没有 pluma-1\.2\.0\.zip/,
    ],
    [
      '下载地址不是 https',
      body({
        assets: [{ name: 'pluma-1.2.0.zip', size: 9, browser_download_url: 'http://x/a.zip' }],
      }),
      /https/,
    ],
    [
      'size 不可信',
      body({
        assets: [{ name: 'pluma-1.2.0.zip', size: 0, browser_download_url: 'https://x/a.zip' }],
      }),
      /size 不可信/,
    ],
    [
      'size 超上限',
      body({
        assets: [
          {
            name: 'pluma-1.2.0.zip',
            size: 99 * 1024 * 1024,
            browser_download_url: 'https://x/a.zip',
          },
        ],
      }),
      /资产过大/,
    ],
  ];

  for (const [label, input, pattern] of bad) {
    it(label, () => {
      expect(() => parseLatestRelease(input)).toThrow(pattern);
    });
  }
});
