/**
 * 原型：不重载页面，给 `createPlayer` 传**我们自己构造**的完整配置，
 * 看播放器能否播满 24 分钟。
 *
 * ## 为什么这是关键一跳
 *
 * 2026-10-28 实测确认了两件事：
 *   1. PGC 页**只调一次** `createPlayer`（t=409ms，`__playinfo__` 刚赋值后 0~2ms）
 *   2. 试看流是**真的只有 360 秒** —— 单独用 `<video>` 播 `durl`，
 *      `duration=360`、`seekable.end=360`、`currentTime` 会被夹回 360。
 *      所以"换流"必须换掉播放器**吃进去的那份数据**，光换 `__playinfo__` 没用。
 *
 * 于是问题收敛成一个：**能在 `createPlayer` 之前把完整流塞进它的 config 吗？**
 * 如果 config 里除了 `prefetch.playUrl` 还有别的数据来源（比如 `config.__PLAYINFO__`），
 * 那么"预取 + 同步塞入"就只需要改一个字段，比预取整页 HTML 轻得多。
 *
 * ## 做法
 *
 * 用页面自己的 `nano.createPlayer`，传一份**最小可用**配置：
 *   container 用页面现有播放器容器，数据用我们现场取的完整集。
 * 成功判据：`video.duration` 明显大于 360（理想 1440）。
 *
 * ⚠️ 会顶掉当前播放器，属于可接受的实验损耗（刷新即恢复）。
 */
(async () => {
  const out = { log: [] };
  const L = (m, e) => out.log.push({ m, ...(e || {}) });

  const r0 = window.__playinfo__?.result;
  const cid = r0?.arc?.cid ?? r0?.video_info?.cid;
  out.cid = cid;
  out.ssr = {
    type: r0?.play_video_type,
    durlMs: (r0?.video_info?.durls ?? [])[0]?.durl?.[0]?.length ?? null,
    timelength: r0?.video_info?.timelength,
  };

  if (!cid) return { error: 'no cid', ...out };

  // 取完整集数据（主账号身份，已确认有权益）
  const url = `https://api.bilibili.com/pgc/player/web/playurl?cid=${cid}&avid=0&qn=80&fnval=4048&fnver=0&fourk=1`;
  const j = await fetch(url, { credentials: 'include' }).then((r) => r.json());
  if (j.code !== 0 || !j.result) return { error: 'api code ' + j.code, ...out };

  const api = j.result;
  out.api = {
    timelength: api.timelength,
    dashGroups: (api.dash?.video ?? []).length,
    hasDash: !!api.dash,
    durlGroups: (api.durls ?? []).length,
  };

  // 合并到 SSR 骨架（与 main-world.js 的 pgcMerge 同逻辑）
  const br = r0 ?? {};
  const vi = br.video_info ?? {};
  const merged = {
    status: 200,
    data: {
      code: 0,
      result: Object.assign({}, br, {
        video_info: Object.assign({}, vi, {
          quality: api.quality ?? vi.quality,
          timelength: api.timelength ?? vi.timelength,
          format: api.format ?? vi.format,
          dash: api.dash || vi.dash,
          durl: api.durl || (api.durls && api.durls[0] && api.durls[0].durl) || vi.durl,
          durls: api.durls || vi.durls,
          accept_quality: api.accept_quality || vi.accept_quality,
          is_preview: false,
        }),
      }),
    },
  };
  out.merged = {
    timelength: merged.data.result.video_info.timelength,
    dashGroups: (merged.data.result.video_info.dash?.video ?? []).length,
    durlGroups: (merged.data.result.video_info.durls ?? []).length,
  };

  // 找容器
  const container =
    document.querySelector('#bilibili-player') ||
    document.querySelector('.bpx-player-container') ||
    document.querySelector('.bpx-player-primary-area');
  out.container = container ? container.className.slice(0, 40) : null;

  // 只用一份最小配置：container + prefetch.playUrl + 一个恒返回同一份数据的回调
  const cfg = {
    container,
    prefetch: { playUrl: merged },
    requestConfig: { reqHttpPlayUrlInfo: () => Promise.resolve(merged) },
  };

  const nano = window.nano;
  out.nanoType = typeof nano;
  try {
    nano.createPlayer(cfg);
    L('createPlayer 已调用');
  } catch (e) {
    return { error: 'createPlayer: ' + (e && e.message), ...out };
  }

  await new Promise((r) => setTimeout(r, 8000));

  const v = document.querySelector('video');
  out.video = {
    dur: Math.round(v?.duration ?? 0),
    h: v?.videoHeight ?? 0,
    t: Math.round(v?.currentTime ?? 0),
    paused: v?.paused ?? null,
    seekable: v && v.seekable.length ? Math.round(v.seekable.end(0)) : 0,
    err: v?.error?.code ?? null,
  };

  return out;
})();
