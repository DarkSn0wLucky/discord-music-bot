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
    author: video.channel?.name || video.channel?.title || "YouTube",
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
    maxResults: "5",
    key: YOUTUBE_API_KEY,
  });

  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items : [];

  return items
    .map((item) => item?.id?.videoId)
    .filter(Boolean)
    .map((id) => `https://www.youtube.com/watch?v=${id}`);
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

  try {
    const playlist = await play.playlist_info(url, { incomplete: true });
    const videos = await playlist.all_videos();
    const tracks = videos
      .filter((video) => video?.url)
      .slice(0, MAX_PLAYLIST_ITEMS)
      .map((video) => toYouTubeTrack(video, requestedBy));

    return {
      tracks,
      kind: "youtube_playlist",
      title: playlist.title || "YouTube playlist",
    };
  } catch (error) {
    throw new Error(`Не удалось открыть YouTube плейлист: ${error.message}`);
  }
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

async function resolveCandidateVideo(url, requestedBy) {
  const info = await play.video_basic_info(url);
  if (!info?.video_details?.url) {
    throw new Error("Пустой ответ от YouTube");
  }

  return {
    tracks: [toYouTubeTrack(info.video_details, requestedBy)],
    kind: "youtube_search_builtin",
  };
}

async function resolveFromSearch(query, requestedBy) {
  console.log(`[Resolve] Поиск по тексту: "${query}"`);

  if (YOUTUBE_API_KEY) {
    const apiUrls = await searchYoutubeByApi(query).catch(() => null);

    if (Array.isArray(apiUrls) && apiUrls.length > 0) {
      for (const url of apiUrls) {
        try {
          const resolved = await resolveCandidateVideo(url, requestedBy);
          console.log(`[Resolve] YouTube API выбрал: ${url}`);
          return {
            ...resolved,
            kind: "youtube_search_api",
          };
        } catch (error) {
          console.warn(`[Resolve] API-кандидат пропущен: ${url} | ${error.message}`);
        }
      }

      console.warn("[Resolve] YouTube API не дал доступных видео, пробуем встроенный поиск");
    }
  }

  try {
    const results = await play.search(query, {
      source: { youtube: "video" },
      limit: 5,
    });

    if (!results || results.length === 0) {
      throw new Error("Ничего не найдено по вашему запросу.");
    }

    for (const video of results) {
      if (!video?.url) continue;

      try {
        console.log(`[Resolve] Проверка кандидата: ${video.title} | ${video.url}`);
        const resolved = await resolveCandidateVideo(video.url, requestedBy);
        return resolved;
      } catch (error) {
        console.warn(`[Resolve] Кандидат пропущен: ${video.url} | ${error.message}`);
      }
    }

    throw new Error("Не удалось подобрать доступный трек по запросу.");
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