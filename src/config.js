const dotenv = require("dotenv");

dotenv.config();

function asNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertEnv(keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

module.exports = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || "",
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || "",
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || "",
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || "",
  YOUTUBE_COOKIE: process.env.YOUTUBE_COOKIE || "",
  SOUNDCLOUD_CLIENT_ID: process.env.SOUNDCLOUD_CLIENT_ID || "",
  YTDLP_COOKIES_PATH: process.env.YTDLP_COOKIES_PATH || "cookies.txt",
  EMBED_COLOR_HEX: process.env.EMBED_COLOR_HEX || "#ff5ca8",
  MAX_QUEUE_SIZE: asNumber(process.env.MAX_QUEUE_SIZE, 150),
  MAX_PLAYLIST_ITEMS: asNumber(process.env.MAX_PLAYLIST_ITEMS, 50),
  AUTO_DISCONNECT_MS: asNumber(process.env.AUTO_DISCONNECT_MS, 180_000),
  DEFAULT_VOLUME: asNumber(process.env.DEFAULT_VOLUME, 0.75),
  assertEnv,
};
