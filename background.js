// 豆包小窗:点击扩展图标,在独立小窗中打开/关闭豆包聊天页。
// 纯窗口管理,不注入、不读取豆包页面内容;登录态与主浏览器共享。

const DOUBAO_URL = 'https://www.doubao.com/chat/';
const STORAGE_KEY = 'popupWindowId';

// 小窗被手动关闭时,清掉记录,下次点击重新打开
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { [STORAGE_KEY]: savedId } = await chrome.storage.session.get(STORAGE_KEY);
  if (windowId === savedId) {
    await chrome.storage.session.remove(STORAGE_KEY);
  }
});

// 点击图标(或按快捷键):未开 → 弹小窗;已开 → 关闭
chrome.action.onClicked.addListener(async () => {
  const { [STORAGE_KEY]: savedId } = await chrome.storage.session.get(STORAGE_KEY);

  if (savedId != null) {
    try {
      await chrome.windows.get(savedId);
      // 小窗还开着 → 再点 = 关闭
      await chrome.windows.remove(savedId);
      await chrome.storage.session.remove(STORAGE_KEY);
      return;
    } catch {
      // 窗口已不存在(异常退出等),落到底部重新打开
    }
  }

  const win = await chrome.windows.create({
    url: DOUBAO_URL,
    type: 'popup', // 无标签栏的独立小窗
    width: 420,
    height: 700,
  });
  await chrome.storage.session.set({ [STORAGE_KEY]: win.id });
});
