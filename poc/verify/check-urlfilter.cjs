// 验证 DNR urlFilter 匹配规则：哪种写法能命中真实 playurl URL
// 用本地 echo 服务不行（host 权限不够），所以这里只做纯字符串规则验证
// 关键是确认 '||' 前缀的行为

const FULL_URL =
  'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1beNcz2ECq&cid=36532588493&fnval=4048&fourk=1&qn=0&wts=1792912345&w_rid=abc123';

/**
 * 简化版 DNR urlFilter 匹配（只实现我们要验证的几种语法）
 * 依据 Chrome 文档：urlFilter 支持 * | || ^
 *   '||' 匹配 hostname 开头
 *   '|' 锚定开头/结尾
 *   '^' 匹配分隔符
 *   '*' 通配
 */
function dnrMatch(filter, url) {
  // '||' 域名锚点：匹配 scheme:// 之后以指定字符串开头的 host 部分
  if (filter.startsWith('||')) {
    const rest = filter.slice(2);
    // 取 host 部分（到第一个 / ? # 为止）
    const hostEnd = rest.search(/[/?#]/);
    const host = hostEnd === -1 ? rest : rest.slice(0, hostEnd);

    // 只看 host 是否以 host 开头 —— 后面那截不被当成 path
    const afterScheme = url.replace(/^[a-z]+:\/\//, '');
    const actualHost = afterScheme.split(/[/?#]/)[0];

    if (!actualHost.endsWith(host) && !actualHost.includes(host)) return false;

    // '||host/path' 这种写法：DNR 会把 /path 也当作 host 的一部分去比，
    // 所以 actualHost 里不会有它 → 匹配失败
    return true;
  }

  // 普通片段匹配：在完整 URL 里找子串
  return url.includes(filter);
}

const cases = [
  {
    filter: '||api.bilibili.com/x/player/wbi/playurl',
    desc: "旧写法（'||' + 完整路径）",
  },
  {
    filter: '/x/player/wbi/playurl',
    desc: '新写法（纯路径片段）',
  },
  {
    filter: '/x/player/wbi/playurl?',
    desc: '带 ? 分隔符',
  },
];

console.log('测试 URL:');
console.log(FULL_URL, '\n');

for (const c of cases) {
  const hit = dnrMatch(c.filter, FULL_URL);
  // 对 '||' 写法做更准确的判定：host 部分必须等于 api.bilibili.com
  let accurate = hit;
  if (c.filter.startsWith('||')) {
    const rest = c.filter.slice(2);
    const hostEnd = rest.search(/[/?#]/);
    const hostPart = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
    const actualHost = FULL_URL.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0];
    // 真实 DNR 行为：urlFilter 的 host 部分要匹配 hostname
    // '||api.bilibili.com/x/player/...' 的 host 部分 = 'api.bilibili.com'
    // 但 DNR 要求整个 pattern 从 hostname 开头开始匹配完整 URL 的前缀
    // 即 url 必须以 "api.bilibili.com/x/player/wbi/playurl" 开头
    const afterScheme = FULL_URL.replace(/^[a-z]+:\/\//, '');
    accurate = afterScheme.startsWith(rest);
  }

  console.log(`${c.desc}`);
  console.log(`  filter: ${c.filter}`);
  console.log(`  简版匹配: ${hit}`);
  console.log(`  按 DNR 真实语义（scheme 后必须以此开头）: ${accurate}`);
  console.log('');
}
