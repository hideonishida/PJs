'use strict';

// ─────────────────────────────────────────
// State
// ─────────────────────────────────────────
const state = {
  mode: 'manual',
  videos: [],
  playlists: [],
  selectedVideos: new Set(),
  previewResult: [],
};

// ─────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const el = {
  loginSection:      $('login-section'),
  mainSection:       $('main-section'),
  loginBtn:          $('login-btn'),
  logoutBtn:         $('logout-btn'),
  tabManual:         $('tab-manual'),
  tabAuto:           $('tab-auto'),
  manualPanel:       $('manual-panel'),
  autoPanel:         $('auto-panel'),
  loadBtn:           $('load-btn'),
  openWLBtn:         $('open-wl-btn'),
  videoBadge:        $('video-count-badge'),
  selectAll:         $('select-all'),
  selectedCount:     $('selected-count'),
  videoList:         $('video-list'),
  targetPlaylist:    $('target-playlist'),
  removeFromWL:      $('remove-from-wl'),
  moveBtn:           $('move-btn'),
  ruleCountLabel:    $('rule-count-label'),
  openOptionsBtn:    $('open-options-btn'),
  previewBtn:        $('preview-btn'),
  previewList:       $('preview-list'),
  removeFromWLAuto:  $('remove-from-wl-auto'),
  executeBtn:        $('execute-btn'),
  status:            $('status'),
};

// ─────────────────────────────────────────
// Init
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[popup] DOMContentLoaded');
  setupEventListeners();
  console.log('[popup] setupEventListeners done, calling checkAuth...');
  await checkAuth();
  console.log('[popup] checkAuth done');
});

// ─────────────────────────────────────────
// Auth
// ─────────────────────────────────────────
async function checkAuth() {
  const res = await bg({ type: 'GET_AUTH_STATUS' });
  if (res.authenticated) {
    showMain();
    await loadPlaylists();
    await updateRuleCount();
  } else {
    showLogin();
  }
}

function showLogin() {
  el.loginSection.classList.remove('hidden');
  el.mainSection.classList.add('hidden');
}

function showMain() {
  el.loginSection.classList.add('hidden');
  el.mainSection.classList.remove('hidden');
}

async function handleLogin() {
  console.log('[popup] handleLogin called');
  setStatus('ログイン中...', 'info');
  let res;
  try {
    res = await bg({ type: 'LOGIN' });
  } catch (e) {
    console.error('[popup] bg() threw:', e);
    setStatus('ログインに失敗しました: ' + e.message, 'error');
    return;
  }
  console.log('[popup] LOGIN response:', res);
  if (res.success) {
    showMain();
    await loadPlaylists();
    await updateRuleCount();
    setStatus('ログインしました', 'success');
  } else {
    setStatus('ログインに失敗しました: ' + (res.error ?? ''), 'error');
  }
}

async function handleLogout() {
  await bg({ type: 'LOGOUT' });
  state.videos = [];
  state.playlists = [];
  state.selectedVideos.clear();
  resetVideoList();
  showLogin();
}

// ─────────────────────────────────────────
// Playlists
// ─────────────────────────────────────────
async function loadPlaylists() {
  const res = await bg({ type: 'GET_PLAYLISTS' });
  if (!res.success) { setStatus('プレイリストの取得に失敗しました', 'error'); return; }
  state.playlists = res.playlists;
  fillSelect(el.targetPlaylist, state.playlists, '移動先プレイリスト...');
}

function fillSelect(selectEl, playlists, placeholder) {
  selectEl.innerHTML = `<option value="">${placeholder}</option>`;
  playlists.forEach((pl) => {
    const opt = document.createElement('option');
    opt.value = pl.id;
    opt.textContent = pl.snippet.title;
    selectEl.appendChild(opt);
  });
}

// ─────────────────────────────────────────
// Rules count (for auto panel display)
// ─────────────────────────────────────────
async function updateRuleCount() {
  const result = await chrome.storage.sync.get(['rules']);
  const count = (result.rules ?? []).filter((r) => r.enabled).length;
  el.ruleCountLabel.textContent = `有効なルール: ${count} 件`;
}

// ─────────────────────────────────────────
// Mode switching
// ─────────────────────────────────────────
function switchMode(mode) {
  state.mode = mode;
  el.tabManual.classList.toggle('active', mode === 'manual');
  el.tabAuto.classList.toggle('active', mode === 'auto');
  el.manualPanel.classList.toggle('hidden', mode !== 'manual');
  el.autoPanel.classList.toggle('hidden', mode !== 'auto');
}

