'use strict';

// ─────────────────────────────────────────
// State
// ─────────────────────────────────────────
const state = {
  rules: [],
  playlists: [],
};

// ─────────────────────────────────────────
// Init
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  setupEventListeners();
  renderRules();
});

async function loadData() {
  // プレイリスト取得
  const res = await bg({ type: 'GET_PLAYLISTS' });
  if (res.success) {
    state.playlists = res.playlists;
    fillPlaylistSelect();
  } else {
    showFormMessage('プレイリストの取得に失敗しました。ログイン状態を確認してください。', 'error');
  }

  // ルール取得
  const stored = await chrome.storage.sync.get(['rules']);
  state.rules = stored.rules ?? [];
}

// ─────────────────────────────────────────
// Playlist select
// ─────────────────────────────────────────
function fillPlaylistSelect() {
  const sel = document.getElementById('rule-target-playlist');
  sel.innerHTML = '<option value="">移動先を選択...</option>';
  state.playlists.forEach((pl) => {
    const opt = document.createElement('option');
    opt.value = pl.id;
    opt.dataset.name = pl.snippet.title;
    opt.textContent = pl.snippet.title;
    sel.appendChild(opt);
  });
}

// ─────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────
function setupEventListeners() {
  document.getElementById('rule-field').addEventListener('change', handleFieldChange);
  document.getElementById('add-rule-btn').addEventListener('click', handleAddRule);
}

/** フィールドが変わったら演算子の選択肢を切り替える */
function handleFieldChange() {
  const field = document.getElementById('rule-field').value;
  const opSel = document.getElementById('rule-operator');
  const label  = document.getElementById('rule-value-label');

  opSel.innerHTML = '';

  if (field === 'duration') {
    [['gt', 'より大きい (分)'], ['lt', 'より小さい (分)'], ['eq', '等しい (分)']].forEach(([v, t]) => {
      opSel.appendChild(new Option(t, v));
    });
    label.textContent = '値 (分)';
    document.getElementById('rule-value').placeholder = '例: 10, 30, 60';
  } else {
    [['contains', '含む'], ['equals', '完全一致'], ['startsWith', 'で始まる']].forEach(([v, t]) => {
      opSel.appendChild(new Option(t, v));
    });
    label.textContent = '値';
    document.getElementById('rule-value').placeholder = field === 'channelName'
      ? '例: TED, Kurzgesagt'
      : '例: 料理, vlog';
  }
}

// ─────────────────────────────────────────
// Add rule
// ─────────────────────────────────────────
function handleAddRule() {
  const field    = document.getElementById('rule-field').value;
  const operator = document.getElementById('rule-operator').value;
  const value    = document.getElementById('rule-value').value.trim();
  const targetSel = document.getElementById('rule-target-playlist');
  const targetId  = targetSel.value;
  const targetName = targetSel.options[targetSel.selectedIndex]?.text ?? '';

  if (!value) {
    showFormMessage('値を入力してください', 'error');
    return;
  }
  if (!targetId) {
    showFormMessage('移動先プレイリストを選択してください', 'error');
    return;
  }

  const newRule = {
    id:        `rule_${Date.now()}`,
    condition: { field, operator, value },
    targetPlaylistId:   targetId,
    targetPlaylistName: targetName,
    enabled: true,
  };

  state.rules.push(newRule);
  saveRules();
  renderRules();

  // フォームをリセット
  document.getElementById('rule-value').value = '';
  document.getElementById('rule-target-playlist').value = '';
  showFormMessage('ルールを追加しました', 'success');
}

// ─────────────────────────────────────────
// Render rules
// ─────────────────────────────────────────
const FIELD_LABELS    = { channelName: 'チャンネル名', title: 'タイトル', duration: '動画時間' };
const OPERATOR_LABELS = { contains: '含む', equals: '一致', startsWith: 'で始まる', gt: '>', lt: '<', eq: '=' };

function renderRules() {
  const container = document.getElementById('rules-list');
  document.getElementById('rule-total').textContent = `${state.rules.length} 件`;

  if (state.rules.length === 0) {
    container.innerHTML = '<div class="empty-state">ルールがありません。上のフォームから追加してください。</div>';
    return;
  }

  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.rules.forEach((rule, index) => frag.appendChild(createRuleItem(rule, index)));
  container.appendChild(frag);
}

function createRuleItem(rule, index) {
  const div = document.createElement('div');
  div.className = `rule-item${rule.enabled ? '' : ' disabled'}`;
  div.dataset.ruleId = rule.id;

  const { field, operator, value } = rule.condition;
  const suffix = field === 'duration' ? ' 分' : '';
  const condText = `${FIELD_LABELS[field] ?? field}  ${OPERATOR_LABELS[operator] ?? operator}  "${esc(value)}"${suffix}`;

  div.innerHTML = `
    <span class="rule-index">${index + 1}</span>
    <div class="rule-content">
      <div class="rule-condition">${condText}</div>
      <div class="rule-target">→ ${esc(rule.targetPlaylistName)}</div>
    </div>
    <div class="rule-actions">
      <label class="toggle" title="${rule.enabled ? '有効' : '無効'}">
        <input type="checkbox" class="rule-toggle" ${rule.enabled ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
      <button class="btn-icon delete-btn" title="削除">✕</button>
    </div>
  `;

  // 有効/無効トグル
  div.querySelector('.rule-toggle').addEventListener('change', (e) => {
    rule.enabled = e.target.checked;
    div.classList.toggle('disabled', !rule.enabled);
    saveRules();
  });

  // 削除
  div.querySelector('.delete-btn').addEventListener('click', () => {
    if (!confirm(`このルールを削除しますか？\n\n${condText}`)) return;
    state.rules = state.rules.filter((r) => r.id !== rule.id);
    saveRules();
    renderRules();
  });

  return div;
}

// ─────────────────────────────────────────
// Storage
// ─────────────────────────────────────────
function saveRules() {
  chrome.storage.sync.set({ rules: state.rules });
}

// ─────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────
function showFormMessage(msg, type) {
  const el = document.getElementById('form-message');
  el.textContent = msg;
  el.className = `form-message ${type}`;
  setTimeout(() => { el.textContent = ''; el.className = 'form-message'; }, 3000);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      resolve(res ?? { success: false, error: 'No response' });
    });
  });
}
