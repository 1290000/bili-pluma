/**
 * 取证脚本 Q：Q3 —— 主页有没有**第二条首屏通道**（只读）。
 *
 * 逐条探测候选接口是否存在/可用：
 *   - www.bilibili.com/index/ding.json（老接口）
 *   - app.bilibili.com/x/v2/feed/index（App 侧）
 *   - 带 web_location 的推荐接口
 *   - 首页其它页签（热门/番剧/直播 等）是否接口驱动
 */
import { evaluate } from './bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-q-alt-channels.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const r = evaluate(
  session,
  tab,
  `(async()=>{
     const probe=async(url)=>{
       try{
         const res=await fetch(url,{credentials:'include'});
         const txt=await res.text();
         let code=null,hasData=false;
         try{const j=JSON.parse(txt);code=j.code;hasData=!!j.data}catch(e){}
         return {url:url.slice(0,80),status:res.status,len:txt.length,code,hasData};
       }catch(e){return {url:url.slice(0,80),err:'net'}}
     };
     const out={};
     out.dingJson=await probe('https://www.bilibili.com/index/ding.json');
     out.dingJson2=await probe('https://api.bilibili.com/x/web-interface/ding');
     out.appFeed=await probe('https://app.bilibili.com/x/v2/feed/index?idx=0&build=1');
     out.rcmdRcmd=await probe('https://api.bilibili.com/x/web-interface/rcmd?ps=10');
     // 其它页签相关
     out.popular=await probe('https://api.bilibili.com/x/web-interface/popular?ps=5&pn=1');
     out.ranking=await probe('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all');
     out.ogvRcmd=await probe('https://api.bilibili.com/x/web-interface/index/ogv/rcmd');
     out.liveRec=await probe('https://api.live.bilibili.com/xlive/web-interface/v1/webMain/getMoreRecList');
     return JSON.stringify(out);
   })()`,
);

console.log('### Q：第二条首屏通道候选');
if (!r.ok) {
  console.log('FAIL', (r.err || r.out || '').slice(0, 600));
  process.exit(1);
}
const parsed = JSON.parse(r.out);
for (const [k, v] of Object.entries(parsed)) {
  console.log(`  ${k.padEnd(14)} ${JSON.stringify(v)}`);
}