// ─────────────────────────────────────────
// Load Watch Later
// ─────────────────────────────────────────
async function loadWatchLater() {
  setStatus('Watch Later を読み込み中...', 'info');
  el.loadBtn.disabled = true;

  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/playlist?list=WL*' });

  if (tabs.length === 0) {
    setStatus('Watch Later ページが開かれていません', 'warning');
    el.openWLBtn.classList.remove('hidden');
    el.loadBtn.disabled = false;
    return false;
  }

  el.openWLBtn.classList.add('hidden');

  try {
    const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'SCRAPE_WATCH_LATER' });

    if (!res.success) {
      setStatus(res.error ?? '読み込みに失敗しました', 'error');
      el.loadBtn.disabled = false;
      return false;
    }

    state.videos = res.videos;
    state.selectedVideos.clear();
    el.videoBadge.textContent = `${state.videos.length} 件`;
    el.videoBadge.classList.remove('hidden');
    setStatus(`${state.videos.length} 件の動画を読み込みました`, 'success');
    renderVideoList();
  } catch (e) {
    setStatus('通信エラー。WL ページをリロードして再試行してください。', 'error');
    el.loadBtn.disabled = false;
    return false;
  }

  el.loadBtn.disabled = false;
  return true;
}

// ─────────────────────────────────────────
// Manual mode – Video list
// ─────────────────────────────────────────
function renderVideoList() {
  el.videoList.innerHTML = '';

  if (state.videos.length === 0) {
    el.videoList.innerHTML = '<div class="empty-state">動画がありません</div>';
    updateMoveBtn();
    return;
  }

  const frag = document.createDocumentFragment();
  state.videos.forEach((v) => frag.appendChild(createVideoItem(v)));
  el.videoList.appendChild(frag);
  updateMoveBtn();
  updateSelectAllState();
}

function resetVideoList() {
  el.videoList.innerHTML = '<div class="empty-state">Watch Later を読み込んでください</div>';
  el.videoBadge.classList.add('hidden');
  updateMoveBtn();
}

function createVideoItem(video) {
  const div = document.createElement('div');
  div.className = 'video-item';

  div.innerHTML = `
    <input type="checkbox" class="video-checkbox"
           data-video-id="${esc(video.videoId)}" />
    <img class="video-thumb"
         src="${esc(video.thumbnail)}"
         alt=""
         loading="lazy"
         onerror="this.src='https://i.ytimg.com/vi/${esc(video.videoId)}/mqdefault.jpg'" />
    <div class="video-info">
      <div class="video-title" title="${esc(video.title)}">${esc(video.title)}</div>
      <div class="video-meta">${esc(video.channelName)} · ${esc(video.durationStr)}</div>
    </div>
  `;

  const cb = div.querySelector('.video-checkbox');
  cb.addEventListener('change', () => {
    if (cb.checked) state.selectedVideos.add(video.videoId);
    else            state.selectedVideos.delete(video.videoId);
    updateMoveBtn();
    updateSelectAllState();
  });

  // クリックで行全体を選択
  div.addEventListener('click', (e) => {
    if (e.target !== cb) cb.click();
  });

  return div;
}

function handleSelectAll() {
  const checked = el.selectAll.checked;
  document.querySelectorAll('.video-checkbox').forEach((cb) => {
    cb.checked = checked;
    const vid = cb.dataset.videoId;
    if (checked) state.selectedVideos.add(vid);
    else         state.selectedVideos.delete(vid);
  });
  updateMoveBtn();
}

function updateSelectAllState() {
  const total    = state.videos.length;
  const selected = state.selectedVideos.size;
  el.selectAll.indeterminate = selected > 0 && selected < total;
  el.selectAll.checked       = total > 0 && selected === total;
  el.selectedCount.textContent = selected > 0 ? `${selected} 件選択中` : '';
}

function updateMoveBtn() {
  const ok = state.selectedVideos.size > 0 && el.targetPlaylist.value !== '';
  el.moveBtn.disabled = !ok;
  el.moveBtn.textContent = state.selectedVideos.size > 0
    ? `${state.selectedVideos.size} 件を移動`
    : '移動';
}

// ─────────────────────────────────────────
// Manual mode – Move
// ─────────────────────────────────────────
async function handleManualMove() {
  const targetId = el.targetPlaylist.value;
  if (!targetId || state.selectedVideos.size === 0) return;

  const targetName = el.targetPlaylist.options[el.targetPlaylist.selectedIndex]?.text ?? '';
  const removeFromWL = el.removeFromWL.checked;

  const videos = state.videos
    .filter((v) => state.selectedVideos.has(v.videoId))
    .map((v) => ({ ...v, targetPlaylistId: targetId, targetPlaylistName: targetName }));

  await executeMoveVideos(videos, removeFromWL, `「${targetName}」`);
}

// ─────────────────────────────────────────
// Auto mode – Preview
// ─────────────────────────────────────────
async function handleAutoPreview() {
  if (state.videos.length === 0) {
    const ok = await loadWatchLater();
    if (!ok || state.videos.length === 0) return;
  }

  setStatus('ルールを評価中...', 'info');
  const res = await bg({ type: 'PREVIEW_AUTO', videos: state.videos });

  if (!res.success) { setStatus('プレビューに失敗しました', 'error'); return; }

  state.previewResult = res.preview;
  renderPreviewList();

  const matchCount = state.previewResult.filter((p) => p.match).length;
  el.executeBtn.disabled = matchCount === 0;
  el.executeBtn.textContent = matchCount > 0
    ? `整理を実行 (${matchCount} 件)`
    : '整理を実行';
  setStatus(`${matchCount} 件がルールにマッチしました`, matchCount > 0 ? 'info' : 'warning');
}

