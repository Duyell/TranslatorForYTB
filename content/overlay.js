// content/overlay.js — 字幕叠加层 UI(隔离世界,先于 captions.js 加载)。
// 在 #movie_player 内挂载一个 Shadow DOM 组件:控制条上方、水平居中,
// 样式与页面隔离,不拦截任何鼠标事件。挂载 globalThis.OverlayUI 供 captions.js 调用。

(() => {
  'use strict';

  const CSS = `
    :host {
      position: absolute;
      left: 50%;
      bottom: 56px;
      transform: translateX(-50%);
      z-index: 50;
      pointer-events: none;
      max-width: 90%;
      width: max-content;
      opacity: 0;
      transition: opacity 120ms ease;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    }
    :host(.visible) { opacity: 1; }
    :host(.stale) { opacity: .45; }
    .box {
      background: rgba(8, 8, 8, .72);
      padding: 6px 14px;
      border-radius: 8px;
      text-align: center;
    }
    .ja {
      font-size: calc(var(--sub-size, 20px) * .85);
      color: #e8e8e8;
      line-height: 1.5;
    }
    .zh {
      font-size: var(--sub-size, 20px);
      color: #fff;
      font-weight: 600;
      line-height: 1.5;
      text-shadow: 0 1px 2px rgba(0, 0, 0, .9);
    }
    .hint {
      font-size: calc(var(--sub-size, 20px) * .75);
      color: #c9c9c9;
      line-height: 1.5;
    }
    .status {
      background: rgba(8, 8, 8, .72);
      padding: 6px 14px;
      border-radius: 8px;
      font-size: calc(var(--sub-size, 20px) * .75);
      color: #d0d0d0;
      text-align: center;
    }
  `;

  let host = null;    // 挂在 #movie_player 内的宿主元素
  let boxEl = null;   // 字幕盒(原文/译文/提示)
  let jaEl = null;    // 日语原文行
  let zhEl = null;    // 中文译文行
  let hintEl = null;  // 提示行(如「翻译失败」)
  let statusEl = null;// 状态文案行(等待字幕等,与字幕盒互斥)
  let fontSize = 20;
  let showOriginal = true;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__ytsubs-overlay-host__';
    host.style.setProperty('--sub-size', fontSize + 'px');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="box" hidden>
        <div class="ja" hidden></div>
        <div class="zh" hidden></div>
        <div class="hint" hidden></div>
      </div>
      <div class="status" hidden></div>
    `;
    boxEl = shadow.querySelector('.box');
    jaEl = shadow.querySelector('.ja');
    zhEl = shadow.querySelector('.zh');
    hintEl = shadow.querySelector('.hint');
    statusEl = shadow.querySelector('.status');
  }

  // 按 showOriginal 与各行内容决定显隐
  function render() {
    const hasJa = showOriginal && !!jaEl.textContent;
    jaEl.hidden = !hasJa;
    zhEl.hidden = !zhEl.textContent;
    hintEl.hidden = !hintEl.textContent;
    boxEl.hidden = !(hasJa || !zhEl.hidden || !hintEl.hidden);
    statusEl.hidden = !boxEl.hidden; // 状态文案与字幕盒互斥
  }

  globalThis.OverlayUI = {
    // 挂载到播放器容器(重复调用安全)
    init(container) {
      ensureHost();
      if (host.parentNode !== container) container.appendChild(host);
      render();
    },

    // 显示一条字幕:ja 原文、zh 译文(null=尚无,pending=翻译中,failed=翻译失败)
    setCue({ ja = '', zh = null, pending = false, failed = false } = {}) {
      ensureHost();
      statusEl.textContent = '';
      jaEl.textContent = ja;
      zhEl.textContent = pending ? '翻译中…' : (zh != null ? zh : '');
      hintEl.textContent = failed ? '翻译失败' : '';
      render();
      host.classList.add('visible');
      host.classList.remove('stale');
    },

    // 显示状态文案(等待字幕、无字幕等)
    setStatus(text) {
      ensureHost();
      jaEl.textContent = '';
      zhEl.textContent = '';
      hintEl.textContent = '';
      statusEl.textContent = text;
      render();
      host.classList.add('visible');
      host.classList.remove('stale');
    },

    // 直播长时间无新字幕 → 淡化提示
    setStale(v) { if (host) host.classList.toggle('stale', !!v); },

    hide() { if (host) host.classList.remove('visible'); },

    setFontSize(px) {
      fontSize = px;
      if (host) host.style.setProperty('--sub-size', px + 'px');
    },

    setShowOriginal(v) {
      showOriginal = !!v;
      render();
    },

    destroy() {
      if (host) { host.remove(); host = null; boxEl = jaEl = zhEl = hintEl = statusEl = null; }
    },
  };
})();
