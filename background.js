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
  asrApiKey: '',    // 语音识别:新版豆包语音控制台签发的 API Key(火山方舟的 Key 不通用)
  asrLanguage: 'ja-JP', // 识别语言;留空 = 自动检测
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
  if (msg.type === 'asrStart') {
    startAsr(sender.tab && sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'asrStop') {
    stopAsr().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'asrAudio') {
    // 来自 offscreen 文档的音频分块:sender.tab 不存在,结果转发用 asrTabId
    handleAsrAudio(msg)
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'asrTest') {
    // 设置页「测试识别」:静音 WAV 探测 Key 是否有效
    testAsrKey()
      .then((r) => sendResponse(r))
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

// ---------- 实时语音识别(ASR,火山引擎极速版) ----------

const ASR_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const ASR_RESOURCE_ID = 'volc.bigasr.auc_turbo'; // 极速版固定资源 ID
const ASR_FETCH_TIMEOUT = 15000; // 识别请求超时(ms)

let asrTabId = null; // 正在采集音频的目标标签页 id

// 内容脚本请求开启 ASR:申请标签页音频流 → 建 offscreen 文档消费
async function startAsr(tabId) {
  if (tabId == null) throw new Error('无法确定目标标签页');
  const s = await getSettings();
  if (!s.asrApiKey) throw new Error('未配置语音识别 API Key(设置页 → 语音识别)');
  if (asrTabId === tabId && (await hasOffscreen())) return; // 已在运行
  await stopAsr(); // 先清掉上一轮(切换标签/重启采集)
  // Chrome 116+:SW 可带 targetTabId 直接申请流,无需用户手势
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    throw new Error('无法捕获标签页音频: ' + (err.message || String(err)));
  }
  await createOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: 'asrInit', streamId });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || '音频采集启动失败');
  asrTabId = tabId;
  console.log('[YTSUB-ASR] 已启动,目标标签', tabId);
}

async function stopAsr() {
  asrTabId = null;
  try { await chrome.offscreen.closeDocument(); } catch { /* 已关闭 */ }
}

async function hasOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function createOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '采集标签页音频用于实时语音识别(无字幕时的兜底方案)',
  });
}

// offscreen 每 7 秒发来一块 WAV(Base64)→ 调极速版识别 → 转发给内容脚本
async function handleAsrAudio(msg) {
  const tabId = asrTabId;
  let text = '';
  let error = null;
  try {
    text = await transcribeChunk(msg.wavBase64);
  } catch (err) {
    error = err.message || String(err);
    console.log('[YTSUB-ASR] 识别失败:', error);
  }
  if (tabId != null) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'asrResult', text, error }); } catch { /* 标签已关闭 */ }
  }
  return { ok: true, text };
}

// 火山极速版识别:base64 WAV → 文本。状态在响应头 X-Api-Status-Code
// (HTTP 状态码可能恒为 200):20000000 成功 / 20000003 静音空结果
async function transcribeChunk(wavBase64) {
  const s = await getSettings();
  if (!s.asrApiKey) throw new Error('未配置语音识别 API Key');
  const audio = { data: wavBase64 };
  if (s.asrLanguage) audio.language = s.asrLanguage;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2000); // 重试一次(网络抖动/服务繁忙)
    let res;
    try {
      res = await fetchWithTimeout(ASR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': s.asrApiKey.trim(),
          'X-Api-Resource-Id': ASR_RESOURCE_ID,
          'X-Api-Request-Id': crypto.randomUUID(),
          'X-Api-Sequence': '-1',
        },
        body: JSON.stringify({
          user: { uid: 'translator-for-browser' },
          audio,
          request: {
            model_name: 'bigmodel',
            enable_punc: true,
            enable_itn: true,
            enable_ddc: false,
            show_utterances: true,
          },
        }),
      }, ASR_FETCH_TIMEOUT);
    } catch (err) {
      lastErr = new Error('语音识别请求失败(网络/超时)');
      continue;
    }
    const status = res.headers.get('X-Api-Status-Code') || '';
    if (status === '20000003') return ''; // 静音:无有效语音
    if (status !== '20000000') {
      if (res.status === 401 || res.status === 403) {
        throw new Error('语音识别 API Key 无效(注意:需要新版豆包语音控制台的 Key,火山方舟的 Key 不通用)');
      }
      if (/^550/.test(status) || res.status === 429) {
        lastErr = new Error('语音识别服务繁忙(' + status + ')');
        continue; // 可重试
      }
      throw new Error('语音识别失败: ' + (status || 'HTTP ' + res.status));
    }
    const data = await res.json();
    return String((data && data.result && data.result.text) || '').trim();
  }
  throw lastErr || new Error('语音识别失败');
}

// 设置页「测试识别」:发一段静音 WAV 探测 Key 有效性
// (服务端先校验参数再鉴权,静音返回 20000003 = Key 有效;401/403 = Key 无效)
async function testAsrKey() {
  const s = await getSettings();
  if (!s.asrApiKey) throw new Error('请先填写语音识别 API Key');
  const sampleRate = 16000;
  const numSamples = sampleRate; // 1 秒静音
  const wav = new Uint8Array(44 + numSamples * 2);
  const view = new DataView(wav.buffer);
  const ascii = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + numSamples * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, numSamples * 2, true);
  let bin = '';
  for (let i = 0; i < wav.length; i += 0x8000) bin += String.fromCharCode.apply(null, wav.subarray(i, i + 0x8000));
  const base64 = btoa(bin);

  const res = await fetchWithTimeout(ASR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': s.asrApiKey.trim(),
      'X-Api-Resource-Id': ASR_RESOURCE_ID,
      'X-Api-Request-Id': crypto.randomUUID(),
      'X-Api-Sequence': '-1',
    },
    body: JSON.stringify({
      user: { uid: 'translator-for-browser' },
      audio: { data: base64 },
      request: { model_name: 'bigmodel' },
    }),
  }, ASR_FETCH_TIMEOUT);
  const status = res.headers.get('X-Api-Status-Code') || '';
  if (status === '20000000' || status === '20000003') return { ok: true, text: 'Key 有效 ✓' };
  if (res.status === 401 || res.status === 403) {
    throw new Error('Key 无效或未开通极速版服务(需在豆包语音控制台开通「录音文件识别大模型-极速版」)');
  }
  throw new Error('识别服务返回: ' + (status || 'HTTP ' + res.status));
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
