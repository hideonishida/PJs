/**
 * NotebookLM Bulk Delete - Popup Script
 * ポップアップのUI制御とコンテンツスクリプトとの通信
 */

// ========== 状態管理 ==========
const state = {
  sources: [],         // 全ソース
  selected: new Set(), // 選択中のソースID
  filtered: [],        // フィルタ後のソース
  searchQuery: '',
};

// ========== DOM参照 ==========
const $ = id => document.getElementById(id);

const els = {
  loadingState:       $('loadingState'),
  errorState:         $('errorState'),
  errorMessage:       $('errorMessage'),
  mainContent:        $('mainContent'),
  sourceList:         $('sourceList'),
  selectAll:          $('selectAll'),
  selectedCount:      $('selectedCount'),
  searchInput:        $('searchInput'),
  deleteBtn:          $('deleteBtn'),
  cancelBtn:          $('cancelBtn'),
  refreshBtn:         $('refreshBtn'),
  retryBtn:           $('retryBtn'),
  footer:             $('footer'),
  deleteOverlay:      $('deleteOverlay'),
  deleteProgressText: $('deleteProgressText'),
  progressBar:        $('progressBar'),
  progressFraction:   $('progressFraction'),
  statusArea:         $('statusArea'),
  statusMessage:      $('statusMessage'),
  noSourcesMsg:       $('noSourcesMsg'),
  noSearchResults:    $('noSearchResults'),
};

// ========== 初期化 ==========
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadSources();
});

function bindEvents() {
  els.refreshBtn.addEventListener('click', loadSources);
  els.retryBtn.addEventListener('click', loadSources);
  els.selectAll.addEventListener('change', onSelectAllChange);
  els.searchInput.addEventListener('input', onSearch);
  els.deleteBtn.addEventListener('click', onDeleteClick);
  els.cancelBtn.addEventListener('click', clearSelection);

  // 削除中の進捗を受け取る
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'deleteProgress') {
      updateDeleteProgress(msg);
    }
  });
}

// ========== ソース読み込み ==========
async function loadSources() {
  showLoading();
  hideStatus();

  try {
    const tab = await getActiveTab();
    if (!isNotebookLMTab(tab)) {
      showError('NotebookLMのページを開いてください。\nhttps://notebooklm.google.com');
      return;
    }

    // コンテンツスクリプトが読み込まれているか確認
    const alive = await pingContentScript(tab.id);
    if (!alive) {
      // コンテンツスクリプトをインジェクト
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      await sleep(500);
    }

    const response = await sendToContent(tab.id, { action: 'getSources' });
    if (!response?.success) {
      throw new Error(response?.error || 'ソースの取得に失敗しました');
    }

    state.sources = response.sources || [];
    state.selected.clear();
    state.searchQuery = '';
    els.searchInput.value = '';
    applyFilter();
    showMain();

  } catch (err) {
    console.error('[popup] loadSources error:', err);
    showError(err.message || 'ソースの取得中にエラーが発生しました');
  }
}

// ========== フィルタ・レンダリング ==========
function applyFilter() {
  const q = state.searchQuery.toLowerCase();
  state.filtered = q
    ? state.sources.filter(s => s.title.toLowerCase().includes(q))
    : [...state.sources];

  renderSourceList();
  updateControls();
}

function renderSourceList() {
  els.sourceList.innerHTML = '';

  if (state.sources.length === 0) {
    els.noSourcesMsg.classList.remove('hidden');
    els.noSearchResults.classList.add('hidden');
    return;
  }

  els.noSourcesMsg.classList.add('hidden');

  if (state.filtered.length === 0) {
    els.noSearchResults.classList.remove('hidden');
    return;
  }

  els.noSearchResults.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  for (const source of state.filtered) {
    fragment.appendChild(createSourceItem(source));
  }
  els.sourceList.appendChild(fragment);
}

function createSourceItem(source) {
  const li = document.createElement('li');
  li.className = 'source-item' + (state.selected.has(source.id) ? ' selected' : '');
  li.dataset.id = source.id;
  li.setAttribute('role', 'listitem');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'source-checkbox';
  checkbox.checked = state.selected.has(source.id);
  checkbox.setAttribute('aria-label', source.title);

  const iconSvg = createSourceIcon();

  const titleSpan = document.createElement('span');
  titleSpan.className = 'source-title';
  titleSpan.textContent = source.title;
  titleSpan.title = source.title; // tooltip

  li.appendChild(checkbox);
  li.appendChild(iconSvg);
  li.appendChild(titleSpan);

  // クリックで選択切り替え
  li.addEventListener('click', (e) => {
    if (e.target === checkbox) return; // チェックボックス直接クリックは別イベント
    toggleSelection(source.id, li, checkbox);
  });

  checkbox.addEventListener('change', () => {
    toggleSelection(source.id, li, checkbox, checkbox.checked);
  });

  return li;
}

function createSourceIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'source-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z');
  path.setAttribute('fill', 'currentColor');

  svg.appendChild(path);
  return svg;
}

function toggleSelection(id, liEl, checkbox, forceState) {
  const newState = forceState !== undefined ? forceState : !state.selected.has(id);

  if (newState) {
    state.selected.add(id);
    liEl.classList.add('selected');
    checkbox.checked = true;
  } else {
    state.selected.delete(id);
    liEl.classList.remove('selected');
    checkbox.checked = false;
  }

  updateControls();
}

