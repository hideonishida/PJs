/**
 * NotebookLM Bulk Delete - Content Script
 * NotebookLMページのDOMと対話してソース情報の取得・削除を行う
 */

// ページ内にUIが既に注入されているか確認するフラグ
let panelInjected = false;
let deleteInProgress = false;

// ========== メッセージハンドラ ==========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'getSources':
      getSources().then(sources => sendResponse({ success: true, sources }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // 非同期レスポンス

    case 'deleteSources':
      if (deleteInProgress) {
        sendResponse({ success: false, error: '削除が既に進行中です' });
        return true;
      }
      deleteSources(message.sourceIds, (progress) => {
        // 進捗をポップアップへ通知
        chrome.runtime.sendMessage({ action: 'deleteProgress', ...progress }).catch(() => {});
      }).then(result => sendResponse({ success: true, ...result }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'ping':
      sendResponse({ alive: true });
      return false;
  }
});

// ========== ソース取得 ==========
async function getSources() {
  // NotebookLMのソースパネルが読み込まれるまで待機
  await waitForElement('[data-source-id], source-panel-item, .source-item, [class*="source"]', 5000)
    .catch(() => null);

  const sources = [];
  const seen = new Set();

  // 複数のセレクタ候補を試す（NotebookLMのDOM構造に合わせて）
  const candidates = findSourceElements();

  for (const el of candidates) {
    const id = extractSourceId(el);
    const title = extractSourceTitle(el);
    if (id && !seen.has(id)) {
      seen.add(id);
      sources.push({ id, title: title || '(タイトル不明)', element: null });
    }
  }

  return sources;
}

/**
 * ページからソース要素を探す
 * NotebookLMのDOMはアップデートにより変わる可能性があるため複数の方法を試す
 */
function findSourceElements() {
  const results = [];

  // 方法1: data-source-id 属性
  results.push(...document.querySelectorAll('[data-source-id]'));

  // 方法2: ソースリスト内の各アイテム
  const sourceListSelectors = [
    'source-list-item',
    '[class*="SourceChip"]',
    '[class*="source-chip"]',
    '[class*="SourceCard"]',
    '[class*="source-card"]',
    '[class*="SourceItem"]',
    '[class*="source-item"]',
    'ul[aria-label*="ource"] > li',
    'ul[aria-label*="ソース"] > li',
    '.sources-panel-source',
  ];

  for (const sel of sourceListSelectors) {
    try {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) results.push(...els);
    } catch (_) { /* ignore */ }
  }

  // 方法3: aria-label でソースと判断できる要素
  const allButtons = document.querySelectorAll('[role="listitem"], [role="option"]');
  for (const el of allButtons) {
    const label = el.getAttribute('aria-label') || '';
    if (label && !label.includes('ノートブック') && !label.includes('チャット')) {
      results.push(el);
    }
  }

  // 重複排除
  return [...new Set(results)];
}

function extractSourceId(el) {
  // data属性から直接取得
  if (el.dataset.sourceId) return el.dataset.sourceId;
  if (el.dataset.id) return el.dataset.id;

  // aria-label
  const label = el.getAttribute('aria-label');
  if (label) return `aria:${label}`;

  // テキスト内容をIDとして利用
  const text = el.textContent?.trim();
  if (text) return `text:${text.substring(0, 80)}`;

  return null;
}

function extractSourceTitle(el) {
  // aria-label が一番信頼できる
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;

  // data-title
  if (el.dataset.title) return el.dataset.title;

  // 見出し・ラベル要素を探す
  const titleSelectors = [
    '[class*="title"]',
    '[class*="Title"]',
    '[class*="name"]',
    '[class*="Name"]',
    'h3', 'h4', 'h5',
    'span[class*="label"]',
    'p',
  ];

  for (const sel of titleSelectors) {
    const titleEl = el.querySelector(sel);
    if (titleEl?.textContent?.trim()) return titleEl.textContent.trim();
  }

  return el.textContent?.trim().substring(0, 100) || null;
}

// ========== ソース削除 ==========
async function deleteSources(sourceIds, onProgress) {
  deleteInProgress = true;
  let deleted = 0;
  let failed = 0;
  const errors = [];

  try {
    for (let i = 0; i < sourceIds.length; i++) {
      const sourceId = sourceIds[i];
      onProgress({
        current: i + 1,
        total: sourceIds.length,
        deleted,
        failed,
        status: 'deleting',
        currentId: sourceId,
      });

      const success = await deleteSource(sourceId);
      if (success) {
        deleted++;
      } else {
        failed++;
        errors.push(sourceId);
      }

      // 連続削除時はサーバー負荷を抑えるため短い待機
      if (i < sourceIds.length - 1) {
        await sleep(800);
      }
    }
  } finally {
    deleteInProgress = false;
  }

  onProgress({
    current: sourceIds.length,
    total: sourceIds.length,
    deleted,
    failed,
    status: 'done',
  });

  return { deleted, failed, errors };
}

