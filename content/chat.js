// content/chat.js — 直播聊天(评论区)翻译。以 all_frames 注入,仅在聊天
// iframe(/live_chat)内工作;主页面同注入但直接退出。
// 观察聊天消息 DOM 的新增,逐条经 background 翻译(低优先级队列,不与
// 字幕翻译抢速),译文以小字附在原文下方。重复评论走缓存直接复用。
// 开关:跟随主标签页扩展开关(toggle 消息广播到所有 frame);
// 设置页「翻译直播聊天」可单独关闭本功能。

(() => {
  'use strict';

  const MAX_PENDING = 12;   // 在途翻译上限(评论刷太快时放弃,保住新评论)
  const MAX_CACHE = 3000;   // 原文→译文缓存上限

  let enabled = true;       // 主开关(toggle 消息同步)
  let chatOn = true;        // 设置页的「翻译直播聊天」
  let pending = 0;
  const cache = new Map();  // 原文 → 译文

  function isChatFrame() {
    return location.pathname.startsWith('/live_chat');
  }

  function loadSettings() {
    return chrome.storage.local.get('settings')
      .then(({ settings }) => {
        const s = Object.assign({}, { translateChat: true, enabled: true }, settings || {});
        chatOn = !!s.translateChat;
        enabled = !!s.enabled;
      })
      .catch(() => { /* 默认全开 */ });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const s = changes.settings.newValue || {};
    if (typeof s.translateChat === 'boolean') chatOn = s.translateChat;
  });

  // 主标签页开关:background 广播「绝对状态」(setEnabled),直接采用,不翻转。
  // 不回应 getState/toggle —— 由主框架的 captions.js 回答,iframe 抢答会错乱。
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'setEnabled' && typeof msg.enabled === 'boolean') {
      enabled = msg.enabled;
    }
  });

  function injectStyle() {
    if (document.getElementById('__ytf-chat-style__')) return;
    const style = document.createElement('style');
    style.id = '__ytf-chat-style__';
    style.textContent = `
      .ytf-chat-zh {
        display: block;
        color: #8ab4f8;
        font-size: 11px;
        line-height: 1.4;
        margin-top: 2px;
        white-space: normal;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // 翻译一条消息并附加译文行
  function handleMessage(renderer) {
    if (!enabled || !chatOn) return;
    const message = renderer.querySelector('#message');
    if (!message) return;
    const text = (message.textContent || '').trim();
    if (text.length < 2) return;
    if (cache.has(text)) { appendZh(message, cache.get(text)); return; }
    if (pending >= MAX_PENDING) return; // 评论刷太快:放弃这条,保住新评论
    pending++;
    chrome.runtime.sendMessage({ type: 'translate', text, priority: 'low' })
      .then((resp) => {
        pending--;
        if (resp && resp.ok && resp.text) {
          cache.set(text, resp.text);
          if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
          appendZh(message, resp.text);
        }
      })
      .catch(() => { pending--; });
  }

  // 译文附加在原文下方(#message 之后);已有译文则更新
  function appendZh(message, zh) {
    if (!zh || !message.isConnected) return;
    const parent = message.parentElement;
    if (!parent) return;
    let el = parent.querySelector(':scope > .ytf-chat-zh');
    if (el) { el.textContent = zh; return; }
    el = document.createElement('span');
    el.className = 'ytf-chat-zh';
    el.textContent = zh;
    message.after(el);
  }

  function scan(root) {
    if (!root.querySelectorAll) return;
    for (const r of root.querySelectorAll('yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer')) {
      if (r.__ytfDone) continue;
      r.__ytfDone = true;
      handleMessage(r);
    }
  }

  function init() {
    if (!isChatFrame()) return; // 非聊天 iframe 直接退出
    loadSettings().then(() => {
      // 查询本标签页的真实开关状态(iframe 可能晚于开关切换才加载,不能只看默认设置)
      chrome.runtime.sendMessage({ type: 'getTabEnabled' })
        .then((r) => { if (r && typeof r.enabled === 'boolean') enabled = r.enabled; })
        .catch(() => { /* 保持设置默认值 */ });
      injectStyle();
      // 观察新增消息(含置顶、超级留言、回放聊天)
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.matches &&
                node.matches('yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer')) {
              if (node.__ytfDone) continue;
              node.__ytfDone = true;
              handleMessage(node);
            } else {
              scan(node);
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      scan(document.body); // 打开页面时已存在的消息
    });
  }

  init();
})();
