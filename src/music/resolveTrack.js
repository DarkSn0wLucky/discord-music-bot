const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const play = require("play-dl");
const {
  MAX_PLAYLIST_ITEMS,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  YOUTUBE_API_KEY,
} = require("../config");

const SEARCH_RESULTS_LIMIT = 8;
const SEARCH_TRACK_PACK_SIZE = 4;
const SEARCH_CANDIDATE_POOL_MULTIPLIER = 4;
const API_RESOLVE_LIMIT = 12;
const EXTERNAL_FETCH_TIMEOUT_MS = 8_000;
const HAS_SPOTIFY_AUTH = Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && SPOTIFY_REFRESH_TOKEN);

const QUERY_STOPWORDS = new Set([
  "official",
  "video",
  "music",
  "audio",
  "lyrics",
  "lyric",
  "clip",
  "clips",
  "mv",
  "hd",
  "hq",
  "feat",
  "ft",
  "version",
  "ver",
  "песня",
  "песню",
  "песни",
  "трек",
  "музыка",
]);

const EXTRA_VERSION_KEYWORDS = new Set([
  "remix",
  "live",
  "karaoke",
  "cover",
  "speed",
  "speedup",
  "nightcore",
  "reverb",
  "edit",
  "instrumental",
  "demo",
  "concert",
  "slowed",
  "slowedreverb",
  "акустика",
  "акустический",
  "концерт",
  "караоке",
  "кавер",
  "ремикс",
  "версия",
]);

function normalizeInput(raw) {
  return raw.trim().replace(/^<(.+)>$/g, "$1");
}

function extractUrlFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return "";
  }

  const match = text.match(/https?:\/\/[^\s<>"'`]+/iu);
  if (!match?.[0]) {
    return "";
  }

  return match[0].replace(/[)\],.;!?]+$/u, "");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalTitle(value) {
  return normalizeText(value)
    .replace(/\b(official|video|audio|lyrics|lyric|mv|hd|hq)\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractMetaContent(html, attr, key) {
  const escapedAttr = escapeRegExp(attr);
  const escapedKey = escapeRegExp(key);
  const patterns = [
    new RegExp(
      `<meta[^>]*\\b${escapedAttr}\\s*=\\s*["']${escapedKey}["'][^>]*\\bcontent\\s*=\\s*["']([^"']+)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]*\\bcontent\\s*=\\s*["']([^"']+)["'][^>]*\\b${escapedAttr}\\s*=\\s*["']${escapedKey}["'][^>]*>`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }

  return "";
}

function extractTitleTag(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!match?.[1]) {
    return "";
  }

  return decodeHtmlEntities(match[1]);
}

function isYandexMusicHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "music.yandex.ru" || host.startsWith("music.yandex.");
}

function parseYandexUrlInfo(url) {
  try {
    const parsed = new URL(url);
    if (!isYandexMusicHost(parsed.hostname)) {
      return null;
    }

    const pathName = parsed.pathname || "";
    const trackInAlbum = pathName.match(/\/album\/(\d+)\/track\/(\d+)/i);
    if (trackInAlbum) {
      return {
        origin: parsed.origin,
        albumId: trackInAlbum[1],
        trackId: trackInAlbum[2],
      };
    }

    const directTrack = pathName.match(/\/track\/(\d+)/i);
    if (directTrack) {
      return {
        origin: parsed.origin,
        albumId: parsed.searchParams.get("album") || parsed.searchParams.get("albumId") || "",
        trackId: directTrack[1],
      };
    }

    const album = pathName.match(/\/album\/(\d+)/i);
    if (album) {
      return {
        origin: parsed.origin,
        albumId: album[1],
        trackId: "",
      };
    }

    return {
      origin: parsed.origin,
      albumId: "",
      trackId: "",
    };
  } catch {
    return null;
  }
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
    views: Number(video.views) || 0,
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
    views: Number(track.views) || 0,
    durationSec,
    durationMs,
    thumbnail: track.thumbnail || null,
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
  };
}

