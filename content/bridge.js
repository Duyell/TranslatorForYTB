// content/bridge.js — 页面主世界(MAIN world)桥接脚本,run_at: document_start。
// 职责:
//   1. 包装 window.fetch / XMLHttpRequest,克隆播放器发起的字幕请求响应
//      (timedtext json3 / 直播 webvtt),经 window.postMessage 转发给隔离世界的
//      captions.js。绝不修改、阻塞任何原始请求与响应。
//      2025 年起 YouTube 对 timedtext 加了 POT 签名校验,自己拼 URL 直接请求
//      常拿空 body;播放器自己的请求自带有效签名,克隆其响应是最稳的取字幕方式。
//   2. 轮询播放器 getPlayerResponse(),检测视频切换并提取日语字幕轨信息。
//      (隔离世界读不到页面 JS 变量,所以由本脚本代读)
//   3. 代理隔离世界发来的播放器 API 调用(隔离世界无法调用页面 JS 方法)。
// 消息协议(与 content/captions.js):
//   本脚本 → 页面: { source:'__YTSUBS__', type:'videoChange'|'playerData'|'captionBody'|'setCaptionTrackResult', ... }
//   页面 → 本脚本: { source:'__YTSUBS_CTRL__', type:'getPlayerData'|'setCaptionTrack', ... }

