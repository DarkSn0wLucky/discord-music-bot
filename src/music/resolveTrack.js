const http = require("http");
const https = require("https");
const dns = require("dns");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const play = require("play-dl");
const {
  MAX_PLAYLIST_ITEMS,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  VK_COOKIES_PATH,
  YANDEX_PLAYLIST_HINTS,
  YOUTUBE_API_KEY,
  YTDLP_BIN,
  YTDLP_COOKIES_PATH,
  YTDLP_EXTRACTOR_ARGS,
  YTDLP_RUNTIME_PATH,
} = require("../config");

const SEARCH_RESULTS_LIMIT = 8;
const SEARCH_TRACK_PACK_SIZE = 5;
const SEARCH_CANDIDATE_POOL_MULTIPLIER = 4;
const API_RESOLVE_LIMIT = 12;
const EXTERNAL_FETCH_TIMEOUT_MS = 8_000;
const METADATA_RESOLVE_CONCURRENCY = 3;
const METADATA_ITEM_RESOLVE_TIMEOUT_MS = 12_000;
const PLAYLIST_RESOLVE_BUDGET_MS = 45_000;
const PLAYLIST_FAST_MODE_THRESHOLD = 40;
const NETWORK_CHECK_CACHE_TTL_MS = 5 * 60 * 1000;
const HAS_SPOTIFY_AUTH = Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && SPOTIFY_REFRESH_TOKEN);
const networkCheckCache = new Map();
const yandexPlaylistHintMap = parseYandexPlaylistHints(YANDEX_PLAYLIST_HINTS);

function limitItems(list, limit) {
  const items = Array.isArray(list) ? list : [];
  if (!Number.isFinite(limit) || limit <= 0) {
    return items.slice();
  }
  return items.slice(0, Math.floor(limit));
}

function parseYandexPlaylistHints(raw) {
  const map = new Map();
  const value = String(raw || "").trim();
  if (!value) {
    return map;
  }

  const entries = value
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [uuidPart, targetPart] = entry.split("=").map((part) => String(part || "").trim());
    if (!uuidPart || !targetPart) {
      continue;
    }

    const [owner, kind] = targetPart.split(":").map((part) => String(part || "").trim());
    if (!owner || !kind) {
      continue;
    }

    map.set(uuidPart.toLowerCase(), { owner, kind });
  }

  return map;
}

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
  "РїРµСЃРЅСЏ",
  "РїРµСЃРЅСЋ",
  "РїРµСЃРЅРё",
  "С‚СЂРµРє",
  "РјСѓР·С‹РєР°",
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
  "Р°РєСѓСЃС‚РёРєР°",
  "Р°РєСѓСЃС‚РёС‡РµСЃРєРёР№",
  "РєРѕРЅС†РµСЂС‚",
  "РєР°СЂР°РѕРєРµ",
  "РєР°РІРµСЂ",
  "СЂРµРјРёРєСЃ",
  "РІРµСЂСЃРёСЏ",
]);

const NON_MUSIC_KEYWORDS = new Set([
  "подкаст",
  "podcast",
  "интервью",
  "interview",
  "shorts",
  "новости",
  "news",
  "реакция",
  "reaction",
  "обзор",
  "review",
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
    .replace(/С‘/g, "Рµ")
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

function isVkMusicHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "vk.com" || host === "m.vk.com" || host.endsWith(".vk.com");
}

function isPrivateIPv4(address) {
  const parts = String(address || "")
    .trim()
    .split(".");

  if (parts.length !== 4 || parts.some((chunk) => !/^\d+$/.test(chunk))) {
    return false;
  }

  const numbers = parts.map((chunk) => Number(chunk));
  if (numbers.some((value) => value < 0 || value > 255)) {
    return false;
  }

  const [a, b] = numbers;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }

  return false;
}

function isPrivateIPv6(address) {
  const value = String(address || "").toLowerCase().trim();
  if (!value) {
    return false;
  }

  return value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
}

function isPrivateIpAddress(address) {
  return isPrivateIPv4(address) || isPrivateIPv6(address);
}

function isBlockedHostname(hostname) {
  const host = String(hostname || "").toLowerCase().trim();
  if (!host) {
    return true;
  }

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }

  if (host === "metadata.google.internal" || host.endsWith(".internal")) {
    return true;
  }

  return false;
}

async function isBlockedNetworkTarget(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return true;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return true;
  }

  const hostname = String(parsedUrl.hostname || "").toLowerCase();
  if (!hostname || isBlockedHostname(hostname)) {
    return true;
  }

  if (isPrivateIpAddress(hostname)) {
    return true;
  }

  const cached = networkCheckCache.get(hostname);
  if (cached && Date.now() - cached.checkedAt <= NETWORK_CHECK_CACHE_TTL_MS) {
    return cached.blocked;
  }

  try {
    const lookupResults = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    const blocked = !Array.isArray(lookupResults) || lookupResults.length === 0
      ? true
      : lookupResults.some((entry) => isPrivateIpAddress(entry?.address));

    networkCheckCache.set(hostname, { blocked, checkedAt: Date.now() });
    return blocked;
  } catch {
    // Fail closed for external URL probing to avoid SSRF bypass via DNS tricks.
    networkCheckCache.set(hostname, { blocked: true, checkedAt: Date.now() });
    return true;
  }
}

