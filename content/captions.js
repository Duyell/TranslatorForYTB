// content/captions.js — 字幕调度核心(隔离世界)。
// 职责:
//   1. 接收 bridge.js 发来的播放器数据与拦截到的字幕响应(postMessage);
//   2. 解析字幕(录播 json3 / 直播 WebVTT),去重后按播放进度显示;
//   3. 逐句发送给 background.js 翻译(免费 Google 接口或自定义 OpenAI 兼容 API);
//   4. 驱动 OverlayUI(overlay.js)在播放器画面上叠加双语字幕。
// 开关:响应 background 的 {type:'toggle'},回应 {type:'getState'}。

(() => {
  'use strict';

  const CONCURRENCY = 3;        // 翻译并发上限
  const RENDER_INTERVAL = 150;  // 渲染循环周期(ms)
  const LIVE_STALE_MS = 20000;  // 直播超过该时长没有新字幕 → 淡化显示
  const MAX_LIVE_SEEN = 5000;   // 直播去重集合上限(防长直播膨胀)
  const BRIDGE_SOURCE = '__YTSUBS__';    // bridge.js 消息标识
  const CTRL_SOURCE = '__YTSUBS_CTRL__'; // 本脚本发给 bridge 的控制消息标识

  // ---------- 全局状态 ----------

  const S = {
    enabled: false,         // 本标签页开关
    videoId: null,          // 当前视频 id
    isLive: false,          // 是否直播
    cues: [],               // 录播 cue 列表(按 start 排序):{start, end, text}
    seenStarts: new Set(),  // 录播去重(start ms)
    latestLiveCue: null,    // 直播:当前显示的最新 cue
    lastLiveTime: 0,        // 直播:最近新 cue 到达时间(Date.now())
    seenLive: new Set(),    // 直播去重:"start|text"
    translations: new Map(),// 原文 → 译文(按视频缓存)
    failed: new Set(),      // 翻译失败的原文(降级显示原文)
    queue: [],              // 待翻译队列:{text, start, attempts}
    inflight: 0,            // 翻译中数量
    ccToggledByUs: false,   // 是否由本扩展打开的原生 CC(关闭时恢复)
    ccCycleDone: false,     // 「关一下再开」强制播放器重新请求字幕是否已做过
    jaSwitchRequested: false, // 是否已请求 bridge 切到日语字幕轨
    liveStatus: 'waiting',  // 直播状态:'waiting' | 'none' | 'ok'
    liveStarted: false,     // 本视频是否已跑过 startLive(避免重复启动)
    tracksReceived: false,  // 本视频是否拿到过 captionTracks
    trackTimer: null,       // 等待/重试 captionTracks 的定时器
    renderTimer: null,      // 渲染循环定时器
    shownKey: '',           // 当前渲染的 cue 标识(避免重复渲染)
    lastCue: null,          // 上一次渲染的 cue(短暂间隙不隐藏)
    settings: null,         // 设置缓存(loadSettings 后非空)
  };

  const DEFAULT_SETTINGS = {
    engine: 'google',
    customBaseUrl: '',
    customApiKey: '',
    customModel: '',
    showOriginal: true,
    fontSize: 20,
    enabled: true,
  };

  // ---------- 设置 ----------

  async function loadSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    S.settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    OverlayUI.setFontSize(S.settings.fontSize);
    OverlayUI.setShowOriginal(S.settings.showOriginal);
  }

  // 设置变化实时生效(选项页保存即触发)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings || !S.settings) return;
    const oldEngine = S.settings.engine;
    S.settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
    OverlayUI.setFontSize(S.settings.fontSize);
    OverlayUI.setShowOriginal(S.settings.showOriginal);
    if (S.settings.engine !== oldEngine) {
      // 引擎变了:清掉旧译文,当前视频的字幕重新翻译
      S.translations.clear();
      S.failed.clear();
      for (const c of S.cues) enqueue(c.text, c.start);
      if (S.latestLiveCue) enqueue(S.latestLiveCue.text, S.latestLiveCue.start);
    }
  });

  // ---------- 消息桥 ----------

  function postCtrl(msg) {
    try { window.postMessage(Object.assign({ source: CTRL_SOURCE }, msg), '*'); } catch { /* 忽略 */ }
  }

  // bridge → 本脚本
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== BRIDGE_SOURCE) return;
    if (d.type === 'videoChange') onVideoChange(d);
    else if (d.type === 'playerData') onPlayerData(d);
    else if (d.type === 'captionBody') onCaptionBody(d);
  });

  // background → 本脚本(开关/状态查询)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'toggle') { toggle(); sendResponse({ enabled: S.enabled }); }
    else if (msg.type === 'getState') { sendResponse({ enabled: S.enabled }); }
  });

  // ---------- 开关 ----------

  function toggle() {
    if (S.enabled) stop(); else start();
  }

  function start() {
    S.enabled = true;
    ensureOverlay();
    hideNativeCaptions(true);
    startRenderLoop();
    // 页面可能已加载完,bridge 的历史事件已错过,主动索取一次播放器数据
    postCtrl({ type: 'getPlayerData' });
  }

  function stop() {
    S.enabled = false;
    hideNativeCaptions(false);
    restoreCC();
    OverlayUI.hide();
  }

  // 找到播放器容器后挂载叠加层(渲染循环里会反复尝试)
  function ensureOverlay() {
    const player = document.getElementById('movie_player');
    if (player) OverlayUI.init(player);
  }

  // 开启时隐藏 YouTube 原生字幕窗(避免和叠加层重复),关闭时恢复
  function hideNativeCaptions(on) {
    const id = '__ytsubs-hide-cc__';
    const existing = document.getElementById(id);
    if (on && !existing) {
      const style = document.createElement('style');
      style.id = id;
      style.textContent = '#movie_player .ytp-caption-window-container { display: none !important; }';
      (document.head || document.documentElement).appendChild(style);
    } else if (!on && existing) {
      existing.remove();
    }
  }

  // 关闭本扩展时,把「我们打开的原生 CC」恢复原状
  function restoreCC() {
    if (!S.ccToggledByUs) return;
    const btn = document.querySelector('.ytp-subtitles-button');
    if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
    S.ccToggledByUs = false;
  }

  // ---------- 视频切换 ----------

  function onVideoChange(d) {
    if (d.videoId === S.videoId) return;
    S.videoId = d.videoId;
    S.isLive = !!d.isLive;
    resetVideoState();
    if (!S.enabled) return;
    ensureOverlay();
    if (S.isLive) {
      startLive();
    } else {
      // 录播:tracks 由随后的 playerData 消息带来;超时主动索取一次,仍无则提示
      OverlayUI.setStatus('等待字幕数据…');
      S.trackTimer = setTimeout(() => {
        postCtrl({ type: 'getPlayerData' });
        S.trackTimer = setTimeout(() => {
          if (!S.tracksReceived && S.enabled) OverlayUI.setStatus('本视频无日语字幕');
        }, 4000);
      }, 2500);
    }
  }

  function resetVideoState() {
    S.cues = [];
    S.seenStarts.clear();
    S.latestLiveCue = null;
    S.lastLiveTime = 0;
    S.seenLive.clear();
    S.translations.clear();
    S.failed.clear();
    S.queue = [];
    S.inflight = 0;
    S.ccToggledByUs = false; // 换视频后原生 CC 状态由播放器接管,不再恢复
    S.ccCycleDone = false;
    S.jaSwitchRequested = false;
    S.liveStatus = 'waiting';
    S.liveStarted = false;
    S.tracksReceived = false;
    S.shownKey = '';
    S.lastCue = null;
    clearTimeout(S.trackTimer);
    OverlayUI.hide();
  }

  function onPlayerData(d) {
    if (!S.enabled) return;
    if (S.videoId !== d.videoId) {
      // 初始状态(本脚本晚于 bridge 的事件)或漏掉的切换:把 playerData 当 videoChange 用
      onVideoChange(d);
    }
    if (d.isLive) {
      S.isLive = true;
      // 视频切换消息被漏掉/扩展中途才开启时,直播链路可能还没启动 → 补启动
      if (!S.liveStarted) startLive();
      return;
    }
    if (!Array.isArray(d.tracks) || d.tracks.length === 0) return; // 可能晚到,等下一次
    S.tracksReceived = true;
    clearTimeout(S.trackTimer);
    // 优先自动字幕(asr),退而求其次人工字幕
    const track = d.tracks.find((t) => t.kind === 'asr') || d.tracks[0];
    fetchVodTrack(track.baseUrl);
  }

  // ---------- 录播字幕 ----------

  // 三级策略:
  //   ① 直接 fetch captionTracks 的 baseUrl(同源,无 CORS 问题)—— 2025 年后
  //      YouTube 加了 POT 签名校验,这条路可能拿到空 body;
  //   ② 点 CC 按钮让播放器自己请求字幕(请求自带有效签名),bridge 拦截其响应;
  //   ③ 若当前字幕轨不是日语,让 bridge 调播放器 API 切轨,触发重新请求。
  async function fetchVodTrack(baseUrl) {
    // baseUrl 中 & 被转义成 &,先还原;统一要 json3;去掉 tlang(翻译轨参数)
    let url = baseUrl.replace(/\\u0026/g, '&');
    url = url.replace(/[?&]tlang=[^&]*/g, '');
    url = url.includes('fmt=') ? url.replace(/fmt=[^&]+/g, 'fmt=json3') : url + '&fmt=json3';
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.text();
        if (body.trim()) {
          const cues = parseJson3(JSON.parse(body));
          if (cues.length) { applyVodCues(cues); return; }
        }
      }
    } catch { /* 走强制 CC 拦截路径 */ }
    forceCC();
  }

  // 强制播放器自取字幕(等 bridge 拦截到响应为止)
  function forceCC() {
    const vid = S.videoId;
    let waited = 0;
    const iv = setInterval(() => {
      waited += 250;
      if (!S.enabled || S.videoId !== vid || S.cues.length) { clearInterval(iv); return; } // 已拿到字幕或已切视频
      if (waited >= 15000) {
        clearInterval(iv);
        OverlayUI.setStatus('无法获取字幕(该视频可能无自动字幕)');
        return;
      }
      const btn = document.querySelector('.ytp-subtitles-button');
      if (!btn) return;
      if (btn.getAttribute('aria-pressed') !== 'true') {
        btn.click(); // 打开 CC,播放器会发起带签名的字幕请求
        S.ccToggledByUs = true;
      } else if (!S.ccCycleDone) {
        // CC 本就开着但没拦到请求(如扩展晚于播放器加载)→ 快速关再开触发重取
        S.ccCycleDone = true;
        btn.click();
        btn.click();
      }
    }, 250);
  }

  function applyVodCues(cues) {
    let added = false;
    for (const c of cues) {
      if (!c.text || S.seenStarts.has(c.start)) continue;
      S.seenStarts.add(c.start);
      S.cues.push({ start: c.start, end: c.end, text: c.text });
      enqueue(c.text, c.start);
      added = true;
    }
    if (added) S.cues.sort((a, b) => a.start - b.start);
  }

  // ---------- 直播字幕 ----------

  function startLive() {
    S.liveStarted = true;
    OverlayUI.setStatus('等待直播字幕…');
    const vid = S.videoId;
    let waited = 0;
    // 直播字幕 = 播放器自动轮询 webvtt,bridge 拦截即可;先确保 CC 打开。
    // CC 按钮不存在 = 该直播没有自动字幕(取决于主播是否开启)。
    const iv = setInterval(() => {
      waited += 300;
      if (!S.enabled || S.videoId !== vid) { clearInterval(iv); return; }
      if (waited >= 8000) {
        clearInterval(iv);
        if (!S.latestLiveCue) {
          S.liveStatus = 'none';
          OverlayUI.setStatus('本直播无自动字幕(主播可能未开启)');
        }
        return;
      }
      const btn = document.querySelector('.ytp-subtitles-button');
      if (!btn) return;
      if (btn.getAttribute('aria-pressed') !== 'true') {
        btn.click();
        S.ccToggledByUs = true;
      }
      clearInterval(iv); // CC 已就绪,等拦截即可
    }, 300);
  }

  function applyLiveCues(cues) {
    const now = Date.now();
    for (const c of cues) {
      const key = c.start + '|' + c.text;
      if (S.seenLive.has(key)) continue;
      if (S.seenLive.size >= MAX_LIVE_SEEN) {
        // 长直播防膨胀:只保留后一半
        const arr = [...S.seenLive];
        S.seenLive = new Set(arr.slice(arr.length / 2));
      }
      S.seenLive.add(key);
      S.latestLiveCue = { start: c.start, end: c.end, text: c.text };
      S.lastLiveTime = now;
      S.liveStatus = 'ok';
      enqueue(c.text, c.start);
    }
  }

  // ---------- 字幕解析 ----------

  // json3:{events:[{tStartMs, dDurationMs, segs:[{utf8}]}]};无 segs 的事件跳过
  function parseJson3(obj) {
    const out = [];
    for (const ev of obj.events || []) {
      if (!Array.isArray(ev.segs) || ev.segs.length === 0) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').trim();
      if (!text) continue;
      const start = ev.tStartMs || 0;
      out.push({ start, end: start + (ev.dDurationMs || 0), text });
    }
    return out;
  }

  // WebVTT:解析 "HH:MM:SS.mmm --> HH:MM:SS.mmm" 与随后的文本行。直播 cue 的
  // 时间戳相对 DVR 窗口,仅用于去重与排序,显示始终取最新一条。
  function parseVTT(body) {
    const out = [];
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('-->')) continue;
      const [a, b] = lines[i].split('-->');
      const start = vttTime(a);
      if (start == null) continue;
      const parts = [];
      while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !lines[i + 1].includes('-->')) {
        parts.push(lines[++i].trim());
      }
      const text = parts.join(' ').replace(/<[^>]+>/g, '').trim(); // 去掉 VTT 内联标签
      if (text) out.push({ start, end: vttTime(b) ?? start + 2000, text });
    }
    return out;
  }

  // "HH:MM:SS.mmm" / "MM:SS.mmm" → 毫秒
  function vttTime(s) {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec((s || '').trim());
    if (!m) return null;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    return h * 3600000 + parseInt(m[2], 10) * 60000 + parseInt(m[3], 10) * 1000 + parseInt(m[4].padEnd(3, '0'), 10);
  }

  // ---------- 拦截到的字幕响应 ----------

  function onCaptionBody(d) {
    if (!S.enabled || !S.videoId) return;
    try {
      const url = d.url;
      if (url.includes('tlang=')) return; // 翻译轨,只要原始日语
      if (!S.isLive) {
        // 录播:只收当前视频的请求;非日语轨 → 请求切轨(一次),播放器会重新请求
        const v = url.match(/[?&]v=([^&]+)/);
        if (v && v[1] !== S.videoId) return;
        const lang = url.match(/[?&]lang=([^&]+)/);
        if (lang && decodeURIComponent(lang[1]) !== 'ja') {
          if (!S.jaSwitchRequested) {
            S.jaSwitchRequested = true;
            postCtrl({ type: 'setCaptionTrack', languageCode: 'ja' });
          }
          return;
        }
      }
      let cues = null;
      if (/json/i.test(d.contentType) || d.body.trim().startsWith('{')) {
        cues = parseJson3(JSON.parse(d.body));
      } else {
        cues = parseVTT(d.body);
      }
      if (!cues.length) return;
      if (S.isLive) applyLiveCues(cues);
      else applyVodCues(cues);
    } catch { /* 解析失败忽略,等下一次响应 */ }
  }

  // ---------- 翻译队列 ----------

  // 按「离当前播放位置的距离」优先,保证正在看的内容先出译文,其余后台补翻
  function enqueue(text, start) {
    if (S.translations.has(text) || S.failed.has(text)) return;
    if (S.queue.some((it) => it.text === text)) return; // 同文本已在队列/翻译中
    S.queue.push({ text, start, attempts: 0 });
    processQueue();
  }

  function processQueue() {
    if (!S.enabled) return;
    const now = currentTimeMs();
    S.queue.sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now));
    while (S.inflight < CONCURRENCY && S.queue.length) {
      const item = S.queue.shift();
      if (S.translations.has(item.text) || S.failed.has(item.text)) continue;
      S.inflight++;
      translateItem(item);
    }
  }

  async function translateItem(item) {
    let result = null;
    try {
      result = await chrome.runtime.sendMessage({ type: 'translate', id: item.text, text: item.text });
    } catch { /* SW 未就绪等,按失败重试 */ }
    S.inflight--;
    if (result && result.ok) {
      S.translations.set(item.text, result.text);
    } else if (item.attempts < 2) {
      S.queue.push({ text: item.text, start: item.start, attempts: item.attempts + 1 }); // 重试 2 次
    } else {
      S.failed.add(item.text); // 最终失败:降级只显示日语原文
    }
    processQueue();
  }

  function currentTimeMs() {
    const v = document.querySelector('#movie_player video');
    return v ? v.currentTime * 1000 : 0;
  }

  // ---------- 渲染 ----------

  function startRenderLoop() {
    if (S.renderTimer) return;
    S.renderTimer = setInterval(renderTick, RENDER_INTERVAL);
  }

  function renderTick() {
    if (!S.enabled) return;
    ensureOverlay();
    if (!S.videoId) return;
    if (S.isLive) renderLive();
    else renderVod();
    processQueue(); // 顺带驱动翻译队列(优先级随时间刷新)
  }

  function renderVod() {
    if (S.cues.length === 0) return; // 字幕未就绪,保持状态文案
    const t = currentTimeMs();
    // 二分找当前 cue:start <= t < end + 400ms(400ms 容差)
    let lo = 0;
    let hi = S.cues.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = S.cues[mid];
      if (c.start > t) hi = mid - 1;
      else if (c.end + 400 < t) lo = mid + 1;
      else { found = c; break; }
    }
    if (!found) {
      // 字幕间隙:小于 1.2s 不隐藏(避免闪烁),否则隐藏
      if (S.lastCue && t - S.lastCue.end < 1200) return;
      S.lastCue = null;
      OverlayUI.hide();
      return;
    }
    const zh = S.translations.get(found.text) ?? null;
    const failed = S.failed.has(found.text);
    // key 含译文状态:翻译完成时即使 cue 不变也会刷新显示
    const key = found.start + '|' + found.text + '|' + (zh ? '1' : failed ? '2' : '0');
    if (key === S.shownKey) return;
    S.shownKey = key;
    S.lastCue = found;
    OverlayUI.setCue({ ja: found.text, zh, pending: !zh && !failed, failed });
  }

  function renderLive() {
    const cue = S.latestLiveCue;
    if (!cue) {
      // 无 cue:按直播状态显示提示(等待中 / 无字幕)
      OverlayUI.setStatus(S.liveStatus === 'none' ? '本直播无自动字幕(主播可能未开启)' : '等待直播字幕…');
      return;
    }
    const zh = S.translations.get(cue.text) ?? null;
    const failed = S.failed.has(cue.text);
    OverlayUI.setCue({ ja: cue.text, zh, pending: !zh && !failed, failed });
    // 长时间没有新字幕 → 淡化,提示可能已停
    OverlayUI.setStale(Date.now() - S.lastLiveTime > LIVE_STALE_MS);
  }

  // ---------- 启动 ----------

  loadSettings().then(() => {
    if (S.settings.enabled) start();
  });
})();
