/**
 * content/youtube.js
 * YouTube の Watch Later ページで動作するコンテンツスクリプト。
 * - Watch Later 動画一覧のスクレイピング
 * - DOM 操作による WL からの削除（API フォールバック用）
 */

'use strict';

// ─────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────

/** "1:23:45" / "12:34" / "1:05" などを秒数に変換 */
function parseDurationToSeconds(str) {
  if (!str) return 0;
  const parts = str.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseInt(parts[0], 10) || 0;
}

/** URL から動画 ID を抽出 */
function extractVideoId(url) {
  const m = (url ?? '').match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────
// スクレイピング
// ─────────────────────────────────────────

function scrapeWatchLaterVideos() {
  if (!location.href.includes('list=WL')) {
    return { success: false, error: 'このページは Watch Later ではありません' };
  }

  const renderers = document.querySelectorAll('ytd-playlist-video-renderer');
  if (renderers.length === 0) {
    return { success: false, error: 'まだ動画が読み込まれていません。ページをスクロールしてから再試行してください。' };
  }

  const videos = [];

  renderers.forEach((renderer) => {
    try {
      // タイトル & URL
      const titleEl = renderer.querySelector('#video-title');
      const title = titleEl?.textContent?.trim() ?? '';
      const videoUrl = titleEl?.href ?? '';
      const videoId = extractVideoId(videoUrl);
      if (!videoId) return;

      // チャンネル名（複数セレクターを試みる）
      const channelEl =
        renderer.querySelector('.ytd-channel-name a') ??
        renderer.querySelector('#channel-name a') ??
        renderer.querySelector('yt-formatted-string.ytd-channel-name');
      const channelName = channelEl?.textContent?.trim() ?? '';

      // 時間
      const durationEl =
        renderer.querySelector('ytd-thumbnail-overlay-time-status-renderer span#text') ??
        renderer.querySelector('ytd-thumbnail-overlay-time-status-renderer span') ??
        renderer.querySelector('.ytd-thumbnail-overlay-time-status-renderer');
      const durationStr = durationEl?.textContent?.trim() ?? '0:00';
      const durationSeconds = parseDurationToSeconds(durationStr);

      // サムネイル
      const thumbEl = renderer.querySelector('img.yt-core-image');
      const thumbnail =
        thumbEl?.src?.startsWith('http')
          ? thumbEl.src
          : `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

      videos.push({
        videoId,
        title,
        channelName,
        durationSeconds,
        durationStr,
        thumbnail,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      });
    } catch (e) {
      console.warn('[WL Organizer] Failed to parse renderer:', e);
    }
  });

  return { success: true, videos };
}

// ─────────────────────────────────────────
// DOM 経由の WL 削除（API フォールバック）
// ─────────────────────────────────────────

/**
 * 指定 videoId の動画を Watch Later の UI 操作で削除する。
 * API が WL の playlistItemId を返さない場合のフォールバック。
 */
async function removeFromWLviaDOM(videoId) {
  if (!location.href.includes('list=WL')) return false;

  // 対象の renderer を探す
  const renderers = document.querySelectorAll('ytd-playlist-video-renderer');
  let targetRenderer = null;

  for (const renderer of renderers) {
    const titleEl = renderer.querySelector('#video-title');
    if (titleEl?.href?.includes(videoId)) {
      targetRenderer = renderer;
      break;
    }
  }

  if (!targetRenderer) return false;

  // 三点メニューボタンをクリック
  const menuBtn =
    targetRenderer.querySelector('button[aria-label]') ??
    targetRenderer.querySelector('yt-icon-button#button') ??
    targetRenderer.querySelector('ytd-menu-renderer button');

  if (!menuBtn) return false;
  menuBtn.click();
  await sleep(400);

  // ポップアップメニューから "後で見る から削除" を探す
  const menuItems = document.querySelectorAll(
    'ytd-menu-service-item-renderer, tp-yt-paper-item'
  );
  for (const item of menuItems) {
    const text = item.textContent?.trim() ?? '';
    if (
      text.includes('後で見る') ||
      text.toLowerCase().includes('watch later') ||
      text.includes('削除')
    ) {
      item.click();
      await sleep(200);
      return true;
    }
  }

  // メニューを閉じる（見つからなかった場合）
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return false;
}

// ─────────────────────────────────────────
// メッセージリスナー
// ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SCRAPE_WATCH_LATER') {
    sendResponse(scrapeWatchLaterVideos());
    return;
  }

  if (message.type === 'REMOVE_FROM_WL_DOM') {
    removeFromWLviaDOM(message.videoId).then((result) => {
      sendResponse({ success: result });
    });
    return true; // 非同期
  }
});