function resolveExistingFilePath(configuredPath) {
  const value = String(configuredPath || "").trim();
  if (!value) {
    return null;
  }

  const absolute = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
  return fs.existsSync(absolute) ? absolute : null;
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
        playlistOwner: "",
        playlistKind: "",
        playlistUuid: "",
      };
    }

    const directTrack = pathName.match(/\/track\/(\d+)/i);
    if (directTrack) {
      return {
        origin: parsed.origin,
        albumId: parsed.searchParams.get("album") || parsed.searchParams.get("albumId") || "",
        trackId: directTrack[1],
        playlistOwner: "",
        playlistKind: "",
        playlistUuid: "",
      };
    }

    const album = pathName.match(/\/album\/(\d+)/i);
    if (album) {
      return {
        origin: parsed.origin,
        albumId: album[1],
        trackId: "",
        playlistOwner: "",
        playlistKind: "",
        playlistUuid: "",
      };
    }

    const userPlaylist = pathName.match(/\/users\/([^/]+)\/playlists\/([^/?#]+)/i);
    if (userPlaylist) {
      return {
        origin: parsed.origin,
        albumId: "",
        trackId: "",
        playlistOwner: decodeURIComponent(userPlaylist[1] || ""),
        playlistKind: decodeURIComponent(userPlaylist[2] || ""),
        playlistUuid: "",
      };
    }

    const directPlaylist = pathName.match(/\/playlists\/([^/?#]+)/i);
    if (directPlaylist) {
      return {
        origin: parsed.origin,
        albumId: "",
        trackId: "",
        playlistOwner: "",
        playlistKind: "",
        playlistUuid: decodeURIComponent(directPlaylist[1] || ""),
      };
    }

    return {
      origin: parsed.origin,
      albumId: "",
      trackId: "",
      playlistOwner: "",
      playlistKind: "",
      playlistUuid: "",
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

function extractYouTubeVideoId(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    const host = String(parsed.hostname || "").toLowerCase();

    if (host === "youtu.be") {
      const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
      return /^[\w-]{11}$/.test(id) ? id : "";
    }

    if (host.endsWith("youtube.com")) {
      const byQuery = parsed.searchParams.get("v");
      if (/^[\w-]{11}$/.test(byQuery || "")) {
        return byQuery;
      }

      const segments = parsed.pathname.split("/").filter(Boolean);
      const shortsIndex = segments.indexOf("shorts");
      if (shortsIndex >= 0 && /^[\w-]{11}$/.test(segments[shortsIndex + 1] || "")) {
        return segments[shortsIndex + 1];
      }

      const embedIndex = segments.indexOf("embed");
      if (embedIndex >= 0 && /^[\w-]{11}$/.test(segments[embedIndex + 1] || "")) {
        return segments[embedIndex + 1];
      }
    }

    return "";
  } catch {
    return "";
  }
}

function parseIsoDurationToSeconds(isoDuration) {
  const value = String(isoDuration || "").trim();
  if (!value) {
    return 0;
  }

  const match = value.match(/P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?/i);
  if (!match) {
    return 0;
  }

  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
}

function youtubeSnippetThumb(snippet) {
  const thumbs = snippet?.thumbnails || {};
  return (
    thumbs.maxres?.url ||
    thumbs.standard?.url ||
    thumbs.high?.url ||
    thumbs.medium?.url ||
    thumbs.default?.url ||
    null
  );
}

function toYouTubeTrackFromApiItem(item, requestedBy) {
  const videoId = String(item?.id || "").trim();
  if (!/^[\w-]{11}$/.test(videoId)) {
    return null;
  }

  const snippet = item?.snippet || {};
  const stats = item?.statistics || {};
  const durationSec = parseIsoDurationToSeconds(item?.contentDetails?.duration);

  return {
    title: String(snippet.title || "Р‘РµР· РЅР°Р·РІР°РЅРёСЏ").trim() || "Р‘РµР· РЅР°Р·РІР°РЅРёСЏ",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    source: "YouTube",
    author: String(snippet.channelTitle || "YouTube").trim() || "YouTube",
    views: Number(stats.viewCount) || 0,
    durationSec,
    durationMs: durationSec > 0 ? durationSec * 1000 : 0,
    thumbnail: youtubeSnippetThumb(snippet),
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
  };
}

async function fetchYouTubeApiVideoItems(videoIds) {
  if (!YOUTUBE_API_KEY) {
    return [];
  }

  const ids = [...new Set((videoIds || []).map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 50);
  if (ids.length === 0) {
    return [];
  }

  const params = new URLSearchParams({
    part: "snippet,contentDetails,statistics",
    id: ids.join(","),
    key: YOUTUBE_API_KEY,
    maxResults: String(ids.length),
  });

  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`);
  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
}

function toYouTubeTrack(video, requestedBy) {
  const durationSec = Number(video.durationInSec) || 0;

  return {
    title: video.title || "Р‘РµР· РЅР°Р·РІР°РЅРёСЏ",
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
    title: track.name || "Р‘РµР· РЅР°Р·РІР°РЅРёСЏ",
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
    .replace(/\s*[|вЂў]\s*[^|вЂў]+$/u, "")
    .replace(/\s+[-вЂ“вЂ”]\s*(yandex music|СЏРЅРґРµРєСЃ РјСѓР·С‹РєР°|spotify|vk music|РІРєРѕРЅС‚Р°РєС‚Рµ|deezer|apple music|tidal)\s*$/iu, "")
    .replace(/^(listen to|watch|СЃР»СѓС€Р°С‚СЊ)\s+/iu, "")
    .replace(/\s+(on|РІ)\s+(spotify|youtube|yandex music|СЏРЅРґРµРєСЃ РјСѓР·С‹РєРµ|vk music|deezer|apple music|tidal)\s*$/iu, "")
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
    "СЏРЅРґРµРєСЃ РјСѓР·С‹РєР°",
    "СЏРЅРґРµРєСЃ РјСѓР·С‹РєР° СЃРѕР±РёСЂР°РµРј РјСѓР·С‹РєСѓ РґР»СЏ РІР°СЃ",
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

  let nonMusicPenalty = 0;
  for (const keyword of NON_MUSIC_KEYWORDS) {
    if (haystackTokenSet.has(keyword) && !queryMeta.tokenSet.has(keyword)) {
      nonMusicPenalty += 1;
    }
  }

  const views = Number(track?.views) || 0;
  const durationSec = Number(track?.durationSec) || 0;
  const tokenCount = queryMeta.tokens.length || 1;
  const viewsWeight = tokenCount <= 2 ? 13 : tokenCount <= 4 ? 11 : 8;
  const hasArtistInTitle = /[-вЂ“вЂ”]/u.test(String(track?.title || ""));
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
  score -= nonMusicPenalty * 24;
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

  const queryHintsLongVersion = queryMeta.tokenSet.has("live") || queryMeta.tokenSet.has("РєРѕРЅС†РµСЂС‚");
  if (!queryHintsLongVersion && durationSec > 11 * 60) {
    score -= 6;
  }
  const queryHintsNonMusic =
    queryMeta.tokenSet.has("подкаст") ||
    queryMeta.tokenSet.has("podcast") ||
    queryMeta.tokenSet.has("интервью") ||
    queryMeta.tokenSet.has("interview");
  if (!queryHintsNonMusic && durationSec > 20 * 60) {
    score -= 22;
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

async function resolveCandidateVideosFromUrls(urls, requestedBy, maxCount = API_RESOLVE_LIMIT, options = {}) {
  const allowYtdlpFallback = options.allowYtdlpFallback !== false;
  const selectedUrls = urls.slice(0, Math.max(1, maxCount));
  if (selectedUrls.length === 0) {
    return [];
  }

  const resolved = [];
  const resolvedUrls = new Set();
  const youtubeIdByUrl = new Map();

  for (const url of selectedUrls) {
    const id = extractYouTubeVideoId(url);
    if (id) {
      youtubeIdByUrl.set(url, id);
    }
  }

  if (youtubeIdByUrl.size > 0) {
    const apiItems = await fetchYouTubeApiVideoItems([...new Set(youtubeIdByUrl.values())]).catch(() => []);
    const apiTrackById = new Map();

    for (const item of apiItems) {
      const track = toYouTubeTrackFromApiItem(item, requestedBy);
      if (!track?.url) {
        continue;
      }

      const id = extractYouTubeVideoId(track.url);
      if (id) {
        apiTrackById.set(id, track);
      }
    }

    for (const url of selectedUrls) {
      const id = youtubeIdByUrl.get(url);
      if (!id) {
        continue;
      }

      const track = apiTrackById.get(id);
      if (!track?.url || resolvedUrls.has(track.url)) {
        continue;
      }

      resolved.push(track);
      resolvedUrls.add(track.url);
    }
  }

  const unresolvedUrls = selectedUrls.filter((url) => {
    const id = youtubeIdByUrl.get(url);
    if (!id) {
      return true;
    }

    return !resolved.some((track) => extractYouTubeVideoId(track.url) === id);
  });

  if (!allowYtdlpFallback) {
    return resolved;
  }

  const settled = await Promise.allSettled(unresolvedUrls.map((url) => resolveCandidateVideo(url, requestedBy)));

  settled.forEach((result, index) => {
    const url = unresolvedUrls[index];
    if (result.status === "fulfilled") {
      const track = result.value;
      if (track?.url && !resolvedUrls.has(track.url)) {
        resolved.push(track);
        resolvedUrls.add(track.url);
      }
    } else {
      console.warn(`[Resolve] API-кандидат пропущен: ${url} | ${result.reason?.message || "Unknown error"}`);
    }
  });

  return resolved;
}

async function resolveTrackByMetadataQuery(query, requestedBy, options = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return null;
  }

  const allowYtdlpFallback = options.allowYtdlpFallback !== false;
  const candidates = await resolveSearchCandidates(normalizedQuery, requestedBy, {
    limit: SEARCH_TRACK_PACK_SIZE,
    allowYtdlpFallback,
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
    const track = await resolveTrackByMetadataQuery(query, requestedBy, options).catch(() => null);
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

function normalizeMetadataPiece(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitArtistTitle(rawTitle) {
  const value = normalizeMetadataPiece(rawTitle);
  if (!value) {
    return { artist: "", title: "" };
  }

  const separators = [" - ", " – ", " — ", " —", " –", "- "];
  for (const separator of separators) {
    const index = value.indexOf(separator);
    if (index > 0 && index < value.length - separator.length) {
      const artist = normalizeMetadataPiece(value.slice(0, index));
      const title = normalizeMetadataPiece(value.slice(index + separator.length));
      if (artist && title) {
        return { artist, title };
      }
    }
  }

  return { artist: "", title: value };
}

function normalizeMetadataItem(rawItem, defaultArtist = "") {
  const fallbackArtist = normalizeMetadataPiece(defaultArtist);
  const source = rawItem || {};

  const directArtist = normalizeMetadataPiece(
    source.artist ||
      source.uploader ||
      source.channel ||
      source.author ||
      source.creator ||
      source.album_artist ||
      fallbackArtist
  );

  const directTitle = normalizeMetadataPiece(
    source.title || source.track || source.name || source.fulltitle || source.alt_title
  );

  const split = splitArtistTitle(directTitle);
  const artist = directArtist || split.artist || fallbackArtist;
  const title = split.title || directTitle;

  if (!title) {
    return null;
  }

  return { artist, title };
}

function buildMetadataQueries(item) {
  const normalized = normalizeMetadataItem(item);
  if (!normalized?.title) {
    return [];
  }

  const title = normalized.title;
  const artist = normalized.artist;
  const queries = [];

  if (artist) {
    queries.push(buildQueryFromArtistTitle(artist, title));
    queries.push(buildQueryFromArtistTitle(artist, `${title} official audio`));
    queries.push(buildQueryFromArtistTitle(artist, `${title} audio`));
  }

  queries.push(title);
  queries.push(`${title} official audio`);

  return [...new Set(queries.map((value) => String(value || "").trim()).filter(Boolean))];
}

function buildMetadataFallbackTrack(item, requestedBy, primaryQuery = "") {
  const normalized = normalizeMetadataItem(item);
  if (!normalized?.title) {
    return null;
  }

  const artist = String(normalized.artist || "").trim();
  const title = String(normalized.title || "").trim();
  const query = String(primaryQuery || buildQueryFromArtistTitle(artist, title) || title).trim();
  if (!query) {
    return null;
  }

  const displayTitle = artist ? `${artist} - ${title}` : title;

  return {
    title: displayTitle || title || "Без названия",
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    playbackUrl: `ytsearch1:${query}`,
    source: "YouTube",
    author: artist || "YouTube",
    views: 0,
    durationSec: 0,
    durationMs: 0,
    thumbnail: null,
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
    searchQuery: query,
    fallbackTracks: [],
  };
}

async function resolveTracksFromMetadataItems(items, requestedBy) {
  const sourceItems = limitItems(items, MAX_PLAYLIST_ITEMS);
  if (!sourceItems.length) {
    return [];
  }

  const startedAt = Date.now();
  const fastMode = sourceItems.length >= PLAYLIST_FAST_MODE_THRESHOLD;
  const results = new Array(sourceItems.length).fill(null);
  const queryCache = new Map();
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(METADATA_RESOLVE_CONCURRENCY, sourceItems.length));

  async function worker() {
    while (true) {
      if (Date.now() - startedAt >= PLAYLIST_RESOLVE_BUDGET_MS) {
        return;
      }

      const index = cursor;
      cursor += 1;
      if (index >= sourceItems.length) {
        return;
      }

      const item = sourceItems[index];
      const normalizedItem = normalizeMetadataItem(item);
      if (!normalizedItem?.title) {
        continue;
      }

      const queries = buildMetadataQueries(normalizedItem);
      if (!queries.length) {
        const fallbackTrack = buildMetadataFallbackTrack(normalizedItem, requestedBy);
        if (fallbackTrack) {
          results[index] = fallbackTrack;
        }
        continue;
      }

      const primaryQuery = queries[0];
      if (fastMode) {
        const fallbackTrack = buildMetadataFallbackTrack(normalizedItem, requestedBy, primaryQuery);
        if (fallbackTrack) {
          results[index] = fallbackTrack;
        }
        continue;
      }

      const cacheKey = queries.join("||");
      if (queryCache.has(cacheKey)) {
        results[index] = queryCache.get(cacheKey);
        continue;
      }

      const resolvePromise = (async () => {
        return (
          (await resolveTrackByQueryVariants(queries, requestedBy, {
            allowYtdlpFallback: false,
          }).catch(() => null)) ||
          (await resolveTrackByMetadataQuery(primaryQuery, requestedBy, {
            allowYtdlpFallback: false,
          }).catch(() => null))
        );
      })();

      const resolvedTrack = await Promise.race([
        resolvePromise,
        new Promise((resolve) => setTimeout(() => resolve(null), METADATA_ITEM_RESOLVE_TIMEOUT_MS)),
      ]);

      if (resolvedTrack) {
        queryCache.set(cacheKey, resolvedTrack);
        results[index] = resolvedTrack;
      } else {
        const fallbackTrack = buildMetadataFallbackTrack(normalizedItem, requestedBy, primaryQuery);
        if (fallbackTrack) {
          results[index] = fallbackTrack;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return limitItems(results.filter(Boolean), MAX_PLAYLIST_ITEMS);
}

async function requestTextWithRedirect(url, options = {}, redirectCount = 0) {
  const maxRedirects = 4;
  const timeoutMs = Number(options.timeoutMs) || EXTERNAL_FETCH_TIMEOUT_MS;
  const headers = options.headers || {};

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    throw error;
  }

  if (await isBlockedNetworkTarget(parsedUrl.toString())) {
    throw new Error("Blocked target URL");
  }

  return new Promise((resolve, reject) => {
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
          requestTextWithRedirect(nextUrl, options, redirectCount + 1)
            .then(resolve)
            .catch(reject);
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

function parseYandexPlaylistTargetFromHtml(html) {
  const source = String(html || "");
  if (!source) {
    return null;
  }

  const directMatch = source.match(/"uid"\s*:\s*(\d+)\s*,\s*"kind"\s*:\s*(\d+)\s*,\s*"title"\s*:/i);
  if (directMatch) {
    return {
      owner: directMatch[1],
      kind: directMatch[2],
    };
  }

  const reverseMatch = source.match(/"kind"\s*:\s*(\d+)\s*,[\s\S]{0,1200}?"uid"\s*:\s*(\d+)/i);
  if (reverseMatch) {
    return {
      owner: reverseMatch[2],
      kind: reverseMatch[1],
    };
  }

  const metaMatch = source.match(
    /"meta"\s*:\s*\{[\s\S]{0,1200}?"uid"\s*:\s*(\d+)\s*,\s*"kind"\s*:\s*(\d+)[\s\S]{0,1200}?\}/i
  );
  if (metaMatch) {
    return {
      owner: metaMatch[1],
      kind: metaMatch[2],
    };
  }

  return null;
}

async function resolveYandexPlaylistTarget(info, originalUrl) {
  if (info.playlistOwner && info.playlistKind) {
    return {
      owner: info.playlistOwner,
      kind: info.playlistKind,
    };
  }

  if (!info.playlistUuid) {
    return null;
  }

  const hint = yandexPlaylistHintMap.get(String(info.playlistUuid || "").toLowerCase());
  if (hint?.owner && hint?.kind) {
    return {
      owner: hint.owner,
      kind: hint.kind,
    };
  }

  const response = await requestTextWithRedirect(originalUrl, {
    timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "ru,en-US;q=0.9,en;q=0.8",
      referer: "https://music.yandex.ru/",
    },
  }).catch(() => null);

  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    return null;
  }

  const resolvedTarget = parseYandexPlaylistTargetFromHtml(response.body);
  if (resolvedTarget?.owner && resolvedTarget?.kind && info.playlistUuid) {
    yandexPlaylistHintMap.set(String(info.playlistUuid).toLowerCase(), {
      owner: String(resolvedTarget.owner),
      kind: String(resolvedTarget.kind),
    });
  }

  return resolvedTarget;
}

async function fetchYandexPlaylistData(origin, owner, kind) {
  const playlistUrl = new URL("/handlers/playlist.jsx", origin);
  playlistUrl.searchParams.set("owner", String(owner));
  playlistUrl.searchParams.set("kinds", String(kind));
  playlistUrl.searchParams.set("overembed", "false");

  let playlistData = await fetchJsonWithTimeout(playlistUrl.toString());
  if (playlistData?.playlist) {
    return playlistData;
  }

  playlistUrl.searchParams.delete("overembed");
  playlistUrl.searchParams.set("lang", "ru");
  playlistData = await fetchJsonWithTimeout(playlistUrl.toString());
  if (playlistData?.playlist) {
    return playlistData;
  }

  const canonicalOrigin = "https://music.yandex.ru";
  if (String(origin || "").toLowerCase() !== canonicalOrigin) {
    const fallbackUrl = new URL("/handlers/playlist.jsx", canonicalOrigin);
    fallbackUrl.searchParams.set("owner", String(owner));
    fallbackUrl.searchParams.set("kinds", String(kind));
    fallbackUrl.searchParams.set("lang", "ru");
    playlistData = await fetchJsonWithTimeout(fallbackUrl.toString());
    if (playlistData?.playlist) {
      return playlistData;
    }
  }

  return null;
}

async function resolveYandexUrl(url, requestedBy) {
  const info = parseYandexUrlInfo(url);
  if (!info) {
    return null;
  }

  if (info.playlistKind || info.playlistUuid) {
    const target = await resolveYandexPlaylistTarget(info, url);
    if (!target?.owner || !target?.kind) {
      return null;
    }

    const playlistData = await fetchYandexPlaylistData(info.origin, target.owner, target.kind);
    const playlist = playlistData?.playlist;
    const rawTracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
    if (rawTracks.length === 0) {
      return null;
    }

    const metadata = rawTracks.map((item) => {
      const track = item?.track || item || {};
      return {
        title: track?.title || "",
        artist: joinArtists(track?.artists),
      };
    });

    const resolvedTracks = await resolveTracksFromMetadataItems(metadata, requestedBy);
    if (resolvedTracks.length > 0) {
      return {
        tracks: resolvedTracks,
        kind: "yandex_playlist",
        title: playlist?.title || "Yandex playlist",
      };
    }
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

  const ytdlpFallback = await resolveViaYtDlpMetadata(url, requestedBy, {
    sourceLabel: "Yandex Music",
    cookiesPath: YTDLP_COOKIES_PATH,
    timeoutMs: 30_000,
    playlistKind: "yandex_playlist",
    trackKind: "yandex_track",
    playlistTitleFallback: "Yandex playlist",
    trackTitleFallback: "Yandex track",
  });
  if (ytdlpFallback) {
    return ytdlpFallback;
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
      throw new Error("РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕРґРѕР±СЂР°С‚СЊ РёСЃС‚РѕС‡РЅРёРє РїРѕ Spotify-С‚СЂРµРєСѓ.");
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
    throw new Error("РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕРїРѕСЃС‚Р°РІРёС‚СЊ Spotify-С‚СЂРµРєРё СЃ YouTube-РёСЃС‚РѕС‡РЅРёРєР°РјРё.");
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
      throw new Error("РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕРґРѕР±СЂР°С‚СЊ РёСЃС‚РѕС‡РЅРёРє РїРѕ Deezer-С‚СЂРµРєСѓ.");
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
    throw new Error("РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕРїРѕСЃС‚Р°РІРёС‚СЊ Deezer-С‚СЂРµРєРё СЃ YouTube-РёСЃС‚РѕС‡РЅРёРєР°РјРё.");
  }

  return {
    tracks,
    kind: deezer.type === "playlist" ? "deezer_playlist" : "deezer_album",
    title: deezer.title || "Deezer",
  };
}

function normalizeVkEntryUrl(entry, fallbackUrl) {
  const candidates = [entry?.webpage_url, entry?.url, entry?.original_url]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const value of candidates) {
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
    if (value.startsWith("/")) {
      return `https://vk.com${value}`;
    }
    if (/^(audio|music|playlist|wall|video)/i.test(value)) {
      return `https://vk.com/${value.replace(/^\/+/, "")}`;
    }
  }

  return fallbackUrl;
}

function toVkTrack(entry, requestedBy, fallbackUrl) {
  const durationSec = Number(entry?.duration) || 0;

  return {
    title: String(entry?.title || entry?.track || "VK Music track").trim() || "VK Music track",
    url: normalizeVkEntryUrl(entry, fallbackUrl),
    source: "VK Music",
    author: String(entry?.uploader || entry?.artist || entry?.channel || "VK Music").trim() || "VK Music",
    views: Number(entry?.view_count) || 0,
    durationSec,
    durationMs: durationSec > 0 ? durationSec * 1000 : 0,
    thumbnail: entry?.thumbnail || null,
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
  };
}

function metadataFromExtractorEntry(entry, sourceLabel = "") {
  return normalizeMetadataItem(
    {
      artist:
        entry?.artist ||
        entry?.uploader ||
        entry?.channel ||
        entry?.creator ||
        entry?.author ||
        sourceLabel,
      title: entry?.track || entry?.title || entry?.fulltitle || entry?.alt_title || "",
    },
    sourceLabel
  );
}

async function resolveViaYtDlpMetadata(url, requestedBy, options = {}) {
  const sourceLabel = String(options.sourceLabel || "").trim();
  const cookiesPath = options.cookiesPath || "";
  const timeoutMs = Number(options.timeoutMs) || 30_000;
  const playlistKind = String(options.playlistKind || "external_playlist");
  const trackKind = String(options.trackKind || "external_track");
  const playlistTitleFallback = String(options.playlistTitleFallback || `${sourceLabel || "External"} playlist`);
  const trackTitleFallback = String(options.trackTitleFallback || `${sourceLabel || "External"} track`);

  const extractorJson = await fetchYtDlpJson(url, {
    timeoutMs,
    cookiesPath,
    flatPlaylist: true,
    playlistEnd: MAX_PLAYLIST_ITEMS,
  }).catch(() => null);

  if (!extractorJson) {
    return null;
  }

  const entries = Array.isArray(extractorJson.entries) ? extractorJson.entries.filter(Boolean) : [];
  if (entries.length > 0) {
    const metadata = limitItems(entries, MAX_PLAYLIST_ITEMS)
      .map((entry) => metadataFromExtractorEntry(entry, sourceLabel))
      .filter((item) => item?.title);

    if (metadata.length > 0) {
      const resolvedTracks = await resolveTracksFromMetadataItems(metadata, requestedBy);
      if (resolvedTracks.length > 0) {
        return {
          tracks: resolvedTracks,
          kind: playlistKind,
          title: extractorJson.title || playlistTitleFallback,
        };
      }
    }
  }

  const singleMetadata = metadataFromExtractorEntry(extractorJson, sourceLabel);
  if (!singleMetadata?.title) {
    return null;
  }

  const queries = buildMetadataQueries(singleMetadata);
  if (!queries.length) {
    return null;
  }

  const primaryQuery = queries[0];
  const resolvedTrack =
    (await resolveTrackByQueryVariants(queries, requestedBy).catch(() => null)) ||
    (await resolveTrackByMetadataQuery(primaryQuery, requestedBy).catch(() => null));

  if (!resolvedTrack) {
    return null;
  }

  return {
    tracks: [resolvedTrack],
    kind: trackKind,
    title: extractorJson.title || singleMetadata.title || trackTitleFallback,
  };
}

function normalizeYouTubeEntryUrl(entry, fallbackUrl = "") {
  const candidates = [entry?.webpage_url, entry?.original_url, entry?.url, entry?.id]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const value of candidates) {
    if (/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(value)) {
      return value;
    }
    if (value.startsWith("/watch?")) {
      return `https://www.youtube.com${value}`;
    }
    if (value.startsWith("watch?")) {
      return `https://www.youtube.com/${value}`;
    }
    if (/^[\w-]{11}$/.test(value)) {
      return `https://www.youtube.com/watch?v=${value}`;
    }
  }

  const fallback = String(fallbackUrl || "").trim();
  return /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(fallback) ? fallback : "";
}

function toYouTubeTrackFromYtDlp(entry, requestedBy, fallbackUrl = "") {
  const url = normalizeYouTubeEntryUrl(entry, fallbackUrl);
  if (!url) {
    return null;
  }

  const durationSec = Number(entry?.duration) || 0;
  const thumbnail =
    entry?.thumbnail ||
    (Array.isArray(entry?.thumbnails) ? entry.thumbnails[entry.thumbnails.length - 1]?.url : null) ||
    null;

  return {
    title: String(entry?.title || "Р‘РµР· РЅР°Р·РІР°РЅРёСЏ").trim() || "Р‘РµР· РЅР°Р·РІР°РЅРёСЏ",
    url,
    source: "YouTube",
    author: String(entry?.uploader || entry?.channel || entry?.artist || "YouTube").trim() || "YouTube",
    views: Number(entry?.view_count) || 0,
    durationSec,
    durationMs: durationSec > 0 ? durationSec * 1000 : 0,
    thumbnail,
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
  };
}

async function resolveYoutubeUrlViaYtDlp(url, requestedBy) {
  const ytJson = await fetchYtDlpJson(url, {
    timeoutMs: 30_000,
    cookiesPath: YTDLP_COOKIES_PATH,
    flatPlaylist: true,
    playlistEnd: MAX_PLAYLIST_ITEMS,
  }).catch(() => null);

  if (!ytJson) {
    return null;
  }

  const entries = Array.isArray(ytJson.entries) ? ytJson.entries.filter(Boolean) : [];
  if (entries.length > 0) {
    const tracks = limitItems(entries, MAX_PLAYLIST_ITEMS)
      .map((entry) => toYouTubeTrackFromYtDlp(entry, requestedBy, url))
      .filter((track) => track?.url);

    if (tracks.length > 0) {
      return {
        tracks,
        kind: "youtube_playlist",
        title: ytJson.title || "YouTube playlist",
      };
    }
  }

  const singleTrack = toYouTubeTrackFromYtDlp(ytJson, requestedBy, url);
  if (singleTrack) {
    return {
      tracks: [singleTrack],
      kind: "youtube_video",
    };
  }

  return null;
}

function fetchYtDlpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const flatPlaylist = options.flatPlaylist !== false;
    const normalizedTarget = String(url || "").trim().toLowerCase();
    const isYouTubeTarget =
      normalizedTarget.startsWith("ytsearch") ||
      /(?:youtube\.com|youtu\.be)/i.test(normalizedTarget);
    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    ];

    if (isYouTubeTarget) {
      const extractorArgs = String(YTDLP_EXTRACTOR_ARGS || "").trim();
      if (extractorArgs) {
        args.push("--extractor-args", extractorArgs);
      }
    }

    if (flatPlaylist) {
      args.push("--flat-playlist");
    }

    const playlistEnd = Number(options.playlistEnd);
    if (Number.isFinite(playlistEnd) && playlistEnd > 0) {
      args.push("--playlist-end", String(Math.floor(playlistEnd)));
    }

    const cookiesPath = resolveExistingFilePath(options.cookiesPath);
    if (cookiesPath) {
      args.push("--cookies", cookiesPath);
    }

    args.push(String(url));

    const runtimePath = String(YTDLP_RUNTIME_PATH || "").trim();
    const executionEnv = runtimePath
      ? {
          ...process.env,
          PATH: `${runtimePath}${path.delimiter}${process.env.PATH || ""}`,
        }
      : process.env;

    execFile(
      YTDLP_BIN,
      args,
      {
        windowsHide: true,
        timeout: Number(options.timeoutMs) || 25_000,
        maxBuffer: 8 * 1024 * 1024,
        env: executionEnv,
      },
      (error, stdout, stderr) => {
        const output = String(stdout || "").trim();
        if (error || !output) {
          const message = String(stderr || error?.message || "yt-dlp failed").trim();
          reject(new Error(message || "yt-dlp failed"));
          return;
        }

        try {
          resolve(JSON.parse(output));
        } catch {
          reject(new Error("yt-dlp returned invalid JSON"));
        }
      }
    );
  });
}