function joinArtists(artists) {
  if (!Array.isArray(artists)) {
    return "";
  }

  return artists
    .map((artist) => String(artist?.name || artist || "").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
}

function buildQueryFromArtistTitle(artist, title) {
  return String(`${artist || ""} ${title || ""}`)
    .replace(/\s+/g, " ")
    .trim();
}

function cleanExternalTitle(title, siteName = "") {
  let value = decodeHtmlEntities(title || "");
  if (!value) {
    return "";
  }

  const normalizedSiteName = normalizeText(siteName);
  const normalizedValue = normalizeText(value);
  if (normalizedSiteName && normalizedValue.endsWith(normalizedSiteName)) {
    value = value.slice(0, Math.max(0, value.length - siteName.length)).trim();
  }

  value = value
    .replace(/\s*[|•]\s*[^|•]+$/u, "")
    .replace(/\s+[-–—]\s*(yandex music|яндекс музыка|spotify|vk music|вконтакте|deezer|apple music|tidal)\s*$/iu, "")
    .replace(/^(listen to|watch|слушать)\s+/iu, "")
    .replace(/\s+(on|в)\s+(spotify|youtube|yandex music|яндекс музыке|vk music|deezer|apple music|tidal)\s*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  return value;
}

function isGenericLandingTitle(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return true;
  }

  const blockedPhrases = [
    "яндекс музыка",
    "яндекс музыка собираем музыку для вас",
    "yandex music",
    "yandex music discover",
  ];

  return blockedPhrases.some((phrase) => normalized === phrase || normalized.startsWith(`${phrase} `));
}

function hasQueryTokenCoverage(value, query) {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return false;
  }

  const queryTokens = normalizeText(query)
    .split(" ")
    .filter((token) => token.length > 1 && !QUERY_STOPWORDS.has(token));

  if (queryTokens.length === 0) {
    return false;
  }

  return queryTokens.every((token) => normalizedValue.includes(token));
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

async function searchYoutubeByApi(query, options = {}) {
  if (!YOUTUBE_API_KEY) {
    return [];
  }

  const maxResults = Math.max(1, Math.min(50, Number(options.maxResults) || SEARCH_RESULTS_LIMIT));
  const order = options.order || "relevance";

  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(maxResults),
    order,
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

function dedupeTracksByUrl(tracks, limit = Number.POSITIVE_INFINITY) {
  const seenUrls = new Set();
  const unique = [];

  for (const track of tracks) {
    if (!track?.url || seenUrls.has(track.url)) {
      continue;
    }

    seenUrls.add(track.url);
    unique.push(track);

    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

function dedupeTracksByIdentity(tracks, limit = Number.POSITIVE_INFINITY) {
  const seenKeys = new Set();
  const unique = [];

  for (const track of tracks) {
    if (!track?.url) {
      continue;
    }

    const key = `${canonicalTitle(track.title)}|${normalizeText(track.author)}`;
    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    unique.push(track);

    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

function buildQueryMeta(query) {
  const normalizedQuery = normalizeText(query);
  const rawTokens = normalizedQuery.split(" ").filter(Boolean);
  const meaningfulTokens = rawTokens.filter((token) => token.length > 1 && !QUERY_STOPWORDS.has(token));
  const tokens = [...new Set(meaningfulTokens.length > 0 ? meaningfulTokens : rawTokens)];

  return {
    normalizedQuery,
    tokens,
    tokenSet: new Set(tokens),
  };
}

function tokenMatches(queryToken, titleToken) {
  if (!queryToken || !titleToken) {
    return false;
  }

  if (queryToken === titleToken) {
    return true;
  }

  const minPrefixLength = 4;
  return (
    (queryToken.length >= minPrefixLength && titleToken.startsWith(queryToken)) ||
    (titleToken.length >= minPrefixLength && queryToken.startsWith(titleToken))
  );
}

function strictCoverageThreshold(tokenCount) {
  if (tokenCount <= 1) {
    return 1;
  }

  if (tokenCount === 2) {
    return 0.5;
  }

  if (tokenCount === 3) {
    return 2 / 3;
  }

  return 0.6;
}

function scoreCandidate(track, queryMeta) {
  const haystack = `${track?.title || ""} ${track?.author || ""}`;
  const normalizedTitle = normalizeText(track?.title || "");
  const normalizedHaystack = normalizeText(haystack);
  const haystackTokens = normalizedHaystack.split(" ").filter(Boolean);
  const haystackTokenSet = new Set(haystackTokens);

  const matchedTokens = queryMeta.tokens.filter((token) => {
    for (const haystackToken of haystackTokenSet) {
      if (tokenMatches(token, haystackToken)) {
        return true;
      }
    }
    return false;
  });

  const matchCount = matchedTokens.length;
  const tokenCoverage = queryMeta.tokens.length > 0 ? matchCount / queryMeta.tokens.length : 0;
  const containsFullQuery = Boolean(queryMeta.normalizedQuery) && normalizedHaystack.includes(queryMeta.normalizedQuery);
  const startsWithQuery = Boolean(queryMeta.normalizedQuery) && normalizedHaystack.startsWith(queryMeta.normalizedQuery);
  const orderedPhraseMatch = queryMeta.tokens.length > 1 && normalizedHaystack.includes(queryMeta.tokens.join(" "));

  let extraVersionPenalty = 0;
  for (const keyword of EXTRA_VERSION_KEYWORDS) {
    if (haystackTokenSet.has(keyword) && !queryMeta.tokenSet.has(keyword)) {
      extraVersionPenalty += 1;
    }
  }

  const views = Number(track?.views) || 0;
  const durationSec = Number(track?.durationSec) || 0;
  const tokenCount = queryMeta.tokens.length || 1;
  const viewsWeight = tokenCount <= 2 ? 13 : tokenCount <= 4 ? 11 : 8;
  const hasArtistInTitle = /[-–—]/u.test(String(track?.title || ""));
  const exactTitleMatch = normalizedTitle === queryMeta.normalizedQuery;
  const titleTokenCount = normalizedTitle ? normalizedTitle.split(" ").length : 0;
  const isTopicChannel = /- topic$/iu.test(String(track?.author || ""));
  let score = 0;

  score += tokenCoverage * 95;
  score += matchCount * 10;

  if (containsFullQuery) {
    score += 42;
  }
  if (startsWithQuery) {
    score += 10;
  }
  if (orderedPhraseMatch) {
    score += 10;
  }

  score += views > 0 ? Math.log10(views + 1) * viewsWeight : 0;
  score -= extraVersionPenalty * 9;
  score += hasArtistInTitle ? 6 : 0;
  score -= exactTitleMatch ? 14 : 0;

  if (hasArtistInTitle) {
    score += 8;
  }
  if (exactTitleMatch && !hasArtistInTitle) {
    score -= 20;
  }
  if (titleTokenCount > Math.max(10, queryMeta.tokens.length * 6)) {
    score -= 10;
  }
  if (isTopicChannel) {
    score -= 10;
  }

  const queryHintsLongVersion = queryMeta.tokenSet.has("live") || queryMeta.tokenSet.has("концерт");
  if (!queryHintsLongVersion && durationSec > 11 * 60) {
    score -= 6;
  }
  if (durationSec > 0 && durationSec < 50) {
    score -= 6;
  }

  const strictMatch =
    containsFullQuery || startsWithQuery || tokenCoverage >= strictCoverageThreshold(queryMeta.tokens.length);

  return {
    track,
    score,
    strictMatch,
    tokenCoverage,
    matchCount,
    views,
  };
}

function rankCandidatesByQuery(candidates, query) {
  const uniqueCandidates = dedupeTracksByIdentity(dedupeTracksByUrl(candidates));
  if (uniqueCandidates.length <= 1) {
    return uniqueCandidates;
  }

  const queryMeta = buildQueryMeta(query);
  const scored = uniqueCandidates.map((track) => scoreCandidate(track, queryMeta));
  const relevant = scored.filter((entry) => entry.matchCount > 0 || entry.strictMatch);
  const pool = relevant.length > 0 ? relevant : scored;

  pool.sort((left, right) => {
    if (left.strictMatch !== right.strictMatch) {
      return left.strictMatch ? -1 : 1;
    }
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.tokenCoverage !== left.tokenCoverage) {
      return right.tokenCoverage - left.tokenCoverage;
    }
    return right.views - left.views;
  });

  return pool.map((entry) => entry.track);
}

async function resolveCandidateVideosFromUrls(urls, requestedBy, maxCount = API_RESOLVE_LIMIT) {
  const selectedUrls = urls.slice(0, Math.max(1, maxCount));
  if (selectedUrls.length === 0) {
    return [];
  }

  const settled = await Promise.allSettled(selectedUrls.map((url) => resolveCandidateVideo(url, requestedBy)));
  const resolved = [];

  settled.forEach((result, index) => {
    const url = selectedUrls[index];
    if (result.status === "fulfilled") {
      resolved.push(result.value);
    } else {
      console.warn(`[Resolve] API-кандидат пропущен: ${url} | ${result.reason?.message || "Unknown error"}`);
    }
  });

  return resolved;
}

async function resolveTrackByMetadataQuery(query, requestedBy) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return null;
  }

  const candidates = await resolveSearchCandidates(normalizedQuery, requestedBy, {
    limit: SEARCH_TRACK_PACK_SIZE,
  }).catch(() => []);

  return packSearchTracks(candidates, normalizedQuery);
}

async function resolveTrackByQueryVariants(queries, requestedBy, options = {}) {
  const uniqueQueries = [...new Set((queries || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (uniqueQueries.length === 0) {
    return null;
  }

  const accept = typeof options.accept === "function" ? options.accept : () => true;
  for (const query of uniqueQueries) {
    const track = await resolveTrackByMetadataQuery(query, requestedBy).catch(() => null);
    if (!track) {
      continue;
    }

    if (!accept(track, query)) {
      continue;
    }

    return track;
  }

  return null;
}

async function resolveTracksFromMetadataItems(items, requestedBy) {
  const sourceItems = Array.isArray(items) ? items.slice(0, MAX_PLAYLIST_ITEMS) : [];
  const resolvedTracks = [];

  for (const item of sourceItems) {
    const title = String(item?.title || "").trim();
    if (!title) {
      continue;
    }

    const artist = String(item?.artist || "").trim();
    const query = buildQueryFromArtistTitle(artist, title);
    const resolvedTrack = await resolveTrackByMetadataQuery(query, requestedBy).catch(() => null);
    if (resolvedTrack) {
      resolvedTracks.push(resolvedTrack);
    }

    if (resolvedTracks.length >= MAX_PLAYLIST_ITEMS) {
      break;
    }
  }

  return resolvedTracks;
}

function requestTextWithRedirect(url, options = {}, redirectCount = 0) {
  const maxRedirects = 4;
  const timeoutMs = Number(options.timeoutMs) || EXTERNAL_FETCH_TIMEOUT_MS;
  const headers = options.headers || {};

  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }

    const client = parsedUrl.protocol === "http:" ? http : https;
    const req = client.request(
      parsedUrl,
      {
        method: "GET",
        headers,
      },
      (res) => {
        const statusCode = Number(res.statusCode) || 0;
        const location = String(res.headers.location || "");
        if (location && statusCode >= 300 && statusCode < 400 && redirectCount < maxRedirects) {
          const nextUrl = new URL(location, parsedUrl).toString();
          res.resume();
          requestTextWithRedirect(nextUrl, options, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode,
            body,
            finalUrl: parsedUrl.toString(),
            headers: res.headers,
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

function fetchJsonViaCurl(url) {
  return new Promise((resolve) => {
    const maxTimeSec = Math.max(4, Math.ceil(EXTERNAL_FETCH_TIMEOUT_MS / 1000));
    const args = [
      "-sS",
      "-L",
      "--max-time",
      String(maxTimeSec),
      "-A",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      "-H",
      "accept: application/json,text/plain,*/*",
      "-H",
      "accept-language: ru,en-US;q=0.9,en;q=0.8",
      "-H",
      "referer: https://music.yandex.ru/",
      String(url),
    ];

    execFile(
      "curl",
      args,
      {
        timeout: EXTERNAL_FETCH_TIMEOUT_MS + 2_000,
        windowsHide: true,
        maxBuffer: 3 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null);
          return;
        }

        const text = String(stdout).trim();
        if (!text || (text[0] !== "{" && text[0] !== "[")) {
          resolve(null);
          return;
        }

        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function fetchJsonWithTimeout(url) {
  try {
    const curlJson = await fetchJsonViaCurl(url);
    if (curlJson) {
      return curlJson;
    }

    const response = await requestTextWithRedirect(url, {
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        accept: "application/json,text/plain,*/*",
        "accept-language": "ru,en-US;q=0.9,en;q=0.8",
        referer: "https://music.yandex.ru/",
      },
    });

    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
      return null;
    }

    const text = String(response.body || "").trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) {
      return null;
    }

    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function resolveYandexUrl(url, requestedBy) {
  const info = parseYandexUrlInfo(url);
  if (!info) {
    return null;
  }

  if (info.trackId) {
    const trackParam = info.albumId ? `${info.trackId}:${info.albumId}` : info.trackId;
    const trackUrl = new URL("/handlers/track.jsx", info.origin);
    trackUrl.searchParams.set("track", trackParam);

    const trackData = await fetchJsonWithTimeout(trackUrl.toString());
    const trackMeta = trackData?.track || trackData?.result?.track || null;

    if (trackMeta?.title) {
      const artist = joinArtists(trackMeta.artists);
      const query = buildQueryFromArtistTitle(artist, trackMeta.title);
      const resolvedTrack =
        (await resolveTrackByQueryVariants(
          [query, buildQueryFromArtistTitle(artist, `${trackMeta.title} official`), buildQueryFromArtistTitle(artist, `${trackMeta.title} audio`)],
          requestedBy,
          {
            accept: (candidate) => hasQueryTokenCoverage(`${candidate?.author || ""} ${candidate?.title || ""}`, query),
          }
        )) || (await resolveTrackByMetadataQuery(query, requestedBy));
      if (resolvedTrack) {
        return {
          tracks: [resolvedTrack],
          kind: "yandex_track",
          title: trackMeta.title || "Yandex track",
        };
      }
    }
  }

  if (info.albumId) {
    const albumUrl = new URL("/handlers/album.jsx", info.origin);
    albumUrl.searchParams.set("album", info.albumId);

    const albumData = await fetchJsonWithTimeout(albumUrl.toString());
    const volumes = Array.isArray(albumData?.volumes) ? albumData.volumes : [];
    if (info.trackId) {
      let exactTrack = null;

      for (const volume of volumes) {
        const tracks = Array.isArray(volume) ? volume : [];
        for (const track of tracks) {
          const currentTrackId = String(track?.id || track?.realId || "");
          if (currentTrackId && currentTrackId === String(info.trackId)) {
            exactTrack = track;
            break;
          }
        }

        if (exactTrack) {
          break;
        }
      }

      if (exactTrack?.title) {
        const query = buildQueryFromArtistTitle(joinArtists(exactTrack.artists), exactTrack.title);
        const resolvedTrack =
          (await resolveTrackByQueryVariants(
            [query, `${query} official`, `${query} audio`],
            requestedBy,
            {
              accept: (candidate) => hasQueryTokenCoverage(`${candidate?.author || ""} ${candidate?.title || ""}`, query),
            }
          )) || (await resolveTrackByMetadataQuery(query, requestedBy));
        if (resolvedTrack) {
          return {
            tracks: [resolvedTrack],
            kind: "yandex_track",
            title: exactTrack.title || "Yandex track",
          };
        }
      }

      return null;
    }

    const metadata = [];
    for (const volume of volumes) {
      const tracks = Array.isArray(volume) ? volume : [];
      for (const track of tracks) {
        metadata.push({
          title: track?.title || "",
          artist: joinArtists(track?.artists),
        });
      }
    }

    const resolvedTracks = await resolveTracksFromMetadataItems(metadata, requestedBy);
    if (resolvedTracks.length > 0) {
      return {
        tracks: resolvedTracks,
        kind: "yandex_album",
        title: albumData?.title || "Yandex album",
      };
    }
  }

  return null;
}

async function resolveSpotifyUrl(url, requestedBy) {
  if (!HAS_SPOTIFY_AUTH) {
    return null;
  }

  const type = play.sp_validate(url);
  if (!type || type === "search") {
    return null;
  }

  const spotify = await play.spotify(url);
  if (!spotify) {
    return null;
  }

  if (spotify.type === "track") {
    const query = buildQueryFromArtistTitle(joinArtists(spotify.artists), spotify.name);
    const track = await resolveTrackByMetadataQuery(query, requestedBy);
    if (!track) {
      throw new Error("Не удалось подобрать источник по Spotify-треку.");
    }

    return {
      tracks: [track],
      kind: "spotify_track",
      title: spotify.name || "Spotify track",
    };
  }

  const spotifyTracks = await spotify.all_tracks();
  const metadata = spotifyTracks.map((item) => ({
    title: item?.name || "",
    artist: joinArtists(item?.artists),
  }));

  const tracks = await resolveTracksFromMetadataItems(metadata, requestedBy);
  if (tracks.length === 0) {
    throw new Error("Не удалось сопоставить Spotify-треки с YouTube-источниками.");
  }

  return {
    tracks,
    kind: spotify.type === "playlist" ? "spotify_playlist" : "spotify_album",
    title: spotify.name || "Spotify",
  };
}

async function resolveDeezerUrl(url, requestedBy) {
  const type = await play.dz_validate(url).catch(() => false);
  if (!type || type === "search") {
    return null;
  }

  const deezer = await play.deezer(url);
  if (!deezer) {
    return null;
  }

  if (deezer.type === "track") {
    const query = buildQueryFromArtistTitle(deezer.artist?.name, deezer.title);
    const track = await resolveTrackByMetadataQuery(query, requestedBy);
    if (!track) {
      throw new Error("Не удалось подобрать источник по Deezer-треку.");
    }

    return {
      tracks: [track],
      kind: "deezer_track",
      title: deezer.title || "Deezer track",
    };
  }

  const deezerTracks = await deezer.all_tracks();
  const metadata = deezerTracks.map((item) => ({
    title: item?.title || "",
    artist: item?.artist?.name || "",
  }));

  const tracks = await resolveTracksFromMetadataItems(metadata, requestedBy);
  if (tracks.length === 0) {
    throw new Error("Не удалось сопоставить Deezer-треки с YouTube-источниками.");
  }

  return {
    tracks,
    kind: deezer.type === "playlist" ? "deezer_playlist" : "deezer_album",
    title: deezer.title || "Deezer",
  };
}

async function fetchExternalPageMetadata(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ru,en-US;q=0.9,en;q=0.8",
      },
    });

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html")) {
      return null;
    }

    const html = await response.text();
    const ogTitle = extractMetaContent(html, "property", "og:title");
    const twitterTitle = extractMetaContent(html, "name", "twitter:title");
    const siteName = extractMetaContent(html, "property", "og:site_name");
    const titleTag = extractTitleTag(html);

    const finalUrl = response.url || url;
    const hostName = (() => {
      try {
        return new URL(finalUrl).hostname;
      } catch {
        return "";
      }
    })();

    const title = ogTitle || twitterTitle || titleTag;
    return {
      title,
      siteName,
      hostName,
      finalUrl,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveGenericExternalUrl(url, requestedBy) {
  const pageMeta = await fetchExternalPageMetadata(url);
  if (!pageMeta?.title) {
    return null;
  }

  const cleanedTitle = cleanExternalTitle(pageMeta.title, pageMeta.siteName);
  if (!cleanedTitle) {
    return null;
  }

  const finalHost = (() => {
    try {
      return new URL(pageMeta.finalUrl || url).hostname;
    } catch {
      return "";
    }
  })();

  if (isGenericLandingTitle(cleanedTitle) && (isYandexMusicHost(finalHost) || /music\.yandex/i.test(cleanedTitle))) {
    return null;
  }

  const track = await resolveTrackByMetadataQuery(cleanedTitle, requestedBy);
  if (!track) {
    return null;
  }

  return {
    tracks: [track],
    kind: "external_url",
    title: pageMeta.hostName || "External link",
  };
}

async function resolveSearchCandidates(query, requestedBy, options = {}) {
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));
  const normalizedQuery = normalizeInput(query);

  if (!normalizedQuery) {
    return [];
  }

  if (isUrl(normalizedQuery)) {
    throw new Error("Для меню выбора нужен текстовый запрос, а не ссылка.");
  }

  const rawCandidates = [];
  const targetSearchSize = Math.max(SEARCH_RESULTS_LIMIT * 2, limit * SEARCH_CANDIDATE_POOL_MULTIPLIER);

  try {
    const strictResults = await play.search(normalizedQuery, {
      source: { youtube: "video" },
      limit: targetSearchSize,
      fuzzy: false,
    });

    const fromStrict = (strictResults || [])
      .map((video) => toYouTubeTrack(video, requestedBy))
      .filter((track) => track?.url);

    rawCandidates.push(...fromStrict);

    if (fromStrict.length < limit) {
      const fuzzyResults = await play.search(normalizedQuery, {
        source: { youtube: "video" },
        limit: targetSearchSize,
        fuzzy: true,
      });

      const fromFuzzy = (fuzzyResults || [])
        .map((video) => toYouTubeTrack(video, requestedBy))
        .filter((track) => track?.url);

      rawCandidates.push(...fromFuzzy);
    }
  } catch (error) {
    console.warn(`[Resolve] Ошибка play.search "${normalizedQuery}": ${error.message}`);
  }

  const uniqueCandidates = dedupeTracksByUrl(rawCandidates);
  const seenUrls = new Set(uniqueCandidates.map((track) => track.url));

  const [apiByRelevance, apiByViews] = await Promise.all([
    searchYoutubeByApi(normalizedQuery, {
      maxResults: targetSearchSize,
      order: "relevance",
    }).catch(() => []),
    searchYoutubeByApi(normalizedQuery, {
      maxResults: targetSearchSize,
      order: "viewCount",
    }).catch(() => []),
  ]);

  const apiUrls = [...new Set([...apiByRelevance, ...apiByViews])].filter((url) => !seenUrls.has(url));
  const apiResolvedTracks = await resolveCandidateVideosFromUrls(apiUrls, requestedBy, Math.min(targetSearchSize, API_RESOLVE_LIMIT));

  for (const track of apiResolvedTracks) {
    if (!track?.url || seenUrls.has(track.url)) {
      continue;
    }

    uniqueCandidates.push(track);
    seenUrls.add(track.url);
  }

  const rankedCandidates = rankCandidatesByQuery(uniqueCandidates, normalizedQuery);
  return rankedCandidates.slice(0, limit);
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

  const candidates = await resolveSearchCandidates(query, requestedBy, {
    limit: SEARCH_TRACK_PACK_SIZE,
  }).catch((error) => {
    console.error(`[Resolve] Ошибка поиска "${query}":`, error.message);
    return [];
  });

  const packedTrack = packSearchTracks(candidates, query);
  if (packedTrack) {
    console.log(`[Resolve] Выбран кандидат из поиска: ${packedTrack.url}; запасных: ${packedTrack.fallbackTracks.length}`);
    return {
      tracks: [packedTrack],
      kind: "youtube_search",
    };
  }

  throw new Error("Не удалось найти трек по запросу.");
}

async function resolveTracks(query, requestedBy) {
  const normalizedInput = normalizeInput(query);
  const extractedUrl = isUrl(normalizedInput) ? normalizedInput : extractUrlFromText(normalizedInput);
  const input = extractedUrl || normalizedInput;

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

    const yandexInfo = parseYandexUrlInfo(input);
    if (yandexInfo) {
      const yandexResolved = await resolveYandexUrl(input, requestedBy).catch((error) => {
        console.warn(`[Resolve] Yandex URL fallback (${input}): ${error.message}`);
        return null;
      });
      if (yandexResolved) {
        return yandexResolved;
      }

      throw new Error("Не удалось получить метаданные из ссылки Яндекс Музыки (возможно, временная капча/ограничение).");
    }

    const spotifyResolved = await resolveSpotifyUrl(input, requestedBy).catch((error) => {
      console.warn(`[Resolve] Spotify URL fallback (${input}): ${error.message}`);
      return null;
    });
    if (spotifyResolved) {
      return spotifyResolved;
    }

    const deezerResolved = await resolveDeezerUrl(input, requestedBy).catch((error) => {
      console.warn(`[Resolve] Deezer URL fallback (${input}): ${error.message}`);
      return null;
    });
    if (deezerResolved) {
      return deezerResolved;
    }

    const externalResolved = await resolveGenericExternalUrl(input, requestedBy);
    if (externalResolved) {
      return externalResolved;
    }

    throw new Error("Ссылка не поддерживается или недоступна без авторизации. Используй YouTube/SoundCloud/Spotify/Deezer либо публичную ссылку.");
  }

  return resolveFromSearch(input, requestedBy);
}

module.exports = {
  resolveTracks,
  resolveSearchCandidates,
};