function renderPreviewList() {
  el.previewList.innerHTML = '';

  if (state.previewResult.length === 0) {
    el.previewList.innerHTML = '<div class="empty-state">動画がありません</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  state.previewResult.forEach((item) => {
    const div = document.createElement('div');
    div.className = `preview-item ${item.match ? 'has-match' : 'no-match'}`;

    const badge = item.match
      ? `<span class="match-target">→ ${esc(item.match.targetPlaylistName)}</span>`
      : `<span class="no-match-label">マッチなし</span>`;

    div.innerHTML = `
      <div class="preview-info">
        <div class="video-title" title="${esc(item.title)}">${esc(item.title)}</div>
        <div class="video-meta">${esc(item.channelName)}</div>
      </div>
      ${badge}
    `;
    frag.appendChild(div);
  });
  el.previewList.appendChild(frag);
}

// ─────────────────────────────────────────
// Auto mode – Execute
// ─────────────────────────────────────────
async function handleAutoExecute() {
  const videos = state.previewResult
    .filter((p) => p.match)
    .map((p) => ({
      ...p,
      targetPlaylistId:   p.match.targetPlaylistId,
      targetPlaylistName: p.match.targetPlaylistName,
    }));

  if (videos.length === 0) return;

  const removeFromWL = el.removeFromWLAuto.checked;
  el.executeBtn.disabled = true;

  await executeMoveVideos(videos, removeFromWL, '自動整理');

  state.previewResult = [];
  renderPreviewList();
  el.executeBtn.textContent = '整理を実行';
}

// ─────────────────────────────────────────
// Common move logic
// ─────────────────────────────────────────
async function executeMoveVideos(videos, removeFromWL, label) {
  setStatus(`移動中... (0 / ${videos.length})`, 'info');
  disableActions(true);

  const res = await bg({ type: 'MOVE_VIDEOS', videos, removeFromWL });

  if (!res.success) {
    setStatus('移動に失敗しました: ' + (res.error ?? ''), 'error');
    disableActions(false);
    return;
  }

  // API で WL 削除できなかった動画を DOM 経由で削除
  const needDOM = res.results.filter((r) => r.needsContentScript);
  if (needDOM.length > 0 && removeFromWL) {
    await domDeleteVideos(needDOM.map((r) => r.videoId));
  }

  // 成功した動画を state から除去
  const movedIds = new Set(res.results.filter((r) => r.success).map((r) => r.videoId));
  state.videos = state.videos.filter((v) => !movedIds.has(v.videoId));
  state.selectedVideos.clear();
  renderVideoList();
  el.videoBadge.textContent = `${state.videos.length} 件`;

  const ok  = res.results.filter((r) => r.success).length;
  const ng  = res.results.filter((r) => !r.success).length;
  const msg = ng > 0
    ? `${ok} 件移動、${ng} 件失敗`
    : `${ok} 件を${label}に移動しました`;
  setStatus(msg, ng > 0 ? 'warning' : 'success');
  disableActions(false);
}

async function domDeleteVideos(videoIds) {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/playlist?list=WL*' });
  if (tabs.length === 0) return;

  for (const videoId of videoIds) {
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'REMOVE_FROM_WL_DOM', videoId });
    await sleep(400);
  }
}

function disableActions(disabled) {
  el.moveBtn.disabled    = disabled;
  el.executeBtn.disabled = disabled;
  el.loadBtn.disabled    = disabled;
}

// ─────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────
function setStatus(msg, type = '') {
  el.status.textContent = msg;
  el.status.className   = `status ${type}`;
}

// ─────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────
function setupEventListeners() {
  el.loginBtn.addEventListener('click', handleLogin);
  el.logoutBtn.addEventListener('click', handleLogout);
  el.tabManual.addEventListener('click', () => switchMode('manual'));
  el.tabAuto.addEventListener('click',   () => switchMode('auto'));
  el.loadBtn.addEventListener('click', loadWatchLater);
  el.openWLBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.youtube.com/playlist?list=WL' });
  });
  el.selectAll.addEventListener('change', handleSelectAll);
  el.targetPlaylist.addEventListener('change', updateMoveBtn);
  el.moveBtn.addEventListener('click', handleManualMove);
  el.openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  el.previewBtn.addEventListener('click', handleAutoPreview);
  el.executeBtn.addEventListener('click', handleAutoExecute);
}

// ─────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function bg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      resolve(res ?? { success: false, error: 'No response' });
    });
  });
}