async function resolveVkUrl(url, requestedBy) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!isVkMusicHost(parsed.hostname)) {
    return null;
  }

  const cookiesPath = VK_COOKIES_PATH || YTDLP_COOKIES_PATH;
  const viaMetadata = await resolveViaYtDlpMetadata(url, requestedBy, {
    sourceLabel: "VK Music",
    cookiesPath,
    timeoutMs: 30_000,
    playlistKind: "vk_playlist",
    trackKind: "vk_track",
    playlistTitleFallback: "VK playlist",
    trackTitleFallback: "VK track",
  });
  if (viaMetadata) {
    return viaMetadata;
  }

  const vkJson = await fetchYtDlpJson(url, {
    timeoutMs: 30_000,
    cookiesPath,
    flatPlaylist: false,
  }).catch(() => null);

  if (!vkJson) {
    return null;
  }

  const entries = Array.isArray(vkJson.entries) ? vkJson.entries.filter(Boolean) : [];
  if (entries.length > 0) {
    const tracks = limitItems(entries, MAX_PLAYLIST_ITEMS)
      .map((entry) => toVkTrack(entry, requestedBy, url))
      .filter((track) => track?.url);

    if (tracks.length > 0) {
      return {
        tracks,
        kind: "vk_playlist",
        title: vkJson.title || "VK playlist",
      };
    }
  }

  const singleTrack = toVkTrack(vkJson, requestedBy, url);
  if (singleTrack?.url) {
    return {
      tracks: [singleTrack],
      kind: "vk_track",
      title: vkJson.title || "VK track",
    };
  }

  return null;
}

