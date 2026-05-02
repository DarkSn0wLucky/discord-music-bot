const http = require("http");
const https = require("https");
const dns = require("dns");
const os = require("os");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const play = require("play-dl");
const {
  MAX_PLAYLIST_ITEMS,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  L2TP_SOURCE_IP,
  YANDEX_COOKIES_PATH,
  VK_COOKIES_PATH,
  YANDEX_PLAYLIST_HINTS,
  YOUTUBE_API_KEY,
  YTDLP_BIN,
  YTDLP_COOKIES_PATH,
  YTDLP_EXTRACTOR_ARGS,
} = require("../config");
const { buildYtDlpEnv } = require("./ytdlpEnv");

const SEARCH_RESULTS_LIMIT = 8;
const SEARCH_TRACK_PACK_SIZE = 5;
const SEARCH_CANDIDATE_POOL_MULTIPLIER = 4;
const API_RESOLVE_LIMIT = 12;
const CANDIDATE_YTDLP_FALLBACK_CONCURRENCY = 2;
const EXTERNAL_FETCH_TIMEOUT_MS = 8_000;
const METADATA_RESOLVE_CONCURRENCY = 3;
const METADATA_RESOLVE_CONCURRENCY_FAST = 5;
const METADATA_ITEM_RESOLVE_TIMEOUT_MS = 12_000;
const METADATA_ITEM_RESOLVE_TIMEOUT_FAST_MS = 4_000;
const PLAYLIST_RESOLVE_BUDGET_MS = 90_000;
const PLAYLIST_FAST_MODE_THRESHOLD = 40;
const YANDEX_PLAYLIST_TOTAL_BUDGET_MS = 84_000;
const YANDEX_PLAYLIST_FETCH_BUDGET_MS = 24_000;
const YANDEX_PLAYLIST_FETCH_TIMEOUT_MAX_MS = 8_000;
const YANDEX_PLAYLIST_FETCH_TIMEOUT_MIN_MS = 2_500;
const VK_RELOAD_AUDIO_CHUNK_SIZE = 10;
const VK_RELOAD_AUDIO_RETRIES = 3;
const VK_RELOAD_AUDIO_RETRY_DELAY_MS = 700;
const VK_RELOAD_AUDIO_CHUNK_DELAY_MS = 250;
const VK_RELOAD_AUDIO_CACHE_TTL_MS = 15 * 60 * 1000;
const VK_HTML_RESOLVE_RETRIES = 2;
const VK_HTML_RESOLVE_RETRY_DELAY_MS = 2_000;
const NETWORK_CHECK_CACHE_TTL_MS = 5 * 60 * 1000;
const YANDEX_REGION_CHECK_CACHE_TTL_MS = 5 * 60 * 1000;
const COOKIES_FILE_CACHE_TTL_MS = 30 * 1000;
const HAS_SPOTIFY_AUTH = Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && SPOTIFY_REFRESH_TOKEN);
const ENABLE_L2TP_BIND = ["1", "true", "yes", "on", "enabled"].includes(
  String(process.env.ENABLE_L2TP_BIND || "").trim().toLowerCase()
);
const networkCheckCache = new Map();
const yandexRegionCheckCache = new Map();
const cookiesFileCache = new Map();
const vkReloadAudioEntryCache = new Map();
const yandexPlaylistHintMap = parseYandexPlaylistHints(YANDEX_PLAYLIST_HINTS);
let l2tpAddressChecked = false;
let l2tpAddressAvailable = false;

function hasLocalAddress(address) {
  const target = String(address || "").trim();
  if (!target) {
    return false;
  }

  const networkInterfaces = os.networkInterfaces();
  for (const entries of Object.values(networkInterfaces)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      if (String(entry?.address || "").trim() === target) {
        return true;
      }
    }
  }

  return false;
}

function canUseConfiguredL2tpAddress() {
  if (l2tpAddressChecked) {
    return l2tpAddressAvailable;
  }

  l2tpAddressChecked = true;
  l2tpAddressAvailable = hasLocalAddress(L2TP_SOURCE_IP);
  if (!l2tpAddressAvailable && String(L2TP_SOURCE_IP || "").trim()) {
    console.warn(
      `[Resolve] L2TP_SOURCE_IP=${String(L2TP_SOURCE_IP).trim()} не найден на локальных интерфейсах; fallback на обычный маршрут.`
    );
  }

  return l2tpAddressAvailable;
}

function isHomeL2tpEnabled() {
  return ENABLE_L2TP_BIND && Boolean(String(L2TP_SOURCE_IP || "").trim()) && canUseConfiguredL2tpAddress();
}

