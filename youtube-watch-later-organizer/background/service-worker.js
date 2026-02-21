const API_BASE = 'https://www.googleapis.com/youtube/v3';

// ─────────────────────────────────────────
// OAuth
// ─────────────────────────────────────────

function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

// ─────────────────────────────────────────
// YouTube API helper
// ─────────────────────────────────────────

async function youtubeAPI(endpoint, method = 'GET', params = {}, body = null) {
  const token = await getAuthToken(true);
  let url = `${API_BASE}/${endpoint}`;

  if (method === 'GET' && Object.keys(params).length > 0) {
    url += '?' + new URLSearchParams(params).toString();
  }

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${response.status}`);
  }
  if (method === 'DELETE') return null;
  return response.json();
}

// ─────────────────────────────────────────
// Playlist operations
// ─────────────────────────────────────────

/** ISO 8601 duration ("PT1H2M3S") を秒数に変換 */
function parseISO8601Duration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

/** 秒数を "H:MM:SS" / "M:SS" 形式に変換 */
function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

async function getUserPlaylists() {
  let items = [];
  let pageToken = null;

  do {
    const params = {
      part: 'snippet',
      mine: true,
      maxResults: 50,
      ...(pageToken && { pageToken }),
    };
    const data = await youtubeAPI('playlists', 'GET', params);
    items = items.concat(data.items);
    pageToken = data.nextPageToken;
  } while (pageToken);

  // WL と HL (履歴) を除外
  return items.filter((item) => item.id !== 'WL' && item.id !== 'HL');
}

async function addToPlaylist(videoId, playlistId) {
  return youtubeAPI('playlistItems', 'POST', {}, {
    snippet: {
      playlistId,
      resourceId: { kind: 'youtube#video', videoId },
    },
  });
}

async function removeFromWatchLater(playlistItemId) {
  return youtubeAPI('playlistItems', 'DELETE', { id: playlistItemId });
}

/** Watch Later 内の動画の playlistItemId を取得（API が対応している場合のみ成功） */
async function getWLPlaylistItemId(videoId) {
  try {
    const data = await youtubeAPI('playlistItems', 'GET', {
      part: 'id',
      playlistId: 'WL',
      videoId,
    });
    return data.items?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * channels.list?part=contentDetails&mine=true から Watch Later の正式なプレイリストIDを取得する。
 * ドキュメント: "substitute the corresponding playlist ID from the channel information response"
 */
async function getWatchLaterPlaylistId() {
  const data = await youtubeAPI('channels', 'GET', {
    part: 'contentDetails',
    mine: true,
  });
  console.log('[sw] channels response:', JSON.stringify(data, null, 2));
  const id = data.items?.[0]?.contentDetails?.relatedPlaylists?.watchLater ?? 'WL';
  console.log('[sw] watchLater playlist ID:', id);
  return id;
}

/**
 * Watch Later の動画を YouTube API で取得する（最大 maxResults 件）。
 * 1. channels.list で Watch Later playlist ID を取得
 * 2. playlistItems.list で動画リストを取得
 * 3. videos.list で duration を一括取得
 */
async function getWatchLaterVideos(maxResults = 50) {
  const watchLaterId = await getWatchLaterPlaylistId();

  const data = await youtubeAPI('playlistItems', 'GET', {
    part: 'snippet',
    playlistId: watchLaterId,
    maxResults,
  });
  console.log('[sw] playlistItems response: totalResults=', data.pageInfo?.totalResults, 'items=', data.items?.length ?? 0);

  const items = data.items ?? [];
  if (items.length === 0) return [];

  // duration を一括取得
  const videoIds = items.map((item) => item.snippet.resourceId.videoId).join(',');
  const videoData = await youtubeAPI('videos', 'GET', {
    part: 'contentDetails',
    id: videoIds,
  });

  const durationMap = {};
  (videoData.items ?? []).forEach((v) => {
    durationMap[v.id] = parseISO8601Duration(v.contentDetails.duration);
  });

  return items.map((item) => {
    const videoId = item.snippet.resourceId.videoId;
    const durationSeconds = durationMap[videoId] ?? 0;
    return {
      videoId,
      playlistItemId: item.id,
      title: item.snippet.title,
      channelName: item.snippet.videoOwnerChannelTitle ?? item.snippet.channelTitle ?? '',
      durationSeconds,
      durationStr: formatDuration(durationSeconds),
      thumbnail:
        item.snippet.thumbnails?.medium?.url ??
        `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  });
}

// ─────────────────────────────────────────
// Rules
// ─────────────────────────────────────────

function getRules() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['rules'], (result) => resolve(result.rules || []));
  });
}