async function fetchExternalPageMetadata(url) {
  try {
    const response = await requestTextWithRedirect(url, {
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ru,en-US;q=0.9,en;q=0.8",
      },
    });

    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
      return null;
    }

    const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
    if (!contentType.includes("text/html")) {
      return null;
    }

    const html = String(response.body || "");
    const ogTitle = extractMetaContent(html, "property", "og:title");
    const twitterTitle = extractMetaContent(html, "name", "twitter:title");
    const siteName = extractMetaContent(html, "property", "og:site_name");
    const titleTag = extractTitleTag(html);

    const finalUrl = response.finalUrl || url;
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

async function searchYoutubeViaYtDlp(query, requestedBy, limit) {
  const amount = Math.max(1, Math.min(15, Number(limit) || 5));
  const ytSearchQuery = `ytsearch${amount}:${query}`;
  const json = await fetchYtDlpJson(ytSearchQuery, {
    timeoutMs: 25_000,
    cookiesPath: YTDLP_COOKIES_PATH,
    flatPlaylist: true,
    playlistEnd: amount,
  }).catch(() => null);

  if (!json) {
    return [];
  }

  const entries = Array.isArray(json.entries) ? json.entries.filter(Boolean) : [];
  return entries
    .map((entry) => toYouTubeTrackFromYtDlp(entry, requestedBy))
    .filter((track) => track?.url);
}

