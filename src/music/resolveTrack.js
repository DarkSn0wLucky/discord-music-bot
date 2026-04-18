const play = require("play-dl");
const { MAX_PLAYLIST_ITEMS, YOUTUBE_API_KEY } = require("../config");

const SEARCH_RESULTS_LIMIT = 8;
const SEARCH_TRACK_PACK_SIZE = 4;

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

function packSearchTracks(rawTracks, query) {
  const playable = rawTracks.filter((track) => track?.url).slice(0, SEARCH_TRACK_PACK_SIZE);
  if (playable.length === 0) {
    return null;
  }

  const [first, ...fallbackTracks] = playable;
  first.searchQuery = query;
  first.fallbackTracks = fallbackTracks;
  return first;
}

async function searchYoutubeByApi(query) {
  if (!YOUTUBE_API_KEY) {
    return [];
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(SEARCH_RESULTS_LIMIT),
    key: YOUTUBE_API_KEY,
  });

  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
  if (!response.ok) {
    return [];
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

  return toYouTubeTrack(info.video_details, requestedBy);
}

async function resolveFromSearch(query, requestedBy) {
  console.log(`[Resolve] Поиск по тексту: "${query}"`);

  try {
    const results = await play.search(query, {
      source: { youtube: "video" },
      limit: SEARCH_RESULTS_LIMIT,
    });

    const tracksFromSearch = (results || [])
      .map((video) => toYouTubeTrack(video, requestedBy))
      .filter((track) => track?.url);

    const packedTrack = packSearchTracks(tracksFromSearch, query);
    if (packedTrack) {
      console.log(
        `[Resolve] Выбран кандидат из play.search: ${packedTrack.url}; запасных: ${packedTrack.fallbackTracks.length}`
      );
      return {
        tracks: [packedTrack],
        kind: "youtube_search",
      };
    }
  } catch (error) {
    console.warn(`[Resolve] Ошибка play.search "${query}": ${error.message}`);
  }

  const apiUrls = await searchYoutubeByApi(query).catch(() => []);
  if (Array.isArray(apiUrls) && apiUrls.length > 0) {
    const recoveredTracks = [];

    for (const url of apiUrls) {
      try {
        const track = await resolveCandidateVideo(url, requestedBy);
        recoveredTracks.push(track);

        if (recoveredTracks.length >= SEARCH_TRACK_PACK_SIZE) {
          break;
        }
      } catch (error) {
        console.warn(`[Resolve] API-кандидат пропущен: ${url} | ${error.message}`);
      }
    }

    const packedTrack = packSearchTracks(recoveredTracks, query);
    if (packedTrack) {
      console.log(`[Resolve] Выбран API-кандидат: ${packedTrack.url}; запасных: ${packedTrack.fallbackTracks.length}`);
      return {
        tracks: [packedTrack],
        kind: "youtube_search_api",
      };
    }
  }

  throw new Error("Не удалось найти трек по запросу.");
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
