const play = require("play-dl");
const { MAX_PLAYLIST_ITEMS, YOUTUBE_API_KEY } = require("../config");

function normalizeInput(raw) {
  return raw.trim().replace(/^<(.+)>$/g, "$1");
}

function isUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function youtubeThumb(video) {
  if (video.thumbnail?.url) {
    return video.thumbnail.url;
  }

  if (Array.isArray(video.thumbnails) && video.thumbnails.length > 0) {
    return video.thumbnails[video.thumbnails.length - 1].url || null;
  }

  return null;
}

function toYouTubeTrack(video, requestedBy) {
  const durationSec = Number(video.durationInSec) || 0;

  return {
    title: video.title || "Без названия",
    url: video.url,
    source: "YouTube",
    author: video.channel?.name || "YouTube",
    durationSec,
    durationMs: durationSec > 0 ? durationSec * 1000 : 0,
    thumbnail: youtubeThumb(video),
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
  };
}

function toSoundCloudTrack(track, requestedBy) {
  const durationSec = Number(track.durationInSec) || 0;
  const durationMs = Number(track.durationInMs) || (durationSec > 0 ? durationSec * 1000 : 0);

  return {
    title: track.name || "Без названия",
    url: track.permalink || track.url,
    source: "SoundCloud",
    author: track.user?.name || "SoundCloud",
    durationSec,
    durationMs,
    thumbnail: track.thumbnail || null,
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
  };
}

async function searchYoutubeByApi(query) {
  if (!YOUTUBE_API_KEY) {
    return null;
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: "1",
    key: YOUTUBE_API_KEY,
  });

  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const item = data.items?.[0];
  const id = item?.id?.videoId;
  if (!id) {
    return null;
  }

  return `https://www.youtube.com/watch?v=${id}`;
}

async function resolveYoutubeUrl(url, requestedBy) {
  const ytType = play.yt_validate(url);
  if (!ytType || ytType === "search") {
    return null;
  }

  if (ytType === "video") {
    const info = await play.video_basic_info(url);
    return {
      tracks: [toYouTubeTrack(info.video_details, requestedBy)],
      kind: "youtube_video",
    };
  }

  const playlist = await play.playlist_info(url, { incomplete: true });
  const videos = await playlist.all_videos();
  const tracks = videos
    .filter((video) => video.url)
    .slice(0, MAX_PLAYLIST_ITEMS)
    .map((video) => toYouTubeTrack(video, requestedBy));

  return {
    tracks,
    kind: "youtube_playlist",
    title: playlist.title || "YouTube playlist",
  };
}

async function resolveSoundCloudUrl(url, requestedBy) {
  const type = await play.so_validate(url);
  if (!type || type === "search") {
    return null;
  }

  const sound = await play.soundcloud(url);

  if (type === "track" || sound.type === "track") {
    return {
      tracks: [toSoundCloudTrack(sound, requestedBy)],
      kind: "soundcloud_track",
    };
  }

  const tracks = typeof sound.all_tracks === "function" ? await sound.all_tracks() : sound.tracks || [];
  const mapped = tracks.slice(0, MAX_PLAYLIST_ITEMS).map((track) => toSoundCloudTrack(track, requestedBy));

  return {
    tracks: mapped,
    kind: "soundcloud_playlist",
    title: sound.name || "SoundCloud playlist",
  };
}

async function resolveFromSearch(query, requestedBy) {
  console.log(`[Resolve] Поиск по тексту: "${query}"`);

  // Вариант 1: YouTube Data API (если ключ есть — используем его)
  if (YOUTUBE_API_KEY) {
    const fromApi = await searchYoutubeByApi(query).catch(() => null);
    if (fromApi) {
      try {
        const info = await play.video_basic_info(fromApi);
        return {
          tracks: [toYouTubeTrack(info.video_details, requestedBy)],
          kind: "youtube_search_api",
        };
      } catch (e) {
        console.warn("[Resolve] YouTube API не сработал, используем встроенный поиск");
      }
    }
  }

  // Вариант 2: Встроенный поиск play-dl (основной)
  try {
    const results = await play.search(query, {
      source: { youtube: "video" },
      limit: 3,                    // берём 3 результата, на случай если первый неудачный
    });

    if (!results || results.length === 0) {
      throw new Error("Ничего не найдено по вашему запросу.");
    }

    // Берём первый (самый релевантный) результат
    const video = results[0];

    return {
      tracks: [toYouTubeTrack(video, requestedBy)],
      kind: "youtube_search_builtin",
    };
  } catch (error) {
    console.error(`[Resolve] Ошибка поиска "${query}":`, error.message);
    throw new Error(`Не удалось найти трек: ${error.message}`);
  }
}

async function resolveTracks(query, requestedBy) {
  const input = normalizeInput(query);

  if (!input) {
    return { tracks: [], kind: "empty" };
  }

  if (isUrl(input)) {
    const youtubeResolved = await resolveYoutubeUrl(input, requestedBy);
    if (youtubeResolved) {
      return youtubeResolved;
    }

    const soundCloudResolved = await resolveSoundCloudUrl(input, requestedBy);
    if (soundCloudResolved) {
      return soundCloudResolved;
    }

    throw new Error("Эта ссылка пока не поддерживается. Используй YouTube/SoundCloud.");
  }

  return resolveFromSearch(input, requestedBy);
}

module.exports = {
  resolveTracks,
};