// ========== コントロール更新 ==========
function updateControls() {
  const total = state.filtered.length;
  const selectedInFiltered = state.filtered.filter(s => state.selected.has(s.id)).length;
  const totalSelected = state.selected.size;

  // 全選択チェックボックス
  els.selectAll.checked = total > 0 && selectedInFiltered === total;
  els.selectAll.indeterminate = selectedInFiltered > 0 && selectedInFiltered < total;

  // 選択数ラベル
  els.selectedCount.textContent = totalSelected > 0 ? `${totalSelected} 件選択中` : '0 件選択中';
  els.selectedCount.className = 'selected-count' + (totalSelected > 0 ? ' has-selection' : '');

  // 削除ボタン
  els.deleteBtn.disabled = totalSelected === 0;

  // キャンセルボタン
  els.cancelBtn.style.visibility = totalSelected > 0 ? 'visible' : 'hidden';
}

// ========== イベントハンドラ ==========
function onSelectAllChange() {
  const check = els.selectAll.checked;
  for (const source of state.filtered) {
    if (check) {
      state.selected.add(source.id);
    } else {
      state.selected.delete(source.id);
    }
  }
  // DOM更新
  const items = els.sourceList.querySelectorAll('.source-item');
  items.forEach(li => {
    const id = li.dataset.id;
    const checkbox = li.querySelector('.source-checkbox');
    if (check) {
      li.classList.add('selected');
      if (checkbox) checkbox.checked = true;
    } else {
      li.classList.remove('selected');
      if (checkbox) checkbox.checked = false;
    }
  });
  updateControls();
}

function onSearch() {
  state.searchQuery = els.searchInput.value;
  applyFilter();
}

function clearSelection() {
  state.selected.clear();
  const items = els.sourceList.querySelectorAll('.source-item');
  items.forEach(li => {
    li.classList.remove('selected');
    const cb = li.querySelector('.source-checkbox');
    if (cb) cb.checked = false;
  });
  updateControls();
}

async function onDeleteClick() {
  const selectedIds = [...state.selected];
  if (selectedIds.length === 0) return;

  const confirmed = window.confirm(
    `選択した ${selectedIds.length} 件のソースを削除しますか？\nこの操作は取り消せません。`
  );
  if (!confirmed) return;

  showDeleteOverlay();

  try {
    const tab = await getActiveTab();
    const response = await sendToContent(tab.id, {
      action: 'deleteSources',
      sourceIds: selectedIds,
    });

    hideDeleteOverlay();

    if (response?.success) {
      const { deleted, failed } = response;
      if (failed > 0) {
        showStatus(`${deleted} 件削除しました（${failed} 件失敗）`, 'error');
      } else {
        showStatus(`${deleted} 件のソースを削除しました`, 'success');
      }
      // リストを再読み込み
      await sleep(800);
      await loadSources();
    } else {
      showStatus(response?.error || '削除に失敗しました', 'error');
    }

  } catch (err) {
    hideDeleteOverlay();
    showStatus(err.message || '削除中にエラーが発生しました', 'error');
    console.error('[popup] delete error:', err);
  }
}

// ========== 削除進捗 ==========
function updateDeleteProgress(progress) {
  const { current, total, deleted, failed, status, currentId } = progress;

  if (status === 'done') {
    els.deleteProgressText.textContent = `完了 (削除: ${deleted}, 失敗: ${failed})`;
    els.progressBar.style.width = '100%';
    els.progressFraction.textContent = `${total} / ${total}`;
    return;
  }

  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  els.progressBar.style.width = `${pct}%`;
  els.progressFraction.textContent = `${current} / ${total}`;

  const title = currentId?.startsWith('aria:')
    ? currentId.slice(5).substring(0, 30)
    : currentId?.substring(0, 30) || '';
  els.deleteProgressText.textContent = title ? `「${title}」を削除中...` : '削除中...';
}

// ========== 表示切り替え ==========
function showLoading() {
  els.loadingState.classList.remove('hidden');
  els.errorState.classList.add('hidden');
  els.mainContent.classList.add('hidden');
  els.footer.classList.add('hidden');
}

function showError(message) {
  els.loadingState.classList.add('hidden');
  els.errorState.classList.remove('hidden');
  els.mainContent.classList.add('hidden');
  els.footer.classList.add('hidden');
  els.errorMessage.textContent = message;
}

function showMain() {
  els.loadingState.classList.add('hidden');
  els.errorState.classList.add('hidden');
  els.mainContent.classList.remove('hidden');
  els.footer.classList.remove('hidden');
}

function showDeleteOverlay() {
  els.deleteProgressText.textContent = '準備中...';
  els.progressBar.style.width = '0%';
  els.progressFraction.textContent = '0 / 0';
  els.deleteOverlay.classList.remove('hidden');
}

function hideDeleteOverlay() {
  els.deleteOverlay.classList.add('hidden');
}

function showStatus(message, type = 'success') {
  els.statusMessage.textContent = message;
  els.statusMessage.className = 'status-message ' + type;
  els.statusArea.classList.remove('hidden');

  clearTimeout(showStatus._timer);
  showStatus._timer = setTimeout(() => hideStatus(), 5000);
}

function hideStatus() {
  els.statusArea.classList.add('hidden');
}

// ========== Chrome API ヘルパー ==========
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isNotebookLMTab(tab) {
  return tab?.url?.includes('notebooklm.google.com');
}

async function pingContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return res?.alive === true;
  } catch {
    return false;
  }
}

function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