async function resolveSearchCandidates(query, requestedBy, options = {}) {
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));
  const allowYtdlpFallback = options.allowYtdlpFallback !== false;
  const normalizedQuery = normalizeInput(query);

  if (!normalizedQuery) {
    return [];
  }

  if (isUrl(normalizedQuery)) {
    throw new Error("Р”Р»СЏ РјРµРЅСЋ РІС‹Р±РѕСЂР° РЅСѓР¶РµРЅ С‚РµРєСЃС‚РѕРІС‹Р№ Р·Р°РїСЂРѕСЃ, Р° РЅРµ СЃСЃС‹Р»РєР°.");
  }

  const rawCandidates = [];
  const targetSearchSize = Math.max(SEARCH_RESULTS_LIMIT * 2, limit * SEARCH_CANDIDATE_POOL_MULTIPLIER);

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
  const apiResolvedTracks = await resolveCandidateVideosFromUrls(
    apiUrls,
    requestedBy,
    Math.min(targetSearchSize, API_RESOLVE_LIMIT),
    { allowYtdlpFallback }
  );

  for (const track of apiResolvedTracks) {
    if (!track?.url || seenUrls.has(track.url)) {
      continue;
    }

    uniqueCandidates.push(track);
    seenUrls.add(track.url);
  }

  if (allowYtdlpFallback && uniqueCandidates.length < limit) {
    const ytDlpCandidates = await searchYoutubeViaYtDlp(normalizedQuery, requestedBy, targetSearchSize);
    for (const track of ytDlpCandidates) {
      if (!track?.url || seenUrls.has(track.url)) {
        continue;
      }
      uniqueCandidates.push(track);
      seenUrls.add(track.url);
      if (uniqueCandidates.length >= targetSearchSize) {
        break;
      }
    }
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
    const directVideoId = extractYouTubeVideoId(url);
    if (directVideoId) {
      const [item] = await fetchYouTubeApiVideoItems([directVideoId]).catch(() => []);
      const track = toYouTubeTrackFromApiItem(item, requestedBy);
      if (track) {
        return {
          tracks: [track],
          kind: "youtube_video",
        };
      }
    }
  }

  const ytResolved = await resolveYoutubeUrlViaYtDlp(url, requestedBy);
  if (!ytResolved) {
    throw new Error("РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕР»СѓС‡РёС‚СЊ РјРµС‚Р°РґР°РЅРЅС‹Рµ YouTube С‡РµСЂРµР· yt-dlp.");
  }

  return ytResolved;
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
  const mapped = limitItems(tracks, MAX_PLAYLIST_ITEMS).map((track) => toSoundCloudTrack(track, requestedBy));

  return {
    tracks: mapped,
    kind: "soundcloud_playlist",
    title: sound.name || "SoundCloud playlist",
  };
}

