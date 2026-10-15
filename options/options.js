// options/options.js — 设置页逻辑。
// 保存到 chrome.storage.local;选择自定义引擎时按需申请域名权限(解除 CORS);
// 「测试翻译」先把当前表单落盘,再经 background 用实际配置翻译。

'use strict';

const DEFAULT_SETTINGS = {
  engine: 'google',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  showOriginal: true,
  fontSize: 20,
  enabled: true,
  asrApiKey: '',
  asrLanguage: 'ja-JP',
  translateChat: true,
  targetLang: 'zh-CN',
  translateSubtitle: true,
};

const $ = (id) => document.getElementById(id);

async function init() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  document.querySelector(`input[name="engine"][value="${s.engine === 'custom' ? 'custom' : 'google'}"]`).checked = true;
  $('customBaseUrl').value = s.customBaseUrl;
  $('customApiKey').value = s.customApiKey;
  $('customModel').value = s.customModel;
  $('showOriginal').checked = s.showOriginal;
  $('fontSize').value = s.fontSize;
  $('fontSizeVal').textContent = s.fontSize + ' px';
  $('enabled').checked = s.enabled;
  $('translateChat').checked = s.translateChat;
  $('translateSubtitle').checked = s.translateSubtitle;
  $('targetLang').value = s.targetLang;
  $('asrApiKey').value = s.asrApiKey;
  $('asrLanguage').value = s.asrLanguage;
  syncEngineUI();
}

function syncEngineUI() {
  const custom = document.querySelector('input[name="engine"]:checked').value === 'custom';
  $('customFields').hidden = !custom;
}

function collect() {
  return {
    engine: document.querySelector('input[name="engine"]:checked').value,
    customBaseUrl: $('customBaseUrl').value.trim(),
    customApiKey: $('customApiKey').value.trim(),
    customModel: $('customModel').value.trim(),
    showOriginal: $('showOriginal').checked,
    fontSize: Number($('fontSize').value),
    enabled: $('enabled').checked,
    translateChat: $('translateChat').checked,
    translateSubtitle: $('translateSubtitle').checked,
    targetLang: $('targetLang').value.trim() || 'zh-CN',
    asrApiKey: $('asrApiKey').value.trim(),
    asrLanguage: $('asrLanguage').value.trim(),
  };
}

function validate(s) {
  if (s.engine === 'custom') {
    if (!s.customBaseUrl || !s.customApiKey || !s.customModel) {
      return '请填写 API Base URL、Key 和模型名';
    }
    try { new URL(s.customBaseUrl); } catch { return 'API Base URL 格式不正确'; }
  }
  return null;
}

// 保存表单;自定义引擎时申请域名权限(用户拒绝也不阻塞,依赖 API 自带 CORS 头兜底)
async function save(quiet) {
  const s = collect();
  const err = validate(s);
  if (err) {
    if (!quiet) $('saveStatus').textContent = '❌ ' + err;
    throw new Error(err);
  }
  await chrome.storage.local.set({ settings: s });
  if (s.engine === 'custom') {
    try {
      const origin = new URL(s.customBaseUrl).origin;
      await chrome.permissions.request({ origins: [origin + '/*'] });
    } catch { /* 用户拒绝或域名解析失败:忽略 */ }
  }
  if (!quiet) $('saveStatus').textContent = '✅ 已保存';
}

async function testTranslate() {
  $('testResult').textContent = '翻译中…';
  try {
    await save(true); // 先落盘表单值,background 读设置翻译
  } catch (e) {
    $('testResult').textContent = '❌ ' + e.message;
    return;
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'testTranslate', text: 'こんにちは、世界' });
    if (resp && resp.ok) $('testResult').textContent = '✅ 译文:' + resp.text;
    else $('testResult').textContent = '❌ ' + ((resp && resp.error) || '未知错误');
  } catch (e) {
    $('testResult').textContent = '❌ ' + (e.message || '扩展后台未响应,请重新加载扩展');
  }
}

// 导出当前设置到 JSON 文件(含 API Key,明文 —— 提示用户妥善保管)
async function exportSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const blob = new Blob([JSON.stringify({ settings: settings || {} }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'translatorforytb-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  $('importResult').textContent = '✅ 已导出 translatorforytb-settings.json';
}

// 从 JSON 文件导入设置(直接写入 storage,各页面实时生效)
async function importSettings(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const s = data.settings;
    if (!s || typeof s !== 'object') throw new Error('文件格式不正确(缺少 settings 字段)');
    await chrome.storage.local.set({ settings: Object.assign({}, DEFAULT_SETTINGS, s) });
    await init(); // 刷新表单
    $('importResult').textContent = '✅ 导入成功。若用了自定义引擎,请再点一次「保存」以授权其域名';
  } catch (e) {
    $('importResult').textContent = '❌ 导入失败: ' + (e.message || String(e));
  }
}

// 测试识别 Key:先落盘,再用静音音频探测 Key 有效性(经 background)
async function testAsr() {
  $('asrTestResult').textContent = '测试中…';
  try {
    await save(true);
  } catch (e) {
    $('asrTestResult').textContent = '❌ ' + e.message;
    return;
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'asrTest' });
    if (resp && resp.ok) $('asrTestResult').textContent = '✅ ' + resp.text;
    else $('asrTestResult').textContent = '❌ ' + ((resp && resp.error) || '未知错误');
  } catch (e) {
    $('asrTestResult').textContent = '❌ ' + (e.message || '扩展后台未响应,请重新加载扩展');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  for (const r of document.querySelectorAll('input[name="engine"]')) {
    r.addEventListener('change', syncEngineUI);
  }
  $('fontSize').addEventListener('input', () => { $('fontSizeVal').textContent = $('fontSize').value + ' px'; });
  $('saveBtn').addEventListener('click', () => save(false));
  $('testBtn').addEventListener('click', testTranslate);
  $('asrTestBtn').addEventListener('click', testAsr);
  $('exportBtn').addEventListener('click', exportSettings);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) importSettings(e.target.files[0]);
    e.target.value = ''; // 允许重复导入同一文件
  });
});