async function deleteSource(sourceId) {
  // IDに対応するDOM要素を再取得（削除後にDOMが変わるため毎回取得）
  const el = findSourceElementById(sourceId);
  if (!el) {
    console.warn('[NotebookLM Bulk Delete] 要素が見つかりません:', sourceId);
    return false;
  }

  try {
    // メニューボタン（...）を探してクリック
    const menuButton = findMenuButton(el);
    if (!menuButton) {
      // メニューボタンが見つからない場合、要素をホバーして再試行
      simulateHover(el);
      await sleep(300);
      const menuButtonAfterHover = findMenuButton(el);
      if (!menuButtonAfterHover) {
        console.warn('[NotebookLM Bulk Delete] メニューボタンが見つかりません:', sourceId);
        return false;
      }
      menuButtonAfterHover.click();
    } else {
      menuButton.click();
    }

    // ドロップダウンメニューが開くのを待つ
    await sleep(400);

    // 削除メニュー項目を探してクリック
    const deleteItem = findDeleteMenuItem();
    if (!deleteItem) {
      // メニューを閉じる
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      console.warn('[NotebookLM Bulk Delete] 削除メニューが見つかりません:', sourceId);
      return false;
    }

    deleteItem.click();
    await sleep(300);

    // 確認ダイアログが出る場合は確認ボタンをクリック
    const confirmed = await confirmDeletion();
    if (!confirmed) {
      console.warn('[NotebookLM Bulk Delete] 削除確認に失敗:', sourceId);
      return false;
    }

    // 削除完了を待つ
    await sleep(600);
    return true;

  } catch (err) {
    console.error('[NotebookLM Bulk Delete] 削除エラー:', err);
    return false;
  }
}

function findSourceElementById(sourceId) {
  // data-source-id
  if (sourceId.startsWith('aria:')) {
    const ariaLabel = sourceId.slice(5);
    return document.querySelector(`[aria-label="${CSS.escape(ariaLabel)}"]`);
  }
  if (sourceId.startsWith('text:')) {
    const text = sourceId.slice(5);
    const all = findSourceElements();
    return all.find(el => el.textContent?.trim().startsWith(text)) || null;
  }
  // data-source-id など
  return document.querySelector(`[data-source-id="${CSS.escape(sourceId)}"]`)
    || document.querySelector(`[data-id="${CSS.escape(sourceId)}"]`);
}

function findMenuButton(parentEl) {
  const selectors = [
    'button[aria-label*="その他"]',
    'button[aria-label*="More"]',
    'button[aria-label*="メニュー"]',
    'button[aria-label*="menu"]',
    'button[aria-label*="option"]',
    'button[aria-haspopup="true"]',
    'button[aria-haspopup="menu"]',
    '[role="button"][aria-haspopup]',
    'button:has(mat-icon)',
    'button.more-button',
    '[class*="MoreButton"]',
    '[class*="more-button"]',
    '[class*="menu-trigger"]',
    '[class*="MenuTrigger"]',
    // Material Design の3点アイコン
    'button[data-mat-icon-name="more_vert"]',
    'button[data-mat-icon-name="more_horiz"]',
  ];

  for (const sel of selectors) {
    try {
      const btn = parentEl.querySelector(sel);
      if (btn) return btn;
    } catch (_) { /* ignore */ }
  }

  // ページ全体から最後にフォーカスされた要素周辺を探す
  return null;
}

function findDeleteMenuItem() {
  // 開かれたドロップダウン内の削除項目を探す
  const menuSelectors = [
    '[role="menu"]',
    '[role="listbox"]',
    'mat-menu',
    '[class*="dropdown"]',
    '[class*="Dropdown"]',
    '[class*="popover"]',
    '[class*="Popover"]',
    '[class*="context-menu"]',
  ];

  let menu = null;
  for (const sel of menuSelectors) {
    try {
      menu = document.querySelector(sel);
      if (menu) break;
    } catch (_) { /* ignore */ }
  }

  const searchRoot = menu || document;

  const deleteKeywords = ['削除', 'Delete', 'Remove', 'delete', 'remove'];
  const itemSelectors = [
    '[role="menuitem"]',
    '[role="option"]',
    'button',
    'li',
    'a',
  ];

  for (const sel of itemSelectors) {
    const items = searchRoot.querySelectorAll(sel);
    for (const item of items) {
      const text = item.textContent?.trim() || '';
      const ariaLabel = item.getAttribute('aria-label') || '';
      for (const kw of deleteKeywords) {
        if (text.includes(kw) || ariaLabel.includes(kw)) {
          return item;
        }
      }
    }
  }

  return null;
}

async function confirmDeletion() {
  // 確認ダイアログを待つ（最大1秒）
  for (let i = 0; i < 5; i++) {
    const confirmBtn = findConfirmButton();
    if (confirmBtn) {
      confirmBtn.click();
      return true;
    }
    await sleep(200);
  }
  // 確認ダイアログがない場合も成功とみなす
  return true;
}

function findConfirmButton() {
  const keywords = ['削除', 'Delete', 'OK', '確認', 'Confirm', 'Yes', 'はい'];
  const dangerous = ['キャンセル', 'Cancel', 'No', 'いいえ'];

  // ダイアログ内を優先
  const dialog = document.querySelector('[role="dialog"], mat-dialog-container, [class*="dialog"], [class*="Dialog"]');
  const searchRoot = dialog || document;

  const buttons = searchRoot.querySelectorAll('button');
  for (const btn of buttons) {
    const text = btn.textContent?.trim() || '';
    const isCancel = dangerous.some(kw => text.includes(kw));
    if (isCancel) continue;
    const isConfirm = keywords.some(kw => text.includes(kw));
    if (isConfirm) return btn;
  }

  return null;
}

// ========== ユーティリティ ==========
function simulateHover(el) {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) { resolve(el); return; }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`タイムアウト: ${selector} が見つかりませんでした`));
    }, timeout);
  });
}

// コンテンツスクリプト準備完了を通知
console.log('[NotebookLM Bulk Delete] content script loaded');