async function resolveCandidateVideo(url, requestedBy) {
  const entry = await fetchYtDlpJson(url, {
    timeoutMs: 20_000,
    cookiesPath: YTDLP_COOKIES_PATH,
    flatPlaylist: false,
  });
  const track = toYouTubeTrackFromYtDlp(entry, requestedBy, url);
  if (!track?.url) {
    throw new Error("РџСѓСЃС‚РѕР№ РѕС‚РІРµС‚ РѕС‚ YouTube");
  }

  return track;
}

async function resolveFromSearch(query, requestedBy) {
  console.log(`[Resolve] РџРѕРёСЃРє РїРѕ С‚РµРєСЃС‚Сѓ: "${query}"`);

  const candidates = await resolveSearchCandidates(query, requestedBy, {
    limit: SEARCH_TRACK_PACK_SIZE,
  }).catch((error) => {
    console.error(`[Resolve] РћС€РёР±РєР° РїРѕРёСЃРєР° "${query}":`, error.message);
    return [];
  });

  const packedTrack = packSearchTracks(candidates, query);
  if (packedTrack) {
    console.log(`[Resolve] Р’С‹Р±СЂР°РЅ РєР°РЅРґРёРґР°С‚ РёР· РїРѕРёСЃРєР°: ${packedTrack.url}; Р·Р°РїР°СЃРЅС‹С…: ${packedTrack.fallbackTracks.length}`);
    return {
      tracks: [packedTrack],
      kind: "youtube_search",
    };
  }

  throw new Error("РќРµ СѓРґР°Р»РѕСЃСЊ РЅР°Р№С‚Рё С‚СЂРµРє РїРѕ Р·Р°РїСЂРѕСЃСѓ.");
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

      throw new Error(
        "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u043c\u0435\u0442\u0430\u0434\u0430\u043d\u043d\u044b\u0435 \u0438\u0437 \u0441\u0441\u044b\u043b\u043a\u0438 \u042f\u043d\u0434\u0435\u043a\u0441 \u041c\u0443\u0437\u044b\u043a\u0438 (\u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e, \u0432\u0440\u0435\u043c\u0435\u043d\u043d\u0430\u044f \u043a\u0430\u043f\u0447\u0430/\u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0435\u043d\u0438\u0435)."
      );
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

    let isVkMusicUrl = false;
    try {
      isVkMusicUrl = isVkMusicHost(new URL(input).hostname);
    } catch {
      isVkMusicUrl = false;
    }

    const vkResolved = await resolveVkUrl(input, requestedBy).catch((error) => {
      console.warn(`[Resolve] VK URL fallback (${input}): ${error.message}`);
      return null;
    });
    if (vkResolved) {
      return vkResolved;
    }

    if (isVkMusicUrl) {
      throw new Error(
        "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043e\u0442\u043a\u0440\u044b\u0442\u044c VK Music \u0441\u0441\u044b\u043b\u043a\u0443. \u0414\u043b\u044f VK \u0442\u0440\u0435\u043a\u043e\u0432/\u043f\u043b\u0435\u0439\u043b\u0438\u0441\u0442\u043e\u0432 \u043d\u0443\u0436\u0435\u043d \u0430\u043a\u0442\u0443\u0430\u043b\u044c\u043d\u044b\u0439 VK cookies \u0444\u0430\u0439\u043b (VK_COOKIES_PATH)."
      );
    }

    const externalResolved = await resolveGenericExternalUrl(input, requestedBy);
    if (externalResolved) {
      return externalResolved;
    }

    throw new Error(
      "\u0421\u0441\u044b\u043b\u043a\u0430 \u043d\u0435 \u043f\u043e\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044f \u0438\u043b\u0438 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430 \u0431\u0435\u0437 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u0438. \u0418\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0439 YouTube/SoundCloud/Spotify/Deezer \u043b\u0438\u0431\u043e \u043f\u0443\u0431\u043b\u0438\u0447\u043d\u0443\u044e \u0441\u0441\u044b\u043b\u043a\u0443."
    );
  }

  return resolveFromSearch(input, requestedBy);
}

module.exports = {
  resolveTracks,
  resolveSearchCandidates,
};


