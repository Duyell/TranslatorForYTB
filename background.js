// background.js — 服务工作者:翻译代理 + 工具栏按钮开关 + badge 状态。
// 翻译调用统一走这里:host_permissions 已授权 translate.googleapis.com(无 CORS),
// 自定义 OpenAI 兼容 API 走 optional_host_permissions(设置页保存时按需授权)。
// 安全:翻译请求不接受调用方传入的任何 URL / Key,一律读取本地设置。
// badge:绿色「开」/灰色「关」显示当前标签页的字幕翻译开关状态。

'use strict';

// ---------- 设置 ----------

const DEFAULT_SETTINGS = {
  engine: 'google',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  showOriginal: true,
  fontSize: 20,
  enabled: true,
};

let settings = null; // 设置缓存(SW 常被回收,首次使用时从 storage 读)

async function getSettings() {
  if (settings) return settings;
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = Object.assign({}, DEFAULT_SETTINGS, saved || {});
  return settings;
}

// 设置页保存后刷新缓存
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
  }
});

// ---------- 消息处理 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'translate' || msg.type === 'testTranslate') {
    // 异步翻译,return true 保持消息通道
    translateText(msg.text)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});

// ---------- 翻译实现 ----------

const MAX_TEXT_LEN = 6000;      // 单次翻译文本上限(防滥用)
const GOOGLE_CHUNK_LEN = 4500;  // Google 接口单请求字符上限(~5000)
const GOOGLE_MIN_INTERVAL = 350; // Google 请求最小间隔(ms),防限流
const GOOGLE_BACKOFF = [5000, 20000]; // 429/503 退避:5s、20s,仍失败报可重试错
const FETCH_TIMEOUT = 12000;    // 单次请求超时(ms):防止连接挂起把翻译队列永久卡死

let lastGoogleCall = 0;
let googleBusy = Promise.resolve(); // 串行化 Google 请求

// 带超时的 fetch:代理/网络把连接挂起时,超时后走重试,而不是永远等下去
async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function translateText(text) {
  if (typeof text !== 'string') throw new Error('翻译内容必须是文本');
  text = text.trim();
  if (!text) throw new Error('翻译内容为空');
  if (text.length > MAX_TEXT_LEN) throw new Error('文本过长');
  const s = await getSettings();
  if (s.engine === 'custom') {
    if (!s.customBaseUrl || !s.customApiKey || !s.customModel) {
      throw new Error('请先在设置页填写 API Base URL / Key / 模型名');
    }
    return customTranslate(s, text);
  }
  return googleTranslate(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function googleTranslate(text) {
  const run = googleBusy.then(async () => {
    const chunks = chunkBySentence(text, GOOGLE_CHUNK_LEN);
    const parts = [];
    for (const chunk of chunks) {
      const wait = lastGoogleCall + GOOGLE_MIN_INTERVAL - Date.now();
      if (wait > 0) await sleep(wait);
      lastGoogleCall = Date.now();
      parts.push(await googleRequest(chunk));
    }
    return parts.join('');
  });
  googleBusy = run.catch(() => {}); // 错误不断链,后续请求继续执行
  return run;
}

// 按句边界切成 ≤maxLen 的块(日语句子分隔符:。!?…、换行)
function chunkBySentence(text, maxLen) {
  const sentences = text.match(/[^。!?！？…\n]+[。!?！？…]?|\n+/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > maxLen && cur) {
      chunks.push(cur);
      cur = s;
      // 单句仍超长:硬切
      while (cur.length > maxLen) {
        chunks.push(cur.slice(0, maxLen));
        cur = cur.slice(maxLen);
      }
    } else {
      cur += s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function googleRequest(chunk) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=zh-CN&dt=t&q=' + encodeURIComponent(chunk);
  for (let attempt = 0; attempt <= GOOGLE_BACKOFF.length; attempt++) {
    if (attempt > 0) await sleep(GOOGLE_BACKOFF[attempt - 1]);
    let res;
    try {
      res = await fetchWithTimeout(url, null, FETCH_TIMEOUT);
    } catch (e) {
      if (attempt < GOOGLE_BACKOFF.length) continue; // 网络错误/超时,退避重试
      throw new Error('网络不通或请求超时,无法访问 Google 翻译(请检查代理)');
    }
    if (res.status === 429 || res.status === 503) continue; // 限流,退避重试
    if (!res.ok) throw new Error(`Google 翻译服务错误(${res.status})`);
    const data = await res.json();
    const text = (data[0] || []).map((it) => (it && it[0]) || '').join('');
    if (!text) {
      if (attempt < GOOGLE_BACKOFF.length) continue;
      throw new Error('Google 翻译返回为空');
    }
    return text;
  }
  throw new Error('Google 翻译暂时限流,稍后自动重试');
}

async function customTranslate(s, text) {
  const base = s.customBaseUrl.trim().replace(/\/+$/, '');
  const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + s.customApiKey.trim(),
      },
      body: JSON.stringify({
        model: s.customModel.trim(),
        messages: [
          { role: 'system', content: '你是日译中字幕翻译。只输出简体中文译文,不要解释,不要附原文。' },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
      }),
    }, FETCH_TIMEOUT);
  } catch (e) {
    throw new Error('网络不通、请求超时或该 API 不允许浏览器跨域,请在设置页点「保存」授权域名');
  }
  if (res.status === 401) throw new Error('API Key 无效,请检查设置');
  if (res.status === 404) throw new Error('接口未找到,请检查 Base URL / 模型名');
  if (!res.ok) throw new Error(`API 错误(${res.status})`);
  const data = await res.json();
  const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!out) throw new Error('API 返回为空,请检查模型名');
  return String(out).trim();
}

// ---------- 工具栏按钮 ----------

const YOUTUBE_RE = /^https?:\/\/(www|m)\.youtube\.com\//i;

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && YOUTUBE_RE.test(tab.url)) {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
      updateBadge(tab.id, resp && resp.enabled);
    } catch {
      // 内容脚本未就绪(页面刚加载):刷新 badge 即可,用户再点一次即生效
      updateBadge(tab.id);
    }
  } else {
    chrome.runtime.openOptionsPage();
  }
});

// ---------- badge ----------

async function updateBadge(tabId, enabled) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; } // 标签已关闭
  if (enabled == null) {
    if (!tab.url || !YOUTUBE_RE.test(tab.url)) {
      chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'getState' });
      enabled = resp ? resp.enabled : null;
    } catch {
      enabled = null; // 内容脚本不在 → 不显示 badge
    }
  }
  if (enabled == null) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  chrome.action.setBadgeText({ tabId, text: enabled ? '开' : '关' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: enabled ? '#16a34a' : '#6b7280' });
}

chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // 页面加载完成后内容脚本就绪,刷新一次 badge
  if (info.status === 'complete') updateBadge(tabId);
});