function shouldUseHomeL2tpForUrl(value) {
  if (!isHomeL2tpEnabled()) {
    return false;
  }

  try {
    const parsed = new URL(String(value || "").trim());
    return isYandexMusicHost(parsed.hostname) || isVkMusicHost(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeCookieDomain(rawDomain) {
  return String(rawDomain || "")
    .trim()
    .toLowerCase()
    .replace(/^#httponly_/i, "")
    .replace(/^\.+/, "");
}

function getCookiePathForUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    if (isYandexMusicHost(parsed.hostname)) {
      return resolveExistingFilePath(YANDEX_COOKIES_PATH) || null;
    }

    if (isVkMusicHost(parsed.hostname)) {
      return resolveExistingFilePath(VK_COOKIES_PATH) || null;
    }
  } catch {
    return null;
  }

  return null;
}

function parseNetscapeCookieLine(line) {
  const parts = String(line || "").split("\t");
  if (parts.length < 7) {
    return null;
  }

  const [domainRaw, includeSubdomainsRaw, pathRaw, secureRaw, _expiresRaw, nameRaw, ...valueParts] = parts;
  const name = String(nameRaw || "").trim();
  const value = String(valueParts.join("\t") || "").trim();
  const domain = normalizeCookieDomain(domainRaw);
  if (!domain || !name) {
    return null;
  }

  return {
    domain,
    includeSubdomains: String(includeSubdomainsRaw || "").trim().toUpperCase() === "TRUE",
    path: String(pathRaw || "/").trim() || "/",
    secure: String(secureRaw || "").trim().toUpperCase() === "TRUE",
    name,
    value,
  };
}

function parseCookieFileContent(rawContent) {
  const content = String(rawContent || "").trim();
  if (!content) {
    return [];
  }

  if (content.startsWith("[") || content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cookies) ? parsed.cookies : [];
      return entries
        .map((entry) => ({
          domain: normalizeCookieDomain(entry?.domain),
          includeSubdomains: String(entry?.hostOnly ?? "").toLowerCase() === "false",
          path: String(entry?.path || "/").trim() || "/",
          secure: Boolean(entry?.secure),
          name: String(entry?.name || "").trim(),
          value: String(entry?.value || "").trim(),
        }))
        .filter((entry) => entry.domain && entry.name);
    } catch {
      return [];
    }
  }

  return content
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter((line) => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")))
    .map(parseNetscapeCookieLine)
    .filter(Boolean);
}

function readCookiesFromFile(cookiesPath) {
  const absolutePath = resolveExistingFilePath(cookiesPath);
  if (!absolutePath) {
    return [];
  }

  const cached = cookiesFileCache.get(absolutePath);
  if (cached && Date.now() - cached.checkedAt <= COOKIES_FILE_CACHE_TTL_MS) {
    return cached.cookies;
  }

  try {
    const rawContent = fs.readFileSync(absolutePath, "utf8");
    const cookies = parseCookieFileContent(rawContent);
    cookiesFileCache.set(absolutePath, { cookies, checkedAt: Date.now() });
    return cookies;
  } catch {
    cookiesFileCache.set(absolutePath, { cookies: [], checkedAt: Date.now() });
    return [];
  }
}

function hostMatchesCookieDomain(hostname, domain, includeSubdomains) {
  const host = String(hostname || "").toLowerCase();
  const normalizedDomain = normalizeCookieDomain(domain);
  if (!host || !normalizedDomain) {
    return false;
  }

  if (host === normalizedDomain) {
    return true;
  }

  if (includeSubdomains && host.endsWith(`.${normalizedDomain}`)) {
    return true;
  }

  return false;
}

function buildCookieHeaderForUrl(url, explicitCookiesPath = "") {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    return "";
  }

  const cookiesPath = resolveExistingFilePath(explicitCookiesPath) || getCookiePathForUrl(parsed.toString());
  if (!cookiesPath) {
    return "";
  }

  const cookies = readCookiesFromFile(cookiesPath);
  if (!cookies.length) {
    return "";
  }

  const host = String(parsed.hostname || "").toLowerCase();
  const pathName = String(parsed.pathname || "/");
  const isHttps = parsed.protocol === "https:";
  const map = new Map();

  for (const cookie of cookies) {
    if (!hostMatchesCookieDomain(host, cookie.domain, cookie.includeSubdomains)) {
      continue;
    }

    const cookiePath = String(cookie.path || "/");
    if (!pathName.startsWith(cookiePath)) {
      continue;
    }

    if (cookie.secure && !isHttps) {
      continue;
    }

    map.set(cookie.name, cookie.value);
  }

  if (map.size === 0) {
    return "";
  }

  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function limitItems(list, limit) {
  const items = Array.isArray(list) ? list : [];
  if (!Number.isFinite(limit) || limit <= 0) {
    return items.slice();
  }
  return items.slice(0, Math.floor(limit));
}

function hasFinitePlaylistLimit() {
  return Number.isFinite(MAX_PLAYLIST_ITEMS) && MAX_PLAYLIST_ITEMS > 0;
}

function applyPlaylistLimit(items) {
  return hasFinitePlaylistLimit() ? limitItems(items, MAX_PLAYLIST_ITEMS) : (Array.isArray(items) ? items.slice() : []);
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function safeDecodeURIComponent(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeYandexTargetPart(value) {
  return safeDecodeURIComponent(value)
    .replace(/\+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseYandexOwnerKindPair(ownerRaw, kindRaw) {
  const owner = normalizeYandexTargetPart(ownerRaw);
  const kindRawValue = normalizeYandexTargetPart(kindRaw);
  const kind = kindRawValue.split(",")[0].trim();
  if (!owner || !kind) {
    return null;
  }

  return { owner, kind };
}

function isNumericIdentifier(value) {
  return /^\d+$/u.test(String(value || "").trim());
}

function isCanonicalYandexPlaylistTarget(target) {
  return Boolean(target && isNumericIdentifier(target.owner) && isNumericIdentifier(target.kind));
}

function parseJsonPayload(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return null;
  }

  const normalized = rawText.replace(/^\)\]\}'\s*/u, "");
  if (!normalized || (normalized[0] !== "{" && normalized[0] !== "[")) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function pickPreferredYandexPlaylistTarget(...targets) {
  const flattened = targets.flat().filter(Boolean);
  const canonical = flattened.find((target) => isCanonicalYandexPlaylistTarget(target));
  return canonical || flattened[0] || null;
}

function extractYandexPlaylistFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return (
    payload.playlist ||
    payload.result?.playlist ||
    payload.data?.playlist ||
    payload.pageData?.playlist ||
    (Array.isArray(payload.playlists) ? payload.playlists[0] : null) ||
    null
  );
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
    const eqIndex = entry.indexOf("=");
    if (eqIndex <= 0 || eqIndex >= entry.length - 1) {
      continue;
    }

    const uuidPart = normalizeYandexTargetPart(entry.slice(0, eqIndex));
    const targetPart = normalizeYandexTargetPart(entry.slice(eqIndex + 1));
    const targetSep = targetPart.indexOf(":");
    if (!uuidPart || targetSep <= 0 || targetSep >= targetPart.length - 1) {
      continue;
    }

    const target = parseYandexOwnerKindPair(targetPart.slice(0, targetSep), targetPart.slice(targetSep + 1));
    if (!target) {
      continue;
    }

    map.set(uuidPart.toLowerCase(), target);
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
    const queryTarget =
      parseYandexOwnerKindPair(
        parsed.searchParams.get("owner") ||
          parsed.searchParams.get("uid") ||
          parsed.searchParams.get("playlistOwner"),
        parsed.searchParams.get("kinds") ||
          parsed.searchParams.get("kind") ||
          parsed.searchParams.get("playlistKind")
      ) || null;

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
      const userTarget =
        parseYandexOwnerKindPair(userPlaylist[1] || "", userPlaylist[2] || "") || queryTarget;
      return {
        origin: parsed.origin,
        albumId: "",
        trackId: "",
        playlistOwner: userTarget?.owner || "",
        playlistKind: userTarget?.kind || "",
        playlistUuid: "",
      };
    }

    const directPlaylist = pathName.match(/\/playlists\/([^/?#]+)/i);
    if (directPlaylist) {
      return {
        origin: parsed.origin,
        albumId: "",
        trackId: "",
        playlistOwner: queryTarget?.owner || "",
        playlistKind: queryTarget?.kind || "",
        playlistUuid: normalizeYandexTargetPart(directPlaylist[1] || ""),
      };
    }

    return {
      origin: parsed.origin,
      albumId: "",
      trackId: "",
      playlistOwner: queryTarget?.owner || "",
      playlistKind: queryTarget?.kind || "",
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
    .filter((artist) => {
      const name = String(artist?.name || artist || "").trim().toLowerCase();
      return !artist?.various && name !== "сборник" && name !== "various" && name !== "various artists";
    })
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

function toMeaningfulTokens(value) {
  return [...new Set(
    normalizeText(value)
      .split(" ")
      .filter((token) => token.length > 1 && !QUERY_STOPWORDS.has(token))
  )];
}

function tokenCoverageRatio(sourceTokens, targetTokens) {
  const normalizedSource = Array.isArray(sourceTokens) ? sourceTokens.filter(Boolean) : [];
  const normalizedTarget = Array.isArray(targetTokens) ? targetTokens.filter(Boolean) : [];

  if (normalizedSource.length === 0) {
    return 1;
  }
  if (normalizedTarget.length === 0) {
    return 0;
  }

  let matchedCount = 0;
  for (const sourceToken of normalizedSource) {
    const matched = normalizedTarget.some((targetToken) => tokenMatches(sourceToken, targetToken));
    if (matched) {
      matchedCount += 1;
    }
  }

  return matchedCount / normalizedSource.length;
}

function metadataDurationMs(item) {
  const durationMsRaw = Number(item?.durationMs);
  if (Number.isFinite(durationMsRaw) && durationMsRaw > 0) {
    return Math.round(durationMsRaw);
  }

  const durationSecRaw = Number(item?.durationSec);
  if (Number.isFinite(durationSecRaw) && durationSecRaw > 0) {
    return Math.round(durationSecRaw * 1000);
  }

  return 0;
}

function isDurationComparable(metadataItem, candidateTrack) {
  const metadataMs = metadataDurationMs(metadataItem);
  const candidateMs = metadataDurationMs(candidateTrack);

  if (metadataMs <= 0 || candidateMs <= 0) {
    return true;
  }

  const diffSec = Math.abs(metadataMs - candidateMs) / 1000;
  const metadataSec = metadataMs / 1000;
  const toleranceSec = Math.min(35, Math.max(10, Math.round(metadataSec * 0.08)));
  return diffSec <= toleranceSec;
}

function isStrictMetadataMatch(candidate, metadataItem, primaryQuery = "") {
  if (!candidate) {
    return false;
  }

  const normalizedItem = normalizeMetadataItem(metadataItem);
  if (!normalizedItem?.title) {
    return false;
  }

  const candidateTitleTokens = toMeaningfulTokens(candidate.title);
  const candidateAuthorTokens = toMeaningfulTokens(candidate.author);
  const candidateAllTokens = [...new Set([...candidateAuthorTokens, ...candidateTitleTokens])];

  if (primaryQuery) {
    const queryTokens = toMeaningfulTokens(primaryQuery);
    if (queryTokens.length > 0) {
      const queryCoverage = tokenCoverageRatio(queryTokens, candidateAllTokens);
      if (queryCoverage < strictCoverageThreshold(queryTokens.length)) {
        return false;
      }
    }
  }

  const titleTokens = toMeaningfulTokens(normalizedItem.title);
  if (titleTokens.length > 0) {
    const titleCoverage = tokenCoverageRatio(
      titleTokens,
      candidateTitleTokens.length > 0 ? candidateTitleTokens : candidateAllTokens
    );
    const titleThreshold = titleTokens.length <= 1 ? 1 : titleTokens.length === 2 ? 0.75 : 0.7;
    if (titleCoverage < titleThreshold) {
      return false;
    }
  }

  const artistTokens = toMeaningfulTokens(normalizedItem.artist);
  if (artistTokens.length > 0) {
    const artistCoverage = tokenCoverageRatio(artistTokens, candidateAllTokens);
    const allArtistTokensShort = artistTokens.every((token) => token.length <= 3);
    const artistThreshold = artistTokens.length === 1
      ? (artistTokens[0]?.length <= 3 ? 0.4 : 0.8)
      : (allArtistTokensShort ? 0.4 : 0.6);
    if (artistCoverage < artistThreshold) {
      return false;
    }
  }

  return isDurationComparable(metadataItem, candidate);
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

  const queue = unresolvedUrls.slice();
  const workerCount = Math.max(1, Math.min(CANDIDATE_YTDLP_FALLBACK_CONCURRENCY, queue.length));

  async function fallbackWorker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) {
        continue;
      }

      try {
        const track = await resolveCandidateVideo(url, requestedBy);
        if (track?.url && !resolvedUrls.has(track.url)) {
          resolved.push(track);
          resolvedUrls.add(track.url);
        }
      } catch (error) {
        console.warn(`[Resolve] API-кандидат пропущен: ${url} | ${error?.message || "Unknown error"}`);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => fallbackWorker()));

  return resolved;
}

async function resolveTrackByMetadataQuery(query, requestedBy, options = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return null;
  }

  const allowYtdlpFallback = options.allowYtdlpFallback !== false;
  const accept = typeof options.accept === "function" ? options.accept : () => true;
  const candidates = await resolveSearchCandidates(normalizedQuery, requestedBy, {
    limit: SEARCH_TRACK_PACK_SIZE,
    allowYtdlpFallback,
  }).catch(() => []);

  const acceptedCandidates = candidates.filter((candidate) => {
    try {
      return accept(candidate, normalizedQuery);
    } catch {
      return false;
    }
  });

  const packed = packSearchTracks(acceptedCandidates, normalizedQuery);
  if (!packed) {
    return null;
  }

  return packed;
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
  const durationMsRaw = Number(item?.durationMs);
  const durationSecRaw = Number(item?.durationSec);
  const durationMs = Number.isFinite(durationMsRaw) && durationMsRaw > 0
    ? Math.round(durationMsRaw)
    : Number.isFinite(durationSecRaw) && durationSecRaw > 0
      ? Math.round(durationSecRaw * 1000)
      : 0;
  const durationSec = durationMs > 0 ? Math.round(durationMs / 1000) : 0;

  const displayTitle = artist ? `${artist} - ${title}` : title;

  return {
    title: displayTitle || title || "Без названия",
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    playbackUrl: `ytsearch1:${query}`,
    source: "YouTube",
    author: artist || "YouTube",
    views: 0,
    durationSec,
    durationMs,
    thumbnail: null,
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
    searchQuery: query,
    fallbackTracks: [],
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeCatalogId(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const match = text.match(/\d+/u);
  return match?.[0] || "";
}

function yandexCoverUrl(track) {
  const value = firstNonEmpty(track?.coverUri, track?.ogImage, track?.cover?.uri);
  if (!value) {
    return null;
  }

  if (/^https?:\/\//iu.test(value)) {
    return value.replace("%%", "200x200");
  }

  return `https://${value.replace(/^\/+/, "").replace("%%", "200x200")}`;
}

function getYandexAlbumId(track, fallbackInfo = {}) {
  const albums = Array.isArray(track?.albums) ? track.albums : [];
  const firstAlbum = albums[0] || {};
  return normalizeCatalogId(
    firstNonEmpty(
      firstAlbum.id,
      firstAlbum.albumId,
      track?.albumId,
      track?.album?.id,
      fallbackInfo.albumId
    )
  );
}

function getYandexTrackId(track) {
  return normalizeCatalogId(firstNonEmpty(track?.id, track?.realId, track?.trackId));
}

function buildYandexTrackUrl(origin, track, fallbackInfo = {}) {
  const trackId = getYandexTrackId(track);
  if (!trackId) {
    return "";
  }

  const albumId = getYandexAlbumId(track, fallbackInfo);
  const baseOrigin = (() => {
    try {
      const parsed = new URL(String(origin || ""));
      return isYandexMusicHost(parsed.hostname) ? parsed.origin : "https://music.yandex.ru";
    } catch {
      return "https://music.yandex.ru";
    }
  })();

  const pathName = albumId ? `/album/${albumId}/track/${trackId}` : `/track/${trackId}`;
  return new URL(pathName, baseOrigin).toString();
}

function toYandexCatalogTrack(rawItem, requestedBy, origin, fallbackInfo = {}) {
  const track = rawItem?.track || rawItem || {};
  const title = normalizeMetadataPiece(track?.title || track?.name || "");
  if (!title) {
    return null;
  }

  const artist = joinArtists(track?.artists);
  const url = buildYandexTrackUrl(origin, track, fallbackInfo);
  if (!url) {
    return null;
  }

  const durationMs = Number(track?.durationMs) || 0;
  const durationSec = durationMs > 0 ? Math.round(durationMs / 1000) : Number(track?.duration) || 0;
  const metadata = {
    title,
    artist,
    durationMs: durationMs > 0 ? durationMs : durationSec > 0 ? durationSec * 1000 : 0,
    durationSec,
  };
  const fallbackTrack = buildMetadataFallbackTrack(metadata, requestedBy);
  const searchQuery = buildQueryFromArtistTitle(artist, title) || title;
  const playbackUrl = fallbackTrack?.playbackUrl || url;

  return {
    title: artist ? `${artist} - ${title}` : title,
    url,
    playbackUrl,
    source: "Yandex Music",
    author: artist || "Yandex Music",
    views: 0,
    durationSec,
    durationMs: metadata.durationMs,
    thumbnail: yandexCoverUrl(track),
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
    searchQuery,
    fallbackTracks: fallbackTrack ? [fallbackTrack] : [],
    catalogSource: "yandex",
  };
}

function toYandexCatalogTracks(rawItems, requestedBy, origin, fallbackInfo = {}) {
  return limitItems(rawItems, MAX_PLAYLIST_ITEMS)
    .map((item) => {
      const directTrack = toYandexCatalogTrack(item, requestedBy, origin, fallbackInfo);
      if (directTrack) {
        return directTrack;
      }

      const rawTrack = item?.track || item || {};
      const durationMs = Number(rawTrack?.durationMs) || 0;
      return buildMetadataFallbackTrack(
        {
          title: rawTrack?.title || rawTrack?.name || "",
          artist: joinArtists(rawTrack?.artists),
          durationMs: durationMs > 0 ? durationMs : 0,
          durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : Number(rawTrack?.duration) || 0,
        },
        requestedBy
      );
    })
    .filter((track) => track?.url);
}

async function resolveTracksFromMetadataItems(items, requestedBy, options = {}) {
  const sourceItems = limitItems(items, MAX_PLAYLIST_ITEMS);
  if (!sourceItems.length) {
    return options.returnDetailed === true
      ? { tracksByIndex: [], matchedCount: 0, missedIndices: [], timedOutCount: 0 }
      : [];
  }

  const allowSyntheticFallback = options.allowSyntheticFallback === true;
  const strictMatch = options.strictMatch !== false;
  const allowYtdlpFallback = options.allowYtdlpFallback !== false;
  const disableSecondaryMetadataLookup = options.disableSecondaryMetadataLookup === true;
  const resolveBudgetMsRaw = Number(options.resolveBudgetMs);
  const resolveBudgetMs =
    Number.isFinite(resolveBudgetMsRaw) && resolveBudgetMsRaw > 0
      ? Math.round(resolveBudgetMsRaw)
      : PLAYLIST_RESOLVE_BUDGET_MS;
  const itemResolveTimeoutMsRaw = Number(options.itemResolveTimeoutMs);
  const maxConcurrencyRaw = Number(options.maxConcurrency);
  const queryLimitRaw = Number(options.queryLimit);
  const startedAt = Date.now();
  const fastMode = sourceItems.length >= PLAYLIST_FAST_MODE_THRESHOLD;
  const itemResolveTimeoutMs =
    Number.isFinite(itemResolveTimeoutMsRaw) && itemResolveTimeoutMsRaw > 0
      ? Math.round(itemResolveTimeoutMsRaw)
      : fastMode
        ? METADATA_ITEM_RESOLVE_TIMEOUT_FAST_MS
        : METADATA_ITEM_RESOLVE_TIMEOUT_MS;
  const results = new Array(sourceItems.length).fill(null);
  const querySettledCache = new Map();
  const queryInflight = new Map();
  const cacheKeyByIndex = new Array(sourceItems.length).fill("");
  const returnDetailed = options.returnDetailed === true;
  let timedOutCount = 0;
  let cursor = 0;
  const maxConcurrency = Number.isFinite(maxConcurrencyRaw) && maxConcurrencyRaw > 0
    ? Math.round(maxConcurrencyRaw)
    : fastMode
      ? METADATA_RESOLVE_CONCURRENCY_FAST
      : METADATA_RESOLVE_CONCURRENCY;
  const queryLimit = Number.isFinite(queryLimitRaw) && queryLimitRaw > 0
    ? Math.round(queryLimitRaw)
    : Number.POSITIVE_INFINITY;
  const workerCount = Math.max(
    1,
    Math.min(maxConcurrency, sourceItems.length)
  );

  async function worker() {
    while (true) {
      if (Date.now() - startedAt >= resolveBudgetMs) {
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

      const queries = buildMetadataQueries(normalizedItem).slice(0, queryLimit);
      if (!queries.length) {
        const fallbackTrack = allowSyntheticFallback ? buildMetadataFallbackTrack(item, requestedBy) : null;
        if (fallbackTrack) {
          results[index] = fallbackTrack;
        }
        continue;
      }

      const primaryQuery = queries[0];
      const normalizedTitleOnlyQuery = normalizeText(normalizedItem.title || "");
      const acceptCandidate = (candidate, candidateQuery = primaryQuery) => {
        if (!strictMatch) {
          return true;
        }

        const effectiveQuery = String(candidateQuery || primaryQuery || "").trim();
        const normalizedEffectiveQuery = normalizeText(effectiveQuery);
        const isTitleLedQuery =
          Boolean(normalizedTitleOnlyQuery) &&
          (normalizedEffectiveQuery === normalizedTitleOnlyQuery ||
            normalizedEffectiveQuery.startsWith(`${normalizedTitleOnlyQuery} `) ||
            normalizedEffectiveQuery.endsWith(` ${normalizedTitleOnlyQuery}`));

        const itemForCheck = isTitleLedQuery
          ? { ...normalizedItem, artist: "" }
          : normalizedItem;
        return isStrictMetadataMatch(candidate, itemForCheck, effectiveQuery || primaryQuery);
      };
      const cacheKey = queries.join("||");
      cacheKeyByIndex[index] = cacheKey;
      if (querySettledCache.has(cacheKey)) {
        const cachedTrack = querySettledCache.get(cacheKey);
        if (cachedTrack) {
          results[index] = cachedTrack;
        } else if (allowSyntheticFallback) {
          const fallbackTrack = buildMetadataFallbackTrack(item, requestedBy, primaryQuery);
          if (fallbackTrack) {
            results[index] = fallbackTrack;
          }
        }
        continue;
      }

      let resolvePromise = queryInflight.get(cacheKey);
      if (!resolvePromise) {
        resolvePromise = (async () => {
          return (
            (await resolveTrackByQueryVariants(queries, requestedBy, {
              allowYtdlpFallback,
              accept: acceptCandidate,
            }).catch(() => null)) ||
            (disableSecondaryMetadataLookup
              ? null
              : await resolveTrackByMetadataQuery(primaryQuery, requestedBy, {
                  allowYtdlpFallback,
                  accept: acceptCandidate,
                }).catch(() => null))
          );
        })()
          .then((track) => {
            const normalizedTrack = track || null;
            querySettledCache.set(cacheKey, normalizedTrack);
            return normalizedTrack;
          })
          .catch(() => {
            querySettledCache.set(cacheKey, null);
            return null;
          })
          .finally(() => {
            queryInflight.delete(cacheKey);
          });
        queryInflight.set(cacheKey, resolvePromise);
      }

      const timedOutMarker = Symbol("metadata_timeout");
      const resolvedOrTimeout = await Promise.race([
        resolvePromise,
        new Promise((resolve) =>
          setTimeout(
            () => resolve(timedOutMarker),
            itemResolveTimeoutMs
          )
        ),
      ]);
      const resolvedTrack = resolvedOrTimeout === timedOutMarker ? null : resolvedOrTimeout;
      if (resolvedOrTimeout === timedOutMarker) {
        timedOutCount += 1;
      }

      if (resolvedTrack) {
        results[index] = resolvedTrack;
      } else {
        const settledTrack = querySettledCache.get(cacheKey);
        if (settledTrack) {
          results[index] = settledTrack;
          continue;
        }

        const fallbackTrack = allowSyntheticFallback
          ? buildMetadataFallbackTrack(item, requestedBy, primaryQuery)
          : null;
        if (fallbackTrack) {
          results[index] = fallbackTrack;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (queryInflight.size > 0) {
    await Promise.allSettled([...queryInflight.values()]);
  }

  for (let index = 0; index < sourceItems.length; index += 1) {
    if (results[index]) {
      continue;
    }

    const cacheKey = cacheKeyByIndex[index];
    if (!cacheKey) {
      continue;
    }

    const settledTrack = querySettledCache.get(cacheKey);
    if (settledTrack) {
      results[index] = settledTrack;
    }
  }

  if (allowSyntheticFallback) {
    for (let index = 0; index < sourceItems.length; index += 1) {
      if (results[index]) {
        continue;
      }

      const fallbackTrack = buildMetadataFallbackTrack(sourceItems[index], requestedBy);
      if (fallbackTrack) {
        results[index] = fallbackTrack;
      }
    }
  }

  if (returnDetailed) {
    const matchedCount = results.filter(Boolean).length;
    const missedIndices = [];
    for (let index = 0; index < results.length; index += 1) {
      if (!results[index]) {
        missedIndices.push(index);
      }
    }

    return {
      tracksByIndex: results,
      matchedCount,
      missedIndices,
      timedOutCount,
    };
  }

  return limitItems(results.filter(Boolean), MAX_PLAYLIST_ITEMS);
}

async function requestTextWithRedirect(url, options = {}, redirectCount = 0) {
  const maxRedirects = 4;
  const timeoutMs = Number(options.timeoutMs) || EXTERNAL_FETCH_TIMEOUT_MS;
  const headers = options.headers || {};
  const method = String(options.method || "GET").trim().toUpperCase() || "GET";
  const body = options.body === undefined || options.body === null ? null : Buffer.from(String(options.body));

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    throw error;
  }

  if (await isBlockedNetworkTarget(parsedUrl.toString())) {
    throw new Error("Blocked target URL");
  }

  const preferredLocalAddress = String(options.localAddress || "").trim();
  const autoLocalAddress = shouldUseHomeL2tpForUrl(parsedUrl.toString()) ? String(L2TP_SOURCE_IP || "").trim() : "";
  const localAddress = preferredLocalAddress || autoLocalAddress;

  const runRequest = (forcedLocalAddress = "") =>
    new Promise((resolve, reject) => {
      const client = parsedUrl.protocol === "http:" ? http : https;
      const cookieHeader = buildCookieHeaderForUrl(parsedUrl.toString(), options.cookiesPath || "");
      const normalizedHeaders = { ...headers };
      if (cookieHeader && !normalizedHeaders.cookie && !normalizedHeaders.Cookie) {
        normalizedHeaders.cookie = cookieHeader;
      }
      const requestOptions = {
        method,
        headers: normalizedHeaders,
      };

      if (body && !normalizedHeaders["content-length"] && !normalizedHeaders["Content-Length"]) {
        normalizedHeaders["content-length"] = String(body.length);
      }

      if (forcedLocalAddress) {
        requestOptions.localAddress = forcedLocalAddress;
      }

      const req = client.request(parsedUrl, requestOptions, (res) => {
        const statusCode = Number(res.statusCode) || 0;
        const location = String(res.headers.location || "");
        if (location && statusCode >= 300 && statusCode < 400 && redirectCount < maxRedirects) {
          const nextUrl = new URL(location, parsedUrl).toString();
          res.resume();
          requestTextWithRedirect(
            nextUrl,
            {
              ...options,
              localAddress: forcedLocalAddress || options.localAddress || "",
            },
            redirectCount + 1
          )
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
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("Request timeout"));
      });
      req.on("error", reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });

  if (!localAddress) {
    return runRequest("");
  }

  try {
    return await runRequest(localAddress);
  } catch (error) {
    const code = String(error?.code || "").toUpperCase();
    const shouldFallback = code === "EADDRNOTAVAIL" || code === "ENETUNREACH" || code === "EHOSTUNREACH";
    if (!shouldFallback) {
      throw error;
    }
    return runRequest("");
  }
}

function fetchJsonViaCurl(url, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(options.timeoutMs) || EXTERNAL_FETCH_TIMEOUT_MS;
    const maxTimeSec = Math.max(4, Math.ceil(timeoutMs / 1000));
    const maxBuffer = Number(options.maxBuffer) > 0 ? Number(options.maxBuffer) : 20 * 1024 * 1024;
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
    ];

    if (shouldUseHomeL2tpForUrl(url) && isHomeL2tpEnabled()) {
      args.push("--interface", String(L2TP_SOURCE_IP).trim());
    }

    const cookiePath = resolveExistingFilePath(options.cookiesPath) || getCookiePathForUrl(url);
    if (cookiePath) {
      args.push("--cookie", cookiePath);
    }

    args.push(String(url));

    execFile(
      "curl",
      args,
      {
        timeout: timeoutMs + 2_000,
        windowsHide: true,
        maxBuffer,
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

function requestTextViaCurl(url, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(options.timeoutMs) || EXTERNAL_FETCH_TIMEOUT_MS;
    const maxTimeSec = Math.max(4, Math.ceil(timeoutMs / 1000));
    const args = [
      "-sS",
      "-L",
      "--max-time",
      String(maxTimeSec),
      "-A",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      "-H",
      "accept: text/html,application/xhtml+xml",
      "-H",
      "accept-language: ru,en-US;q=0.9,en;q=0.8",
      "-H",
      "referer: https://music.yandex.ru/",
      "--write-out",
      "\n__CURL_META__%{http_code}|%{url_effective}",
    ];

    if (shouldUseHomeL2tpForUrl(url) && isHomeL2tpEnabled()) {
      args.push("--interface", String(L2TP_SOURCE_IP).trim());
    }

    const cookiePath = resolveExistingFilePath(options.cookiesPath) || getCookiePathForUrl(url);
    if (cookiePath) {
      args.push("--cookie", cookiePath);
    }

    args.push(String(url));

    execFile(
      "curl",
      args,
      {
        timeout: timeoutMs + 2_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null);
          return;
        }

        const output = String(stdout);
        const markerIndex = output.lastIndexOf("\n__CURL_META__");
        if (markerIndex < 0) {
          resolve(null);
          return;
        }

        const body = output.slice(0, markerIndex);
        const metaRaw = output.slice(markerIndex + "\n__CURL_META__".length).trim();
        const [statusRaw, finalUrlRaw] = metaRaw.split("|");
        const statusCode = Number(statusRaw) || 0;
        const finalUrl = String(finalUrlRaw || "").trim() || String(url);

        resolve({
          statusCode,
          body,
          finalUrl,
          headers: {},
        });
      }
    );
  });
}

async function fetchJsonWithTimeout(url) {
  try {
    const cookiePath = getCookiePathForUrl(url);
    const cookieHeader = buildCookieHeaderForUrl(url, cookiePath || "");

    const curlJson = await fetchJsonViaCurl(url, {
      cookiesPath: cookiePath || "",
    });
    if (curlJson) {
      return curlJson;
    }

    const response = await requestTextWithRedirect(url, {
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
      cookiesPath: cookiePath || "",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        accept: "application/json,text/plain,*/*",
        "accept-language": "ru,en-US;q=0.9,en;q=0.8",
        referer: "https://music.yandex.ru/",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
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

function parseYandexPlaylistTargetFromHtml(html, expectedUuid = "") {
  const source = String(html || "");
  if (!source) {
    return null;
  }

  const uuid = String(expectedUuid || "").trim();
  if (uuid) {
    const escapedUuid = escapeRegExp(uuid);
    const uuidPatterns = [
      new RegExp(
        `"uuid"\\s*:\\s*"${escapedUuid}"[\\s\\S]{0,5000}?"uid"\\s*:\\s*"?(\\d+)"?[\\s\\S]{0,1200}?"kind"\\s*:\\s*"?(\\d+)"?`,
        "i"
      ),
      new RegExp(
        `"uid"\\s*:\\s*"?(\\d+)"?[\\s\\S]{0,1200}?"kind"\\s*:\\s*"?(\\d+)"?[\\s\\S]{0,5000}?"uuid"\\s*:\\s*"${escapedUuid}"`,
        "i"
      ),
    ];

    for (const pattern of uuidPatterns) {
      const match = source.match(pattern);
      if (match?.[1] && match?.[2]) {
        return parseYandexOwnerKindPair(match[1], match[2]);
      }
    }

    return null;
  }

  const directMatch = source.match(/"uid"\s*:\s*"?(\d+)"?\s*,\s*"kind"\s*:\s*"?(\d+)"?\s*,\s*"title"\s*:/i);
  if (directMatch) {
    return parseYandexOwnerKindPair(directMatch[1], directMatch[2]);
  }

  const reverseMatch = source.match(/"kind"\s*:\s*"?(\d+)"?\s*,[\s\S]{0,1600}?"uid"\s*:\s*"?(\d+)"?/i);
  if (reverseMatch) {
    return parseYandexOwnerKindPair(reverseMatch[2], reverseMatch[1]);
  }

  const metaMatch = source.match(
    /"meta"\s*:\s*\{[\s\S]{0,1600}?"uid"\s*:\s*"?(\d+)"?\s*,\s*"kind"\s*:\s*"?(\d+)"?[\s\S]{0,1600}?\}/i
  );
  if (metaMatch) {
    return parseYandexOwnerKindPair(metaMatch[1], metaMatch[2]);
  }

  const ownerBlockMatch = source.match(
    /"owner"\s*:\s*\{[\s\S]{0,500}?"uid"\s*:\s*"?(\d+)"?[\s\S]{0,500}?\}[\s\S]{0,600}?"kind"\s*:\s*"?(\d+)"?/i
  );
  if (ownerBlockMatch) {
    return parseYandexOwnerKindPair(ownerBlockMatch[1], ownerBlockMatch[2]);
  }

  const playlistBlockMatch = source.match(
    /"playlist"\s*:\s*\{[\s\S]{0,1200}?"kind"\s*:\s*"?(\d+)"?[\s\S]{0,1200}?"uid"\s*:\s*"?(\d+)"?[\s\S]{0,1200}?\}/i
  );
  if (playlistBlockMatch) {
    return parseYandexOwnerKindPair(playlistBlockMatch[2], playlistBlockMatch[1]);
  }

  return null;
}

function isYandexRegionBlockedHtml(html) {
  const source = String(html || "").toLowerCase();
  if (!source) {
    return false;
  }

  return (
    source.includes("яндекс музыка") &&
    source.includes("недоступна в вашем регионе")
  );
}

function isYandexCaptchaHtml(html) {
  const source = String(html || "").toLowerCase();
  if (!source) {
    return false;
  }

  return (
    source.includes("showcaptcha") ||
    source.includes("form-fb-hint") ||
    source.includes("проверка, что запросы отправляет человек") ||
    source.includes("подтвердите, что вы не робот") ||
    source.includes("captcha")
  );
}

function isYandexBlockedResponse(response) {
  const finalUrl = String(response?.finalUrl || response?.url || "").toLowerCase();
  const body = String(response?.body || "");
  return (
    finalUrl.includes("/showcaptcha") ||
    isYandexRegionBlockedHtml(body) ||
    isYandexCaptchaHtml(body)
  );
}

async function isYandexPlaylistRegionBlocked(info, originalUrl) {
  const uuidKey = String(info?.playlistUuid || "").toLowerCase();
  const cacheKey = uuidKey || String(originalUrl || "").trim().toLowerCase();
  if (!cacheKey) {
    return false;
  }

  const cached = yandexRegionCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt <= YANDEX_REGION_CHECK_CACHE_TTL_MS) {
    return cached.blocked;
  }

  const response =
    (await requestTextViaCurl(originalUrl, {
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
      cookiesPath: YANDEX_COOKIES_PATH,
    }).catch(() => null)) ||
    (await requestTextWithRedirect(originalUrl, {
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
      cookiesPath: YANDEX_COOKIES_PATH,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ru,en-US;q=0.9,en;q=0.8",
        referer: "https://music.yandex.ru/",
      },
    }).catch(() => null));

  const blocked = Boolean(response && response.statusCode >= 200 && response.statusCode < 300 && isYandexBlockedResponse(response));
  yandexRegionCheckCache.set(cacheKey, { blocked, checkedAt: Date.now() });
  return blocked;
}

async function resolveYandexPlaylistTarget(info, originalUrl) {
  const directTarget = parseYandexOwnerKindPair(info?.playlistOwner, info?.playlistKind);
  if (directTarget?.owner && directTarget?.kind && !String(info?.playlistUuid || "").trim()) {
    return directTarget;
  }

  if (isCanonicalYandexPlaylistTarget(directTarget)) {
    return directTarget;
  }

  const hintRaw = yandexPlaylistHintMap.get(String(info?.playlistUuid || "").toLowerCase());
  const hintTarget = parseYandexOwnerKindPair(hintRaw?.owner, hintRaw?.kind);
  if (isCanonicalYandexPlaylistTarget(hintTarget)) {
    return hintTarget;
  }

  const shouldProbeHtml = Boolean(originalUrl && (info?.playlistUuid || directTarget || hintTarget));
  if (!shouldProbeHtml) {
    return pickPreferredYandexPlaylistTarget(hintTarget, directTarget);
  }

  const response =
    (await requestTextViaCurl(originalUrl, {
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
      cookiesPath: YANDEX_COOKIES_PATH,
    }).catch(() => null)) ||
    (await requestTextWithRedirect(originalUrl, {
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
      cookiesPath: YANDEX_COOKIES_PATH,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ru,en-US;q=0.9,en;q=0.8",
        referer: "https://music.yandex.ru/",
      },
    }).catch(() => null));

  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    return pickPreferredYandexPlaylistTarget(hintTarget, directTarget);
  }

  if (isYandexBlockedResponse(response)) {
    const fallbackTarget = pickPreferredYandexPlaylistTarget(hintTarget, directTarget);
    if (fallbackTarget?.owner && fallbackTarget?.kind) {
      return fallbackTarget;
    }
    return { blocked: true };
  }

  const finalTarget = (() => {
    try {
      const parsedFinal = parseYandexUrlInfo(response.finalUrl || "");
      return parseYandexOwnerKindPair(parsedFinal?.playlistOwner, parsedFinal?.playlistKind);
    } catch {
      return null;
    }
  })();

  const resolvedTarget = parseYandexPlaylistTargetFromHtml(response.body, info?.playlistUuid || "");
  const preferredTarget = pickPreferredYandexPlaylistTarget(resolvedTarget, finalTarget, hintTarget, directTarget);
  if (preferredTarget?.owner && preferredTarget?.kind && info.playlistUuid) {
    yandexPlaylistHintMap.set(String(info.playlistUuid).toLowerCase(), {
      owner: String(preferredTarget.owner),
      kind: String(preferredTarget.kind),
    });
  }

  return preferredTarget;
}

async function fetchYandexJsonWithBlockCheck(url, options = {}) {
  const timeoutMsRaw = Number(options.timeoutMs);
  const yandexTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.round(timeoutMsRaw) : 20_000;
  const yandexMaxBuffer = 20 * 1024 * 1024;
  const cookiePath = getCookiePathForUrl(url);
  const cookieHeader = buildCookieHeaderForUrl(url, cookiePath || "");

  const curlJson = await fetchJsonViaCurl(url, {
    cookiesPath: cookiePath || "",
    timeoutMs: yandexTimeoutMs,
    maxBuffer: yandexMaxBuffer,
  }).catch(() => null);
  if (curlJson) {
    return { blocked: false, data: curlJson };
  }

  const response = await requestTextWithRedirect(url, {
    timeoutMs: yandexTimeoutMs,
    cookiesPath: cookiePath || "",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      accept: "application/json,text/plain,*/*",
      "accept-language": "ru,en-US;q=0.9,en;q=0.8",
      referer: "https://music.yandex.ru/",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  }).catch(() => null);

  if (!response) {
    return { blocked: false, data: null };
  }

  if (isYandexBlockedResponse(response)) {
    return { blocked: true, data: null };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { blocked: false, data: null };
  }

  return {
    blocked: false,
    data: parseJsonPayload(response.body),
  };
}

function buildYandexAntiBotError(hasYandexCookies) {
  return hasYandexCookies
    ? new Error("Яндекс Музыка вернула антибот/капчу. Обнови YANDEX cookies и повтори.")
    : new Error("Яндекс Музыка вернула антибот/капчу. Нужен YANDEX_COOKIES_PATH (cookies из браузера music.yandex.ru).");
}

async function fetchYandexPlaylistData(origin, owner, kind, options = {}) {
  const canonicalOrigin = "https://music.yandex.ru";
  const normalizedOrigin = String(origin || "").trim();
  const candidateOrigins = [canonicalOrigin];
  if (normalizedOrigin && normalizedOrigin.toLowerCase() !== canonicalOrigin) {
    candidateOrigins.push(normalizedOrigin);
  }
  const maxBudgetMsRaw = Number(options.maxBudgetMs);
  const maxBudgetMs =
    Number.isFinite(maxBudgetMsRaw) && maxBudgetMsRaw > 0
      ? Math.round(maxBudgetMsRaw)
      : YANDEX_PLAYLIST_FETCH_BUDGET_MS;
  const startedAt = Date.now();

  const requestVariants = [
    { overembed: "false", lang: "ru" },
    { overembed: "false" },
    { lang: "ru" },
    {},
  ];

  const attemptedUrls = new Set();
  let blockedAttempts = 0;
  let nonBlockedAttempts = 0;
  for (const currentOrigin of candidateOrigins) {
    for (const variant of requestVariants) {
      const playlistUrl = new URL("/handlers/playlist.jsx", currentOrigin);
      playlistUrl.searchParams.set("owner", String(owner));
      playlistUrl.searchParams.set("kinds", String(kind));
      Object.entries(variant).forEach(([key, value]) => {
        playlistUrl.searchParams.set(key, String(value));
      });

      const url = playlistUrl.toString();
      if (attemptedUrls.has(url)) {
        continue;
      }
      attemptedUrls.add(url);

      const elapsedMs = Date.now() - startedAt;
      const budgetLeftMs = maxBudgetMs - elapsedMs;
      if (budgetLeftMs <= YANDEX_PLAYLIST_FETCH_TIMEOUT_MIN_MS) {
        return null;
      }

      const attemptTimeoutMs = Math.max(
        YANDEX_PLAYLIST_FETCH_TIMEOUT_MIN_MS,
        Math.min(YANDEX_PLAYLIST_FETCH_TIMEOUT_MAX_MS, budgetLeftMs - 250)
      );

      const attempt = await fetchYandexJsonWithBlockCheck(url, {
        timeoutMs: attemptTimeoutMs,
      });
      if (attempt?.blocked) {
        blockedAttempts += 1;
        continue;
      }
      nonBlockedAttempts += 1;

      const playlist = extractYandexPlaylistFromPayload(attempt?.data);
      if (playlist) {
        return { playlist };
      }
    }
  }

  if (blockedAttempts > 0 && nonBlockedAttempts === 0) {
    return { blocked: true };
  }

  return null;
}

async function resolveYandexUrl(url, requestedBy) {
  const info = parseYandexUrlInfo(url);
  if (!info) {
    return null;
  }

  const hasYandexCookies = Boolean(resolveExistingFilePath(YANDEX_COOKIES_PATH));
  let playlistMappingFailed = false;
  let antiBotDetected = false;

  if (info.playlistKind || info.playlistUuid) {
    const playlistResolveStartedAt = Date.now();
    const target = await resolveYandexPlaylistTarget(info, url);
    if (target?.blocked) {
      antiBotDetected = true;
      playlistMappingFailed = true;
    }

    if (target?.owner && target?.kind) {
      const playlistData = await fetchYandexPlaylistData(info.origin, target.owner, target.kind, {
        maxBudgetMs: YANDEX_PLAYLIST_FETCH_BUDGET_MS,
      });
      if (playlistData?.blocked) {
        antiBotDetected = true;
        playlistMappingFailed = true;
      }

      const playlist = playlistData?.playlist;
      const rawTracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
      if (rawTracks.length > 0) {
        const directTracks = toYandexCatalogTracks(rawTracks, requestedBy, info.origin, info);
        if (directTracks.length > 0) {
          return {
            tracks: directTracks,
            kind: "yandex_playlist",
            title: playlist?.title || "Yandex playlist",
          };
        }

        const metadata = limitItems(rawTracks, MAX_PLAYLIST_ITEMS)
          .map((item) => {
            const track = item?.track || item || {};
            const durationMs = Number(track?.durationMs) || 0;
            return {
              title: track?.title || "",
              artist: joinArtists(track?.artists),
              durationMs: durationMs > 0 ? durationMs : 0,
              durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
            };
          })
          .filter((item) => String(item?.title || "").trim());

        const playlistTotalBudgetMs =
          metadata.length >= 150
            ? Math.max(YANDEX_PLAYLIST_TOTAL_BUDGET_MS, 180_000)
            : YANDEX_PLAYLIST_TOTAL_BUDGET_MS;
        const elapsedBeforeMatchMs = Date.now() - playlistResolveStartedAt;
        const budgetLeftForMatchMs = playlistTotalBudgetMs - elapsedBeforeMatchMs;
        if (budgetLeftForMatchMs <= 3_500) {
          playlistMappingFailed = true;
        } else {
          const perItemTimeoutMs =
            metadata.length >= 150 ? 5_000 : metadata.length >= 90 ? 4_500 : 4_000;
          const firstPassBudgetMs = Math.max(
            3_000,
            Math.min(PLAYLIST_RESOLVE_BUDGET_MS, budgetLeftForMatchMs - 500)
          );
          const firstPass = await resolveTracksFromMetadataItems(metadata, requestedBy, {
            strictMatch: true,
            allowSyntheticFallback: false,
            allowYtdlpFallback: true,
            disableSecondaryMetadataLookup: metadata.length >= PLAYLIST_FAST_MODE_THRESHOLD,
            resolveBudgetMs: firstPassBudgetMs,
            itemResolveTimeoutMs: perItemTimeoutMs,
            maxConcurrency: metadata.length >= 120 ? 8 : 6,
            queryLimit: 3,
            returnDetailed: true,
          });

          let tracksByIndex = Array.isArray(firstPass?.tracksByIndex)
            ? [...firstPass.tracksByIndex]
            : new Array(metadata.length).fill(null);

          const firstPassMissed = Array.isArray(firstPass?.missedIndices) ? firstPass.missedIndices : [];
          const elapsedAfterFirstPassMs = Date.now() - playlistResolveStartedAt;
          const budgetLeftAfterFirstPassMs = playlistTotalBudgetMs - elapsedAfterFirstPassMs;

          if (firstPassMissed.length > 0 && budgetLeftAfterFirstPassMs > 4_000) {
            const missedMetadata = firstPassMissed.map((index) => metadata[index]).filter(Boolean);
            const secondPass = await resolveTracksFromMetadataItems(missedMetadata, requestedBy, {
              strictMatch: true,
              allowSyntheticFallback: false,
              allowYtdlpFallback: true,
              disableSecondaryMetadataLookup: false,
              resolveBudgetMs: Math.min(30_000, Math.max(4_000, budgetLeftAfterFirstPassMs - 500)),
              itemResolveTimeoutMs: Math.min(6_500, perItemTimeoutMs + 1_500),
              maxConcurrency: 4,
              queryLimit: 4,
              returnDetailed: true,
            });

            if (Array.isArray(secondPass?.tracksByIndex)) {
              secondPass.tracksByIndex.forEach((track, missedIndex) => {
                if (!track) {
                  return;
                }
                const originalIndex = firstPassMissed[missedIndex];
                if (Number.isInteger(originalIndex) && originalIndex >= 0 && originalIndex < tracksByIndex.length) {
                  tracksByIndex[originalIndex] = track;
                }
              });
            }
          }

          const resolvedByIndex = [...tracksByIndex];
          const strictResolvedTracks = limitItems(resolvedByIndex.filter(Boolean), MAX_PLAYLIST_ITEMS);
          const strictCoverage = metadata.length > 0 ? strictResolvedTracks.length / metadata.length : 0;
          if (strictResolvedTracks.length > 0 && strictCoverage >= 0.95) {
            return {
              tracks: strictResolvedTracks,
              kind: "yandex_playlist",
              title: playlist?.title || "Yandex playlist",
            };
          }

          const elapsedAfterStrictMs = Date.now() - playlistResolveStartedAt;
          const budgetLeftAfterStrictMs = playlistTotalBudgetMs - elapsedAfterStrictMs;

          // Safety net: if strict matching yielded zero tracks, run one relaxed pass.
          // We still filter by duration to avoid obviously wrong mappings.
          if (budgetLeftAfterStrictMs > 6_000) {
            const relaxedPass = await resolveTracksFromMetadataItems(metadata, requestedBy, {
              strictMatch: false,
              allowSyntheticFallback: false,
              allowYtdlpFallback: true,
              disableSecondaryMetadataLookup: false,
              resolveBudgetMs: Math.min(60_000, Math.max(6_000, budgetLeftAfterStrictMs - 500)),
              itemResolveTimeoutMs: Math.min(7_000, perItemTimeoutMs + 2_000),
              maxConcurrency: metadata.length >= 150 ? 8 : 6,
              queryLimit: 4,
              returnDetailed: true,
            });

            const relaxedTracksByIndex = Array.isArray(relaxedPass?.tracksByIndex)
              ? relaxedPass.tracksByIndex
              : [];
            const relaxedDurationSafeTracks = [];
            const relaxedTokenSafeTracks = [];

            for (let index = 0; index < relaxedTracksByIndex.length; index += 1) {
              if (resolvedByIndex[index]) {
                continue;
              }

              const candidate = relaxedTracksByIndex[index];
              if (!candidate) {
                continue;
              }

              if (!isDurationComparable(metadata[index], candidate)) {
                const metadataQuery = buildQueryFromArtistTitle(metadata[index]?.artist, metadata[index]?.title);
                if (hasQueryTokenCoverage(`${candidate.author || ""} ${candidate.title || ""}`, metadataQuery)) {
                  resolvedByIndex[index] = candidate;
                  relaxedTokenSafeTracks.push(candidate);
                }
                continue;
              }

              resolvedByIndex[index] = candidate;
              relaxedDurationSafeTracks.push(candidate);
            }

            const relaxedResolvedTracks = limitItems(resolvedByIndex.filter(Boolean), MAX_PLAYLIST_ITEMS);
            const relaxedCoverage = metadata.length > 0 ? relaxedResolvedTracks.length / metadata.length : 0;
            if (relaxedResolvedTracks.length > 0 && relaxedCoverage >= 0.95) {
              return {
                tracks: relaxedResolvedTracks,
                kind: "yandex_playlist",
                title: playlist?.title || "Yandex playlist",
              };
            }

            if (relaxedDurationSafeTracks.length > 0 || relaxedTokenSafeTracks.length > 0) {
              const nearFinalTracksByIndex = [...resolvedByIndex];
              for (let index = 0; index < metadata.length; index += 1) {
                if (nearFinalTracksByIndex[index]) {
                  continue;
                }

                const fallbackTrack = buildMetadataFallbackTrack(metadata[index], requestedBy);
                if (fallbackTrack) {
                  nearFinalTracksByIndex[index] = fallbackTrack;
                }
              }

              const nearFinalTracks = limitItems(nearFinalTracksByIndex.filter(Boolean), MAX_PLAYLIST_ITEMS);
              if (nearFinalTracks.length > 0) {
                return {
                  tracks: nearFinalTracks,
                  kind: "yandex_playlist",
                  title: playlist?.title || "Yandex playlist",
                };
              }
            }
          }

          const fallbackTracksByIndex = [...resolvedByIndex];
          for (let index = 0; index < metadata.length; index += 1) {
            if (fallbackTracksByIndex[index]) {
              continue;
            }

            const fallbackTrack = buildMetadataFallbackTrack(metadata[index], requestedBy);
            if (fallbackTrack) {
              fallbackTracksByIndex[index] = fallbackTrack;
            }
          }

          const fallbackResolvedTracks = limitItems(fallbackTracksByIndex.filter(Boolean), MAX_PLAYLIST_ITEMS);
          if (fallbackResolvedTracks.length > 0) {
            return {
              tracks: fallbackResolvedTracks,
              kind: "yandex_playlist",
              title: playlist?.title || "Yandex playlist",
            };
          }
        }
      }
    }

    playlistMappingFailed = true;
  }

  if (info.trackId) {
    const trackParam = info.albumId ? `${info.trackId}:${info.albumId}` : info.trackId;
    const trackUrl = new URL("/handlers/track.jsx", info.origin);
    trackUrl.searchParams.set("track", trackParam);

    const trackData = await fetchJsonWithTimeout(trackUrl.toString());
    const trackMeta = trackData?.track || trackData?.result?.track || null;

    if (trackMeta?.title) {
      const directTrack = toYandexCatalogTrack(trackMeta, requestedBy, info.origin, info);
      if (directTrack) {
        return {
          tracks: [directTrack],
          kind: "yandex_track",
          title: trackMeta.title || "Yandex track",
        };
      }

      const artist = joinArtists(trackMeta.artists);
      const query = buildQueryFromArtistTitle(artist, trackMeta.title);
      const resolvedTrack =
        (await resolveTrackByQueryVariants(
          [query, buildQueryFromArtistTitle(artist, `${trackMeta.title} official`), buildQueryFromArtistTitle(artist, `${trackMeta.title} audio`)],
          requestedBy,
          {
            accept: (candidate) => hasQueryTokenCoverage(`${candidate?.author || ""} ${candidate?.title || ""}`, query),
          }
        ));
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
        const directTrack = toYandexCatalogTrack(exactTrack, requestedBy, info.origin, info);
        if (directTrack) {
          return {
            tracks: [directTrack],
            kind: "yandex_track",
            title: exactTrack.title || "Yandex track",
          };
        }

        const query = buildQueryFromArtistTitle(joinArtists(exactTrack.artists), exactTrack.title);
        const resolvedTrack =
          (await resolveTrackByQueryVariants(
            [query, `${query} official`, `${query} audio`],
            requestedBy,
            {
              accept: (candidate) => hasQueryTokenCoverage(`${candidate?.author || ""} ${candidate?.title || ""}`, query),
            }
          ));
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
    const rawAlbumTracks = [];
    for (const volume of volumes) {
      const tracks = Array.isArray(volume) ? volume : [];
      for (const track of tracks) {
        rawAlbumTracks.push(track);
        metadata.push({
          title: track?.title || "",
          artist: joinArtists(track?.artists),
          durationMs: Number(track?.durationMs) || 0,
          durationSec: Number(track?.durationMs) > 0 ? Math.round(Number(track?.durationMs) / 1000) : 0,
        });
      }
    }

    const directTracks = toYandexCatalogTracks(rawAlbumTracks, requestedBy, info.origin, info);
    if (directTracks.length > 0) {
      return {
        tracks: directTracks,
        kind: "yandex_album",
        title: albumData?.title || "Yandex album",
      };
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
    cookiesPath: YANDEX_COOKIES_PATH || YTDLP_COOKIES_PATH,
    timeoutMs: 30_000,
    playlistKind: "yandex_playlist",
    trackKind: "yandex_track",
    playlistTitleFallback: "Yandex playlist",
    trackTitleFallback: "Yandex track",
    preferSyntheticPlaylist: true,
    preferSyntheticTrack: true,
  });
  if (ytdlpFallback) {
    return ytdlpFallback;
  }

  if (playlistMappingFailed) {
    if (antiBotDetected) {
      throw buildYandexAntiBotError(hasYandexCookies);
    }
    throw new Error("Не удалось сопоставить треки плейлиста Яндекс Музыки с YouTube.");
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
    durationMs: Number(item?.durationInMs) || 0,
    durationSec: Number(item?.durationInSec) || (Number(item?.durationInMs) > 0 ? Math.round(Number(item?.durationInMs) / 1000) : 0),
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
    durationMs: Number(item?.durationInMs) || 0,
    durationSec: Number(item?.durationInSec) || Number(item?.duration) || (Number(item?.durationInMs) > 0 ? Math.round(Number(item?.durationInMs) / 1000) : 0),
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

function normalizeComparableUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  try {
    const parsed = new URL(text);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/u, "");
  } catch {
    return text.replace(/\/+$/u, "");
  }
}

function normalizeVkEntryUrl(entry, fallbackUrl, options = {}) {
  const allowFallback = options.allowFallback !== false;
  const fallback = String(fallbackUrl || "").trim();
  const comparableFallback = normalizeComparableUrl(fallback);
  const formatUrls = Array.isArray(entry?.formats)
    ? entry.formats.map((format) => format?.url)
    : [];
  const candidates = [entry?.url, ...formatUrls, entry?.webpage_url, entry?.original_url]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const value of candidates) {
    let normalizedUrl = "";
    if (/^https?:\/\//i.test(value)) {
      normalizedUrl = value;
    } else if (value.startsWith("//")) {
      normalizedUrl = `https:${value}`;
    } else if (value.startsWith("/")) {
      normalizedUrl = `https://vk.com${value}`;
    } else if (/^(audio|music|playlist|wall|video)/i.test(value)) {
      normalizedUrl = `https://vk.com/${value.replace(/^\/+/, "")}`;
    }

    if (!normalizedUrl) {
      continue;
    }

    if (!allowFallback && comparableFallback && normalizeComparableUrl(normalizedUrl) === comparableFallback) {
      continue;
    }

    return normalizedUrl;
  }

  return allowFallback ? fallback : "";
}

function toVkTrack(entry, requestedBy, fallbackUrl, options = {}) {
  const durationSec = Number(entry?.duration) || 0;
  const url = normalizeVkEntryUrl(entry, fallbackUrl, {
    allowFallback: options.allowFallbackUrl !== false,
  });
  if (!url) {
    return null;
  }

  const author = String(entry?.uploader || entry?.artist || entry?.channel || "VK Music").trim() || "VK Music";
  const title = String(entry?.title || entry?.track || "VK Music track").trim() || "VK Music track";
  const metadata = metadataFromExtractorEntry(entry, "") || {
    artist: author === "VK Music" ? "" : author,
    title,
    durationSec,
    durationMs: durationSec > 0 ? durationSec * 1000 : 0,
  };
  const searchQuery = buildQueryFromArtistTitle(metadata.artist, metadata.title) || title;

  return {
    externalId: String(entry?.id || "").trim(),
    title: author && author !== "VK Music" && !normalizeText(title).includes(normalizeText(author))
      ? `${author} - ${title}`
      : title,
    url,
    playbackUrl: url,
    source: "VK Music",
    author,
    views: Number(entry?.view_count) || 0,
    durationSec,
    durationMs: durationSec > 0 ? durationSec * 1000 : 0,
    thumbnail: entry?.thumbnail || null,
    requestedById: requestedBy.id,
    requestedByTag: requestedBy.tag || requestedBy.username,
    searchQuery,
    fallbackTracks: [],
    catalogSource: "vk",
  };
}

const VK_AUDIO_BASE64_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=";

function decodeVkAudioMask(encoded) {
  let decoded = "";
  let accumulator = 0;
  let index = 0;

  for (const character of String(encoded || "")) {
    const value = VK_AUDIO_BASE64_CHARS.indexOf(character);
    if (value < 0) {
      continue;
    }

    const phase = index % 4;
    accumulator = phase ? 64 * accumulator + value : value;
    index += 1;
    if (phase) {
      decoded += String.fromCharCode(255 & (accumulator >> ((-2 * index) & 6)));
    }
  }

  return decoded;
}

function unmaskVkAudioUrl(rawUrl, ownerId = 0) {
  const value = decodeHtmlEntities(rawUrl || "");
  if (!value.includes("audio_api_unavailable") || !value.includes("?extra=")) {
    return value;
  }

  try {
    const extra = value.split("?extra=")[1] || "";
    const [encodedUrl, encodedInfo] = extra.split("#");
    const infoParts = decodeVkAudioMask(safeDecodeURIComponent(encodedInfo)).split(String.fromCharCode(11));
    const base = Number(infoParts[1]);
    const vkId = Number(ownerId) || 0;
    if (!Number.isFinite(base)) {
      return value;
    }

    const chars = [...decodeVkAudioMask(safeDecodeURIComponent(encodedUrl))];
    const urlLength = chars.length;
    const indexes = new Array(urlLength);
    let shuffleIndex = Math.trunc(base) ^ vkId;

    for (let n = urlLength - 1; n >= 0; n -= 1) {
      shuffleIndex = ((urlLength * (n + 1)) ^ (shuffleIndex + n)) % urlLength;
      indexes[n] = shuffleIndex;
    }

    for (let n = 1; n < urlLength; n += 1) {
      const current = chars[n];
      const targetIndex = indexes[urlLength - 1 - n];
      chars[n] = chars[targetIndex];
      chars[targetIndex] = current;
    }

    return chars.join("");
  } catch {
    return value;
  }
}

function normalizeVkPlayableAudioUrl(rawUrl, decoderVkId = 0) {
  const unmasked = unmaskVkAudioUrl(rawUrl, decoderVkId);
  return unmasked.replace(/\/[0-9a-f]+(\/audios)?\/([0-9a-f]+)\/index\.m3u8/iu, "$1/$2.mp3");
}

function isVkAudioFieldArray(value) {
  return Array.isArray(value) && value.length >= 6 && (
    Number.isFinite(Number(value[0])) ||
    Number.isFinite(Number(value[1])) ||
    typeof value[2] === "string"
  );
}

function collectVkAudioPayloadItems(payload) {
  if (!payload) {
    return [];
  }

  if (isVkAudioFieldArray(payload) || (!Array.isArray(payload) && typeof payload === "object")) {
    return [payload];
  }

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.flatMap((item) => collectVkAudioPayloadItems(item));
}

function firstVkCoverUrl(value) {
  const text = firstNonEmpty(value);
  if (!text) {
    return null;
  }

  return text.split(",").map((item) => item.trim()).filter(Boolean).pop() || null;
}

function vkAudioPayloadToExtractorEntry(rawAudio) {
  const isFieldArray = isVkAudioFieldArray(rawAudio);
  const id = firstNonEmpty(isFieldArray ? rawAudio[0] : rawAudio?.id, rawAudio?.audio_id, rawAudio?.audioId);
  const ownerId = firstNonEmpty(
    isFieldArray ? rawAudio[1] : rawAudio?.owner_id,
    rawAudio?.ownerId,
    rawAudio?.owner,
    rawAudio?.oid
  );
  const rawUrl = firstNonEmpty(isFieldArray ? rawAudio[2] : rawAudio?.url, rawAudio?.src, rawAudio?.mp3);
  const title = decodeHtmlEntities(firstNonEmpty(isFieldArray ? rawAudio[3] : rawAudio?.title, rawAudio?.track));
  const artist = decodeHtmlEntities(firstNonEmpty(
    isFieldArray ? rawAudio[4] : rawAudio?.artist,
    rawAudio?.performer,
    rawAudio?.author
  ));
  const duration = Number(isFieldArray ? rawAudio[5] : rawAudio?.duration) || 0;
  const coverUrl = firstVkCoverUrl(isFieldArray ? rawAudio[14] : firstNonEmpty(rawAudio?.coverUrl, rawAudio?.cover_url));
  const rawDecoderVkId = isFieldArray ? rawAudio[15]?.vk_id : firstNonEmpty(rawAudio?.vk_id, rawAudio?.extra?.vk_id);
  const decoderVkId = rawDecoderVkId === undefined || rawDecoderVkId === null || rawDecoderVkId === ""
    ? ownerId
    : rawDecoderVkId;
  const url = normalizeVkPlayableAudioUrl(rawUrl, decoderVkId);
  if (!url || !/^https?:\/\//i.test(url)) {
    return null;
  }

  const webpageUrl = ownerId && id ? `https://vk.com/audio${ownerId}_${id}` : "";
  return {
    id: ownerId && id ? `${ownerId}_${id}` : id,
    url,
    webpage_url: webpageUrl,
    original_url: webpageUrl,
    title: title || "VK Music track",
    artist,
    uploader: artist || "VK Music",
    duration,
    thumbnail: coverUrl,
  };
}

function extractVkAudioEntriesFromHtml(html) {
  const payloadItems = extractVkAudioPayloadItemsFromHtml(html);
  return vkAudioPayloadItemsToExtractorEntries(payloadItems);
}

function extractVkAudioPayloadItemsFromHtml(html) {
  const items = [];
  const source = String(html || "");
  const attributePattern = /\bdata-audio=(["'])([\s\S]*?)\1/giu;
  let match;

  while ((match = attributePattern.exec(source))) {
    const decodedPayload = decodeHtmlEntities(match[2]);
    const parsed = parseJsonPayload(decodedPayload);
    if (!parsed) {
      continue;
    }

    items.push(...collectVkAudioPayloadItems(parsed));
  }

  return items;
}

function vkPlaylistRootMarkerPattern(playlistInfo) {
  if (!playlistInfo?.ownerId || !playlistInfo?.playlistId) {
    return null;
  }

  const playlistId = escapeRegExp(`${playlistInfo.ownerId}_${playlistInfo.playlistId}`);
  return new RegExp(
    `<div\\b(?=[^>]*\\bAudioPlaylistRoot\\b)(?=[^>]*\\bdata-playlist-id=(["'])${playlistId}\\1)[^>]*>`,
    "iu"
  );
}

function extractVkPlaylistHtmlBody(html, playlistInfo) {
  const source = String(html || "");
  const markerPattern = vkPlaylistRootMarkerPattern(playlistInfo);
  const markerMatch = markerPattern ? markerPattern.exec(source) : null;
  if (!markerMatch) {
    return source;
  }

  const startIndex = markerMatch.index;
  const afterMarkerIndex = startIndex + markerMatch[0].length;
  const divPattern = /<\/?div\b[^>]*>/giu;
  divPattern.lastIndex = startIndex;
  let depth = 0;
  let tagMatch;
  while ((tagMatch = divPattern.exec(source))) {
    const tag = tagMatch[0];
    if (/^<div\b/iu.test(tag)) {
      depth += 1;
      continue;
    }

    depth -= 1;
    if (depth <= 0) {
      return source.slice(startIndex, divPattern.lastIndex);
    }
  }

  const endCandidates = [
    source.indexOf("audioPlaylist__footer", afterMarkerIndex),
    source.indexOf("<div class=\"AudioPlaylistRoot\"", afterMarkerIndex),
    source.indexOf("<div class='AudioPlaylistRoot'", afterMarkerIndex),
  ].filter((index) => index > afterMarkerIndex);
  const endIndex = endCandidates.length > 0 ? Math.min(...endCandidates) : source.length;
  return source.slice(startIndex, endIndex);
}

function extractVkPlaylistAudioPayloadItemsFromHtml(html, playlistInfo) {
  return extractVkAudioPayloadItemsFromHtml(extractVkPlaylistHtmlBody(html, playlistInfo));
}

function vkAudioPayloadItemsToExtractorEntries(payloadItems) {
  const entries = [];
  const seenUrls = new Set();

  for (const item of (Array.isArray(payloadItems) ? payloadItems : [])) {
    const entry = vkAudioPayloadToExtractorEntry(item);
    if (!entry?.url || seenUrls.has(entry.url)) {
      continue;
    }

    seenUrls.add(entry.url);
    entries.push(entry);
  }

  return entries;
}

function mergeVkExtractorEntries(...entryLists) {
  const entries = [];
  const seenUrls = new Set();

  for (const entry of entryLists.flat()) {
    if (!entry?.url || seenUrls.has(entry.url)) {
      continue;
    }

    seenUrls.add(entry.url);
    entries.push(entry);
  }

  return entries;
}

function vkAudioPayloadId(rawAudio) {
  if (isVkAudioFieldArray(rawAudio)) {
    return rawAudio[1] && rawAudio[0] ? `${rawAudio[1]}_${rawAudio[0]}` : "";
  }

  const ownerId = firstNonEmpty(rawAudio?.owner_id, rawAudio?.ownerId, rawAudio?.owner, rawAudio?.oid);
  const id = firstNonEmpty(rawAudio?.id, rawAudio?.audio_id, rawAudio?.audioId);
  return ownerId && id ? `${ownerId}_${id}` : "";
}

function mergeVkExtractorEntriesByPayloadOrder(payloadItems, ...entryLists) {
  const entryById = new Map();
  const fallbackEntries = [];

  for (const entry of entryLists.flat()) {
    if (!entry?.url) {
      continue;
    }

    const id = String(entry.id || "").trim();
    if (id && !entryById.has(id)) {
      entryById.set(id, entry);
      continue;
    }

    fallbackEntries.push(entry);
  }

  const entries = [];
  const seenUrls = new Set();
  const pushEntry = (entry) => {
    if (!entry?.url || seenUrls.has(entry.url)) {
      return;
    }

    seenUrls.add(entry.url);
    entries.push(entry);
  };

  for (const item of (Array.isArray(payloadItems) ? payloadItems : [])) {
    const id = vkAudioPayloadId(item);
    if (id) {
      pushEntry(entryById.get(id));
    }
  }

  for (const entry of fallbackEntries) {
    pushEntry(entry);
  }

  return entries;
}

function countPotentiallyPlayableVkPayloadItems(payloadItems) {
  const seenIds = new Set();
  let count = 0;

  for (const item of (Array.isArray(payloadItems) ? payloadItems : [])) {
    const id = vkAudioPayloadId(item);
    if (!id || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    if (vkAudioPayloadToExtractorEntry(item) || vkReloadIdFromPayload(item)) {
      count += 1;
    }
  }

  return count;
}

function vkReloadIdFromPayload(rawAudio) {
  if (isVkAudioFieldArray(rawAudio)) {
    const hashes = String(rawAudio[13] || "").split("/");
    if (rawAudio[1] && rawAudio[0] && hashes[2] && hashes[5]) {
      return `${rawAudio[1]}_${rawAudio[0]}_${hashes[2]}_${hashes[5]}`;
    }
  }

  const hashes = String(rawAudio?.hashes || rawAudio?.hash || "").split("/");
  const ownerId = firstNonEmpty(rawAudio?.owner_id, rawAudio?.ownerId, rawAudio?.owner, rawAudio?.oid);
  const id = firstNonEmpty(rawAudio?.id, rawAudio?.audio_id, rawAudio?.audioId);
  if (ownerId && id && hashes[2] && hashes[5]) {
    return `${ownerId}_${id}_${hashes[2]}_${hashes[5]}`;
  }

  return "";
}

function vkReloadCacheKey(reloadId) {
  return String(reloadId || "").trim();
}

function vkReloadEntryIdFromReloadId(reloadId) {
  const parts = String(reloadId || "").split("_");
  return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}_${parts[1]}` : "";
}

function getCachedVkReloadEntry(reloadId) {
  const key = vkReloadCacheKey(reloadId);
  if (!key) {
    return null;
  }

  const cached = vkReloadAudioEntryCache.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.checkedAt > VK_RELOAD_AUDIO_CACHE_TTL_MS) {
    vkReloadAudioEntryCache.delete(key);
    return null;
  }

  return cached.entry || null;
}

function setCachedVkReloadEntry(reloadId, entry) {
  const key = vkReloadCacheKey(reloadId);
  if (!key || !entry?.url) {
    return;
  }

  vkReloadAudioEntryCache.set(key, {
    entry,
    checkedAt: Date.now(),
  });
}

async function fetchVkReloadAudioEntries(payloadItems, sourceUrl, cookiesPath) {
  const reloadIds = [];
  const seenReloadIds = new Set();
  for (const item of (Array.isArray(payloadItems) ? payloadItems : [])) {
    const reloadId = vkReloadIdFromPayload(item);
    if (!reloadId || seenReloadIds.has(reloadId)) {
      continue;
    }

    seenReloadIds.add(reloadId);
    reloadIds.push(reloadId);
  }

  if (reloadIds.length === 0) {
    return [];
  }

  const entryByReloadId = new Map();
  const missingReloadIds = [];
  for (const reloadId of reloadIds) {
    const cachedEntry = getCachedVkReloadEntry(reloadId);
    if (cachedEntry?.url) {
      entryByReloadId.set(reloadId, cachedEntry);
      continue;
    }

    missingReloadIds.push(reloadId);
  }

  for (let index = 0; index < missingReloadIds.length; index += VK_RELOAD_AUDIO_CHUNK_SIZE) {
    const chunk = missingReloadIds.slice(index, index + VK_RELOAD_AUDIO_CHUNK_SIZE);
    let chunkEntries = [];

    for (let attempt = 0; attempt <= VK_RELOAD_AUDIO_RETRIES; attempt += 1) {
      if (attempt > 0) {
        await delayMs(VK_RELOAD_AUDIO_RETRY_DELAY_MS * attempt);
      }

      const body = new URLSearchParams({
        act: "reload_audio",
        ids: chunk.join(","),
      }).toString();
      const response = await requestTextWithRedirect("https://m.vk.com/audio", {
        method: "POST",
        body,
        timeoutMs: 20_000,
        cookiesPath,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
          accept: "application/json,text/plain,*/*",
          "accept-language": "ru,en-US;q=0.9,en;q=0.8",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          origin: "https://m.vk.com",
          referer: sourceUrl || "https://m.vk.com/audio",
        },
      }).catch(() => null);

      if (!response || response.statusCode < 200 || response.statusCode >= 300) {
        continue;
      }

      const parsed = parseJsonPayload(String(response.body || "").replace(/^<!--\s*/u, ""));
      const reloadedItems = collectVkAudioPayloadItems(parsed?.data?.[0] || parsed?.payload?.[1] || parsed);
      const attemptEntries = vkAudioPayloadItemsToExtractorEntries(reloadedItems);
      if (attemptEntries.length > chunkEntries.length) {
        chunkEntries = attemptEntries;
      }
      if (attemptEntries.length >= chunk.length) {
        break;
      }
    }

    const reloadIdByEntryId = new Map();
    for (const reloadId of chunk) {
      const entryId = vkReloadEntryIdFromReloadId(reloadId);
      if (entryId) {
        reloadIdByEntryId.set(entryId, reloadId);
      }
    }

    for (const entry of chunkEntries) {
      const reloadId = reloadIdByEntryId.get(String(entry?.id || "").trim());
      if (!reloadId || !entry?.url || entryByReloadId.has(reloadId)) {
        continue;
      }

      setCachedVkReloadEntry(reloadId, entry);
      entryByReloadId.set(reloadId, entry);
    }

    if (index + VK_RELOAD_AUDIO_CHUNK_SIZE < missingReloadIds.length) {
      await delayMs(VK_RELOAD_AUDIO_CHUNK_DELAY_MS);
    }
  }

  const entries = [];
  const seenUrls = new Set();
  for (const reloadId of reloadIds) {
    const entry = entryByReloadId.get(reloadId);
    if (!entry?.url || seenUrls.has(entry.url)) {
      continue;
    }

    seenUrls.add(entry.url);
    entries.push(entry);
  }

  return entries;
}

function parseVkPlaylistInfoFromUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const texts = [
      `${parsed.pathname}${parsed.search}`,
      parsed.searchParams.get("z"),
      parsed.searchParams.get("w"),
      parsed.hash,
    ]
      .map((item) => safeDecodeURIComponent(item || ""))
      .filter(Boolean);

    for (const text of texts) {
      const match =
        text.match(/\/music\/playlist\/(-?\d+)_(\d+)(?:_([\da-f]+))?/iu) ||
        text.match(/audio_playlist(-?\d+)_(\d+)(?:[\/_]([\da-f]+))?/iu);
      if (!match?.[1] || !match?.[2]) {
        continue;
      }

      return {
        ownerId: match[1],
        playlistId: match[2],
        accessHash:
          match[3] ||
          parsed.searchParams.get("api_view") ||
          parsed.searchParams.get("access_hash") ||
          parsed.searchParams.get("hash") ||
          "",
      };
    }

    return null;
  } catch {
    return null;
  }
}

function buildVkMobilePlaylistUrl(info, offset = 0) {
  if (!info?.ownerId || !info?.playlistId) {
    return "";
  }

  const mobileUrl = new URL("https://m.vk.com/audio");
  mobileUrl.searchParams.set("act", `audio_playlist${info.ownerId}_${info.playlistId}`);
  if (info.accessHash) {
    mobileUrl.searchParams.set("api_view", info.accessHash);
  }
  if (Number(offset) > 0) {
    mobileUrl.searchParams.set("from", `/audio?act=audio_playlists${info.ownerId}`);
    mobileUrl.searchParams.set("offset", String(Math.floor(Number(offset))));
  }

  return mobileUrl.toString();
}

function buildVkHtmlFetchUrls(url) {
  const urls = [String(url || "").trim()].filter(Boolean);
  const info = parseVkPlaylistInfoFromUrl(url);
  if (!info) {
    return urls;
  }

  const mobileUrlText = buildVkMobilePlaylistUrl(info);
  if (!urls.includes(mobileUrlText)) {
    urls.push(mobileUrlText);
  }

  return urls;
}

function extractVkPlaylistTotalFromHtml(html) {
  const source = String(html || "");
  const footerMatch = source.match(/audioPlaylist__footer[^>]*>\s*([\d\s]+)/iu);
  if (!footerMatch?.[1]) {
    return 0;
  }

  const total = Number(String(footerMatch[1]).replace(/\D+/gu, ""));
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function offsetFromVkPageUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim(), "https://m.vk.com");
    const offset = Number(parsed.searchParams.get("offset") || 0);
    return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  } catch {
    return 0;
  }
}

function extractVkNextPlaylistOffsets(html, playlistInfo) {
  const offsets = new Set();
  const source = String(html || "");
  const hrefPattern = /\bhref=(["'])([\s\S]*?)\1/giu;
  let match;

  while ((match = hrefPattern.exec(source))) {
    const href = decodeHtmlEntities(match[2]);
    if (!href.includes(`audio_playlist${playlistInfo.ownerId}_${playlistInfo.playlistId}`)) {
      continue;
    }

    const offset = offsetFromVkPageUrl(href);
    if (offset > 0) {
      offsets.add(offset);
    }
  }

  const total = extractVkPlaylistTotalFromHtml(source);
  if (total > 0) {
    for (let offset = 100; offset < total; offset += 100) {
      offsets.add(offset);
    }
  }

  return [...offsets].sort((left, right) => left - right);
}

async function fetchVkPlaylistHtmlPages(url, cookiesPath) {
  const playlistInfo = parseVkPlaylistInfoFromUrl(url);
  const queuedUrls = buildVkHtmlFetchUrls(url);
  const seenUrls = new Set();
  const seenOffsets = new Set();
  const pages = [];
  const maxPages = hasFinitePlaylistLimit()
    ? Math.max(2, Math.ceil(MAX_PLAYLIST_ITEMS / 100) + 2)
    : 50;

  while (queuedUrls.length > 0 && pages.length < maxPages) {
    const fetchUrl = queuedUrls.shift();
    const comparableUrl = normalizeComparableUrl(fetchUrl);
    if (!fetchUrl || seenUrls.has(comparableUrl)) {
      continue;
    }

    seenUrls.add(comparableUrl);
    const response = await fetchVkHtmlPage(fetchUrl, cookiesPath);
    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
      continue;
    }

    pages.push({ response, fetchUrl });

    if (!playlistInfo) {
      continue;
    }

    for (const offset of extractVkNextPlaylistOffsets(response.body, playlistInfo)) {
      if (seenOffsets.has(offset)) {
        continue;
      }

      seenOffsets.add(offset);
      const nextUrl = buildVkMobilePlaylistUrl(playlistInfo, offset);
      if (nextUrl && !seenUrls.has(normalizeComparableUrl(nextUrl))) {
        queuedUrls.push(nextUrl);
      }
    }
  }

  return pages;
}

async function fetchVkHtmlPage(url, cookiesPath) {
  return requestTextWithRedirect(url, {
    timeoutMs: 20_000,
    cookiesPath,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "ru,en-US;q=0.9,en;q=0.8",
      referer: "https://vk.com/",
    },
  }).catch(() => null);
}

async function resolveVkUrlViaHtmlOnce(url, requestedBy, cookiesPath) {
  const pages = await fetchVkPlaylistHtmlPages(url, cookiesPath);
  if (pages.length === 0) {
    return null;
  }

  const playlistInfo = parseVkPlaylistInfoFromUrl(url);
  const payloadItems = [];
  let title = "";
  let totalItems = 0;
  let sourceUrl = "";

  for (const page of pages) {
    const response = page.response;
    const pageItems = playlistInfo
      ? extractVkPlaylistAudioPayloadItemsFromHtml(response.body, playlistInfo)
      : extractVkAudioPayloadItemsFromHtml(response.body);
    if (pageItems.length === 0) {
      continue;
    }

    if (!title) {
      title = extractMetaContent(response.body, "property", "og:title") || extractTitleTag(response.body);
    }
    if (!sourceUrl) {
      sourceUrl = response.finalUrl || page.fetchUrl || url;
    }
    totalItems = Math.max(totalItems, extractVkPlaylistTotalFromHtml(response.body));
    payloadItems.push(...pageItems);
  }

  if (payloadItems.length === 0) {
    return null;
  }

  const rawExpectedItems = countPotentiallyPlayableVkPayloadItems(payloadItems);
  const expectedItems = hasFinitePlaylistLimit()
    ? Math.min(rawExpectedItems, MAX_PLAYLIST_ITEMS)
    : rawExpectedItems;
  const directEntries = vkAudioPayloadItemsToExtractorEntries(payloadItems);
  const reloadedEntries = await fetchVkReloadAudioEntries(payloadItems, sourceUrl || url, cookiesPath);
  const entries = applyPlaylistLimit(mergeVkExtractorEntriesByPayloadOrder(payloadItems, reloadedEntries, directEntries));
  if (entries.length === 0) {
    return null;
  }

  const tracks = entries
    .map((entry) => toVkTrack(entry, requestedBy, url, { allowFallbackUrl: false }))
    .filter((track) => track?.url);

  if (tracks.length === 0) {
    return null;
  }

  return {
    tracks,
    kind: tracks.length > 1 ? "vk_playlist" : "vk_track",
    title: title || "VK Music",
    totalItems: totalItems || payloadItems.length,
    expectedItems,
  };
}

async function resolveVkUrlViaHtml(url, requestedBy, cookiesPath) {
  let bestResolved = null;

  for (let attempt = 0; attempt <= VK_HTML_RESOLVE_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await delayMs(VK_HTML_RESOLVE_RETRY_DELAY_MS * attempt);
    }

    const resolved = await resolveVkUrlViaHtmlOnce(url, requestedBy, cookiesPath).catch(() => null);
    if (!resolved) {
      continue;
    }

    const resolvedCount = Array.isArray(resolved.tracks) ? resolved.tracks.length : 0;
    const bestCount = Array.isArray(bestResolved?.tracks) ? bestResolved.tracks.length : 0;
    if (!bestResolved || resolvedCount > bestCount) {
      bestResolved = resolved;
    }

    const expectedItems = Number(resolved.expectedItems) || 0;
    if (!expectedItems || resolvedCount >= expectedItems) {
      return resolved;
    }
  }

  return bestResolved;
}

function mergeVkTrackLists(...trackLists) {
  const tracks = [];
  const seenUrls = new Set();
  const seenIds = new Set();

  for (const track of trackLists.flat()) {
    if (!track?.url) {
      continue;
    }

    const url = String(track.url || "").trim();
    const playbackUrl = String(track.playbackUrl || "").trim();
    if ((url && seenUrls.has(url)) || (playbackUrl && seenUrls.has(playbackUrl))) {
      continue;
    }

    const externalId = String(track.externalId || "").trim();
    if (externalId && seenIds.has(externalId)) {
      continue;
    }

    if (url) {
      seenUrls.add(url);
    }
    if (playbackUrl) {
      seenUrls.add(playbackUrl);
    }
    if (externalId) {
      seenIds.add(externalId);
    }
    tracks.push(track);
  }

  return applyPlaylistLimit(tracks);
}

function vkYtDlpJsonToResolved(vkJson, requestedBy, url) {
  if (!vkJson) {
    return null;
  }

  const entries = Array.isArray(vkJson.entries) ? vkJson.entries.filter(Boolean) : [];
  if (entries.length > 0) {
    const tracks = applyPlaylistLimit(entries)
      .map((entry) => toVkTrack(entry, requestedBy, url, { allowFallbackUrl: false }))
      .filter((track) => track?.url);

    if (tracks.length > 0) {
      return {
        tracks,
        kind: "vk_playlist",
        title: vkJson.title || "VK playlist",
      };
    }
  }

  const canUseSingleExtractorResult = vkJson?._type !== "playlist" && !isVkPlaylistLikeUrl(url);
  const singleTrack = canUseSingleExtractorResult ? toVkTrack(vkJson, requestedBy, url) : null;
  if (singleTrack?.url) {
    return {
      tracks: [singleTrack],
      kind: "vk_track",
      title: vkJson.title || "VK track",
    };
  }

  return null;
}

function shouldTryVkYtDlpAfterHtml(htmlResolved) {
  const resolvedCount = Array.isArray(htmlResolved?.tracks) ? htmlResolved.tracks.length : 0;
  const totalItems = Number(htmlResolved?.totalItems) || 0;
  return !htmlResolved || (totalItems > 0 && resolvedCount < totalItems);
}

function isVkPlaylistLikeUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const text = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return (
      text.includes("/music/playlist") ||
      text.includes("audio_playlist") ||
      text.includes("/audios") ||
      text.includes("section=playlist") ||
      /(?:^|[?&]w=|\/)wall-?\d+_\d+/iu.test(text)
    );
  } catch {
    return false;
  }
}

function metadataFromExtractorEntry(entry, sourceLabel = "") {
  const artist = firstNonEmpty(
    entry?.artist,
    entry?.uploader,
    entry?.channel,
    entry?.creator,
    entry?.author
  );
  const normalized = normalizeMetadataItem(
    {
      artist,
      title: entry?.track || entry?.title || entry?.fulltitle || entry?.alt_title || "",
    },
    ""
  );

  if (!normalized?.title) {
    return null;
  }

  const durationSecRaw = Number(entry?.duration);
  const durationSec = Number.isFinite(durationSecRaw) && durationSecRaw > 0 ? Math.round(durationSecRaw) : 0;

  return {
    ...normalized,
    durationSec,
    durationMs: durationSec > 0 ? durationSec * 1000 : 0,
  };
}

async function resolveViaYtDlpMetadata(url, requestedBy, options = {}) {
  const sourceLabel = String(options.sourceLabel || "").trim();
  const cookiesPath = options.cookiesPath || "";
  const timeoutMs = Number(options.timeoutMs) || 30_000;
  const playlistKind = String(options.playlistKind || "external_playlist");
  const trackKind = String(options.trackKind || "external_track");
  const playlistTitleFallback = String(options.playlistTitleFallback || `${sourceLabel || "External"} playlist`);
  const trackTitleFallback = String(options.trackTitleFallback || `${sourceLabel || "External"} track`);
  const preferSyntheticPlaylist = options.preferSyntheticPlaylist === true;
  const preferSyntheticTrack = options.preferSyntheticTrack === true;

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
      if (preferSyntheticPlaylist) {
        const fallbackTracks = metadata
          .map((item) => buildMetadataFallbackTrack(item, requestedBy))
          .filter((track) => track?.url);
        if (fallbackTracks.length > 0) {
          return {
            tracks: fallbackTracks,
            kind: playlistKind,
            title: extractorJson.title || playlistTitleFallback,
          };
        }
      }

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
  if (preferSyntheticTrack) {
    const fallbackTrack = buildMetadataFallbackTrack(singleMetadata, requestedBy, primaryQuery);
    if (fallbackTrack) {
      return {
        tracks: [fallbackTrack],
        kind: trackKind,
        title: extractorJson.title || singleMetadata.title || trackTitleFallback,
      };
    }
  }

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
    const parsedTarget = (() => {
      try {
        return new URL(String(url || "").trim());
      } catch {
        return null;
      }
    })();
    const isVkTarget = Boolean(parsedTarget && isVkMusicHost(parsedTarget.hostname));
    const isYandexTarget = Boolean(parsedTarget && isYandexMusicHost(parsedTarget.hostname));
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

    if (isVkTarget) {
      args.push("--referer", "https://vk.com/");
    }

    if (isYandexTarget) {
      args.push("--referer", "https://music.yandex.ru/");
    }

    if (flatPlaylist) {
      args.push("--flat-playlist");
    }

    const forceHomeSource = options.forceHomeSource === true || shouldUseHomeL2tpForUrl(url);
    if (forceHomeSource && isHomeL2tpEnabled()) {
      args.push("--source-address", String(L2TP_SOURCE_IP || "").trim());
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

    const executionEnv = buildYtDlpEnv(process.env);

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
  const playlistLike = isVkPlaylistLikeUrl(url);
  const htmlResolved = playlistLike
    ? await resolveVkUrlViaHtml(url, requestedBy, cookiesPath)
    : null;

  if (htmlResolved) {
    return htmlResolved;
  }

  let ytdlpResolved = null;
  if (!playlistLike || shouldTryVkYtDlpAfterHtml(htmlResolved)) {
    const vkJson = await fetchYtDlpJson(url, {
      timeoutMs: 30_000,
      cookiesPath,
      flatPlaylist: false,
      playlistEnd: MAX_PLAYLIST_ITEMS,
    }).catch(() => null);
    ytdlpResolved = vkYtDlpJsonToResolved(vkJson, requestedBy, url);
  }

  if (ytdlpResolved) {
    return ytdlpResolved;
  }

  if (!playlistLike) {
    return resolveVkUrlViaHtml(url, requestedBy, cookiesPath);
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
    let yandexResolveError = null;
    const yandexResolved = await resolveYandexUrl(input, requestedBy).catch((error) => {
      yandexResolveError = error;
      console.warn(`[Resolve] Yandex URL fallback (${input}): ${error.message}`);
      return null;
    });
    if (yandexResolved) {
      return {
        ...yandexResolved,
        tracks: (Array.isArray(yandexResolved.tracks) ? yandexResolved.tracks : []).map((track) => ({
          ...track,
          catalogSource: track?.catalogSource || "yandex",
        })),
      };
    }

    if (yandexResolveError?.message) {
      throw new Error(yandexResolveError.message);
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
      return {
        ...vkResolved,
        tracks: (Array.isArray(vkResolved.tracks) ? vkResolved.tracks : []).map((track) => ({
          ...track,
          catalogSource: track?.catalogSource || "vk",
        })),
      };
    }

    if (isVkMusicUrl) {
      throw new Error(
        "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043e\u0442\u043a\u0440\u044b\u0442\u044c VK Music \u0441\u0441\u044b\u043b\u043a\u0443 \u043a\u0430\u043a \u043f\u0440\u044f\u043c\u043e\u0439 VK-\u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a. YouTube fallback \u0434\u043b\u044f VK \u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d, \u0447\u0442\u043e\u0431\u044b \u043d\u0435 \u0434\u043e\u0431\u0430\u0432\u043b\u044f\u0442\u044c \u0441\u043b\u0443\u0447\u0430\u0439\u043d\u044b\u0435 \u0442\u0440\u0435\u043a\u0438. \u041f\u0440\u043e\u0432\u0435\u0440\u044c VK cookies \u0444\u0430\u0439\u043b (VK_COOKIES_PATH)."
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


