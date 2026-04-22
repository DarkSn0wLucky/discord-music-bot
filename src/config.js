const dotenv = require("dotenv");

dotenv.config();

function asNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asLimit(value, fallback = Number.POSITIVE_INFINITY) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["inf", "infinity", "unlimited", "none", "off"].includes(normalized)) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor(parsed);
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function asList(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertEnv(keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

function normalizeYtExtractorArgs(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "youtube:player_client=android,web,mweb";
  }

  const playerClientMatch = raw.match(/youtube:player_client=([^\s]+)/i);
  if (!playerClientMatch) {
    return raw;
  }

  const clients = playerClientMatch[1]
    .split(",")
    .map((client) => client.trim())
    .filter(Boolean);

  if (!clients.some((client) => client.toLowerCase() === "android")) {
    clients.unshift("android");
  }

  const uniqueClients = [...new Set(clients.map((client) => client.toLowerCase()))];
  return raw.replace(playerClientMatch[0], `youtube:player_client=${uniqueClients.join(",")}`);
}

module.exports = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || "",
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || "",
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || "",
  MUSIC_TEXT_CHANNEL_ID: process.env.MUSIC_TEXT_CHANNEL_ID || "",
  MUSIC_TEXT_CHANNEL_NAME: process.env.MUSIC_TEXT_CHANNEL_NAME || "\u043c\u0443\u0437\u044b\u043a\u0430",
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || "",
  YOUTUBE_COOKIE: process.env.YOUTUBE_COOKIE || "",
  SOUNDCLOUD_CLIENT_ID: process.env.SOUNDCLOUD_CLIENT_ID || "",
  SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID || "",
  SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET || "",
  SPOTIFY_REFRESH_TOKEN: process.env.SPOTIFY_REFRESH_TOKEN || "",
  SPOTIFY_MARKET: process.env.SPOTIFY_MARKET || "US",
  YTDLP_COOKIES_PATH: process.env.YTDLP_COOKIES_PATH || "cookies.txt",
  YTDLP_BIN: process.env.YTDLP_BIN || "yt-dlp",
  YTDLP_RUNTIME_PATH: process.env.YTDLP_RUNTIME_PATH || "",
  YTDLP_EXTRACTOR_ARGS: normalizeYtExtractorArgs(process.env.YTDLP_EXTRACTOR_ARGS),
  VK_COOKIES_PATH: process.env.VK_COOKIES_PATH || "",
  EMBED_COLOR_HEX: process.env.EMBED_COLOR_HEX || "#4da3ff",
  MAX_QUEUE_SIZE: asLimit(process.env.MAX_QUEUE_SIZE, Number.POSITIVE_INFINITY),
  MAX_PLAYLIST_ITEMS: asLimit(process.env.MAX_PLAYLIST_ITEMS, Number.POSITIVE_INFINITY),
  AUTO_DISCONNECT_MS: asNumber(process.env.AUTO_DISCONNECT_MS, 180_000),
  DEFAULT_VOLUME: asNumber(process.env.DEFAULT_VOLUME, 0.75),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
  AI_CHAT_ENABLED: asBoolean(process.env.AI_CHAT_ENABLED, false),
  AI_CHAT_CHANNEL_ID: process.env.AI_CHAT_CHANNEL_ID || "",
  AI_CHAT_CHANNEL_NAME: process.env.AI_CHAT_CHANNEL_NAME || "чатик-🦍",
  AI_ALLOWED_CHANNEL_IDS: asList(process.env.AI_ALLOWED_CHANNEL_IDS || ""),
  AI_BATCH_WINDOW_MS: asNumber(process.env.AI_BATCH_WINDOW_MS, 60_000),
  AI_MAX_PROMPT_CHARS: asNumber(process.env.AI_MAX_PROMPT_CHARS, 550),
  AI_MAX_OUTPUT_CHARS: asNumber(process.env.AI_MAX_OUTPUT_CHARS, 650),
  AI_GEMINI_MAX_OUTPUT_TOKENS: asNumber(process.env.AI_GEMINI_MAX_OUTPUT_TOKENS, 1024),
  AI_REQUEST_TIMEOUT_MS: asNumber(process.env.AI_REQUEST_TIMEOUT_MS, 20_000),
  AI_TEMPERATURE: asNumber(process.env.AI_TEMPERATURE, 0.9),
  AI_TOP_P: asNumber(process.env.AI_TOP_P, 0.95),
  AI_COOLDOWN_MS: asNumber(process.env.AI_COOLDOWN_MS, 1200),
  AI_MAX_CONTEXT_MESSAGES: asNumber(process.env.AI_MAX_CONTEXT_MESSAGES, 8),
  YANDEX_PLAYLIST_HINTS: process.env.YANDEX_PLAYLIST_HINTS || "",
  assertEnv,
};
