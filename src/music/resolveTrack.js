const play = require("play-dl");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { MAX_PLAYLIST_ITEMS, YOUTUBE_API_KEY, YTDLP_COOKIES_PATH } = require("../config");

const ytDlpProbeCache = new Map();

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

function resolveYtDlpCookiesPath() {
  const configuredPath = String(YTDLP_COOKIES_PATH || "").trim();
  if (!configuredPath) {
    return null;
  }

  const absolutePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);

  return fs.existsSync(absolutePath) ? absolutePath : null;
}

async function probeYtDlp(url) {
  const cached = ytDlpProbeCache.get(url);
  if (cached) {
    return cached;
  }

  const probe = await new Promise((resolve) => {
    const args = ["--simulate", "--skip-download", "--no-playlist", "--no-warnings", "--quiet", "--geo-bypass"];
    const cookiesPath = resolveYtDlpCookiesPath();
    if (cookiesPath) {
      args.push("--cookies", cookiesPath);
    }

    args.push(url);

    let stderr = "";
    let done = false;

    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      resolve(result);
    };

    const process = spawn("yt-dlp", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      finish({ ok: false, reason: "timeout" });
    }, 12_000);

    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    process.on("error", (error) => {
      clearTimeout(timeout);

      if (error.code === "ENOENT") {
        // If yt-dlp is not available in this environment, don't block resolver.
        finish({ ok: true, reason: "yt-dlp-missing" });
        return;
      }

      finish({ ok: false, reason: error.message });
    });

    process.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        finish({ ok: true, reason: "ok" });
        return;
      }

      finish({
        ok: false,
        reason: stderr.trim() || `yt-dlp exit code ${code}`,
      });
    });
  });

  ytDlpProbeCache.set(url, probe);
  return probe;
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
    maxResults: "10",
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
          const probe = await probeYtDlp(url);
          if (!probe.ok) {
            console.warn(`[Resolve] API-кандидат не воспроизводится: ${url} | ${probe.reason}`);
            continue;
          }

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
      limit: 10,
    });

    if (!results || results.length === 0) {
      throw new Error("Ничего не найдено по вашему запросу.");
    }

    for (const video of results) {
      if (!video?.url) continue;

      try {
        console.log(`[Resolve] Проверка кандидата: ${video.title} | ${video.url}`);
        const probe = await probeYtDlp(video.url);
        if (!probe.ok) {
          console.warn(`[Resolve] Кандидат не воспроизводится: ${video.url} | ${probe.reason}`);
          continue;
        }

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