(() => {
  'use strict';

  const MSG_SOURCE = '__YTSUBS__';       // 本脚本发出的消息标识
  const CTRL_SOURCE = '__YTSUBS_CTRL__'; // 隔离世界发来的控制消息标识

  // ---------- 消息发送 ----------

  function post(msg) {
    try {
      window.postMessage(Object.assign({ source: MSG_SOURCE }, msg), '*');
    } catch { /* 页面卸载等极端情况,忽略 */ }
  }

  // ---------- 播放器数据 ----------

  // 取 #movie_player 元素(仅当其挂载了播放器 API 时可用)
  function getPlayer() {
    try {
      const el = document.getElementById('movie_player');
      return el && typeof el.getPlayerResponse === 'function' ? el : null;
    } catch {
      return null;
    }
  }

  // 从播放器响应中提取本扩展需要的最小数据(避免转发大对象)
  function readPlayerData() {
    let pr = null;
    const player = getPlayer();
    try { pr = player ? player.getPlayerResponse() : null; } catch { /* 忽略 */ }
    if (!pr) pr = window.ytInitialPlayerResponse || null; // 兜底:主世界可直接读页面变量
    if (!pr || !pr.videoDetails || !pr.videoDetails.videoId) return null;

    const tracks = [];
    const list = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    if (list && Array.isArray(list.captionTracks)) {
      for (const t of list.captionTracks) {
        if (t.languageCode === 'ja') {
          tracks.push({ kind: t.kind || '', languageCode: t.languageCode, baseUrl: t.baseUrl || '' });
        }
      }
    }
    return {
      videoId: pr.videoDetails.videoId,
      isLive: !!pr.videoDetails.isLiveContent,
      tracks,
    };
  }

  let lastVideoId = null;
  let lastTracksJson = '';

  // 轮询检查:视频切换或字幕轨变化(SPA 导航后 captionTracks 常晚到)时通知隔离世界
  function pollPlayer() {
    hookXHR(); // 幂等,顺带修复被页面代码覆盖的 XHR 钩子
    const data = readPlayerData();
    if (!data) return;
    if (data.videoId !== lastVideoId) {
      lastVideoId = data.videoId;
      lastTracksJson = JSON.stringify(data.tracks);
      post({ type: 'videoChange', videoId: data.videoId, isLive: data.isLive });
      post({ type: 'playerData', ...data });
    } else {
      const json = JSON.stringify(data.tracks);
      if (json !== lastTracksJson) {
        lastTracksJson = json;
        post({ type: 'playerData', ...data });
      }
    }
  }

  setInterval(pollPlayer, 1500);

  // yt-navigate-finish:SPA 切换的加速触发(不能单靠它,title 未更新/漏发时轮询兜底)
  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(pollPlayer, 100);
  });

  // ---------- fetch 钩子 ----------

  // 判断 URL 是否可能是字幕请求:timedtext(json3)或 webvtt(直播)
  function isCaptionUrl(url) {
    return /\/timedtext|mime=text|\/webvtt/i.test(url);
  }

  // 响应体是否值得转发:内容类型匹配
  function isCaptionContentType(ct) {
    return /text\/vtt|application\/json|text\/json/i.test(ct);
  }

  function maybeForwardCaptionBody(url, res) {
    if (!isCaptionUrl(url)) return;
    let ct = '';
    try { ct = res.headers.get('content-type') || ''; } catch { /* 忽略 */ }
    if (!isCaptionContentType(ct)) return;
    // 克隆后异步读文本,不消耗播放器拿到的原始响应
    res.clone().text()
      .then((body) => {
        if (body && body.trim()) post({ type: 'captionBody', url, body, contentType: ct });
      })
      .catch(() => { /* 读失败不影响播放器 */ });
  }

  const nativeFetch = window.fetch; // document_start 时的原生实现
  let origFetch = nativeFetch;      // 当前「原始」实现(可能被 YouTube 替换)
  let fetchDepth = 0;               // 同步重入深度(用于防循环)

  // 包装 fetch:调用时优先走 origFetch(保住 YouTube 注入的 pot 逻辑);
  // 重入时(YouTube 的包装反过来调了本包装)直接走原生实现,杜绝无限循环。
  function wrappedFetch(input, init) {
    const base = fetchDepth > 0 ? nativeFetch : origFetch;
    fetchDepth++;
    let p;
    try {
      p = base.apply(this, arguments);
    } finally {
      fetchDepth--;
    }
    if (p && typeof p.then === 'function') {
      p = p.then(
        (res) => {
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || String(input);
            maybeForwardCaptionBody(url, res);
          } catch { /* 永不干扰播放器 */ }
          return res;
        },
        (err) => { throw err; }
      );
    }
    return p;
  }

  // 用 getter/setter 陷阱保住包装:YouTube 后续替换 window.fetch 时,
  // 外部读到的仍是本包装,被替换的函数成为新的 origFetch。
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    enumerable: true,
    get: () => wrappedFetch,
    // 防「保存再恢复」把包装自身设回底层实现导致死循环
    set: (v) => { if (v !== wrappedFetch) origFetch = v; },
  });

  // ---------- XHR 钩子 ----------

  let ourOpen = null;
  let ourSend = null;

  function hookXHR() {
    // 已安装且未被页面覆盖 → 跳过;被覆盖则重新包装(链不会无限增长:每处只包一次)
    if (XMLHttpRequest.prototype.open === ourOpen && XMLHttpRequest.prototype.send === ourSend) return;

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    ourOpen = function (method, url, ...rest) {
      try { this.__ytsubsUrl = String(url); } catch { /* 忽略 */ }
      return origOpen.apply(this, [method, url, ...rest]);
    };

    ourSend = function (...args) {
      if (!this.__ytsubsHooked) {
        this.__ytsubsHooked = true;
        this.addEventListener('loadend', () => {
          try {
            const url = this.__ytsubsUrl || this.responseURL || '';
            if (!isCaptionUrl(url)) return;
            if (this.status !== 200) return;
            if (this.responseType !== '' && this.responseType !== 'text') return;
            const ct = this.getResponseHeader('content-type') || '';
            if (!isCaptionContentType(ct)) return;
            const body = this.responseText;
            if (body && body.trim()) post({ type: 'captionBody', url, body, contentType: ct });
          } catch { /* 忽略 */ }
        });
      }
      return origSend.apply(this, args);
    };

    XMLHttpRequest.prototype.open = ourOpen;
    XMLHttpRequest.prototype.send = ourSend;
  }
  hookXHR();

  // ---------- 隔离世界控制消息 ----------

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== CTRL_SOURCE) return;
    try {
      if (d.type === 'getPlayerData') {
        const data = readPlayerData();
        if (data) post({ type: 'playerData', ...data });
      } else if (d.type === 'setCaptionTrack') {
        // 切换播放器当前字幕轨(隔离世界调不了页面 JS 方法,由这里代理)
        const player = getPlayer();
        if (!player || typeof player.setOption !== 'function') {
          post({ type: 'setCaptionTrackResult', ok: false, error: '播放器 API 不可用' });
          return;
        }
        player.setOption('captions', 'track', { languageCode: d.languageCode });
        post({ type: 'setCaptionTrackResult', ok: true });
      }
    } catch (err) {
      post({ type: 'setCaptionTrackResult', ok: false, error: String(err) });
    }
  });

  // 首屏立即检查一次(页面可能已加载完,轮询尚未触发)
  pollPlayer();
})();
