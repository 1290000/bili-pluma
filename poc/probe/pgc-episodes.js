(async () => {
  const r = await fetch('https://api.bilibili.com/pgc/view/web/season?season_id=34412', { credentials: 'include' });
  const j = await r.json();
  const eps = (j.result && j.result.episodes) || [];
  return {
    code: j.code,
    count: eps.length,
    // 只返回选择所需的最小元数据；id 本身不在报告里出现
    eps: eps.slice(0, 40).map((e, i) => ({
      i,
      id: e.id,
      badge: e.badge || '',
      badgeType: e.badge_type || 0,
      isVip: /会员|大会员|专享/.test(String(e.badge || '')),
      duration: e.duration,
      titleLen: (e.title || '').length,
    })),
  };
})()