/**
 * 動画にマッチする最初のルールを返す。なければ null。
 * @param {{ title: string, channelName: string, durationSeconds: number }} video
 * @param {Array} rules
 */
function evaluateRules(video, rules) {
  for (const rule of rules) {
    if (!rule.enabled) continue;

    const { field, operator, value } = rule.condition;
    let fieldValue;

    switch (field) {
      case 'channelName':
        fieldValue = (video.channelName ?? '').toLowerCase();
        break;
      case 'title':
        fieldValue = (video.title ?? '').toLowerCase();
        break;
      case 'duration':
        fieldValue = video.durationSeconds ?? 0;
        break;
      default:
        continue;
    }

    let matches = false;
    if (field === 'duration') {
      const num = parseInt(value, 10) * 60; // 分 → 秒
      if (operator === 'gt') matches = fieldValue > num;
      else if (operator === 'lt') matches = fieldValue < num;
      else if (operator === 'eq') matches = fieldValue === num;
    } else {
      const lv = value.toLowerCase();
      if (operator === 'contains') matches = fieldValue.includes(lv);
      else if (operator === 'equals') matches = fieldValue === lv;
      else if (operator === 'startsWith') matches = fieldValue.startsWith(lv);
    }

    if (matches) {
      return {
        targetPlaylistId: rule.targetPlaylistId,
        targetPlaylistName: rule.targetPlaylistName,
        ruleId: rule.id,
      };
    }
  }
  return null;
}

// ─────────────────────────────────────────
// Move videos
// ─────────────────────────────────────────

/**
 * 動画を対象プレイリストに追加し、必要なら WL から削除する。
 * @param {{ videoId, playlistItemId?, targetPlaylistId }} video
 * @param {boolean} removeFromWL
 */
async function moveVideo(video, removeFromWL) {
  await addToPlaylist(video.videoId, video.targetPlaylistId);

  if (!removeFromWL) {
    return { videoId: video.videoId, success: true, wlRemoved: false };
  }

  // playlistItemId が既知であれば API で削除
  let itemId = video.playlistItemId ?? null;
  if (!itemId) {
    itemId = await getWLPlaylistItemId(video.videoId);
  }

  if (itemId) {
    await removeFromWatchLater(itemId);
    return { videoId: video.videoId, success: true, wlRemoved: true };
  }

  // API での WL 削除が不可能 → Content Script 経由で削除する必要あり
  return {
    videoId: video.videoId,
    success: true,
    wlRemoved: false,
    needsContentScript: true,
  };
}

// ─────────────────────────────────────────
// Message handler
// ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[sw] message received:', message.type);
  (async () => {
    try {
      switch (message.type) {
        case 'GET_AUTH_STATUS': {
          try {
            await getAuthToken(false);
            sendResponse({ success: true, authenticated: true });
          } catch (e) {
            console.log('[sw] GET_AUTH_STATUS not authenticated:', e.message);
            sendResponse({ success: true, authenticated: false });
          }
          break;
        }

        case 'LOGIN': {
          console.log('[sw] LOGIN: calling getAuthToken(true)');
          try {
            const token = await getAuthToken(true);
            console.log('[sw] LOGIN: token obtained', token ? 'ok' : 'null');
            sendResponse({ success: true });
          } catch (e) {
            console.error('[sw] LOGIN: getAuthToken failed:', e.message);
            sendResponse({ success: false, error: e.message });
          }
          break;
        }

        case 'LOGOUT': {
          try {
            const token = await getAuthToken(false);
            await removeCachedToken(token);
          } catch {
            // 既にトークンなし
          }
          sendResponse({ success: true });
          break;
        }

        case 'GET_PLAYLISTS': {
          const playlists = await getUserPlaylists();
          sendResponse({ success: true, playlists });
          break;
        }

        case 'GET_WATCH_LATER': {
          const videos = await getWatchLaterVideos(message.maxResults ?? 50);
          sendResponse({ success: true, videos });
          break;
        }

        case 'PREVIEW_AUTO': {
          const rules = await getRules();
          const preview = message.videos.map((video) => ({
            ...video,
            match: evaluateRules(video, rules),
          }));
          sendResponse({ success: true, preview });
          break;
        }

        case 'MOVE_VIDEOS': {
          const { videos, removeFromWL } = message;
          const results = [];

          for (const video of videos) {
            try {
              const result = await moveVideo(video, removeFromWL);
              results.push(result);
            } catch (error) {
              results.push({
                videoId: video.videoId,
                success: false,
                error: error.message,
              });
            }
          }

          sendResponse({ success: true, results });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true; // 非同期レスポンスのためチャネルを維持
});
