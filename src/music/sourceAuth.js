const fs = require("fs");
const path = require("path");
const play = require("play-dl");
const {
  SOUNDCLOUD_CLIENT_ID,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  SPOTIFY_MARKET,
  YOUTUBE_COOKIE,
  YTDLP_COOKIES_PATH,
} = require("../config");

function resolveCookiesFilePath() {
  const configuredPath = String(YTDLP_COOKIES_PATH || "").trim();
  if (!configuredPath) {
    return null;
  }

  const absolutePath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(process.cwd(), configuredPath);
  return fs.existsSync(absolutePath) ? absolutePath : null;
}

function parseCookieFileToHeader(filePath) {
  if (!filePath) {
    return "";
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const cookieMap = new Map();

  for (let rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#HttpOnly_")) {
      rawLine = line.replace(/^#HttpOnly_/, "");
    } else if (line.startsWith("#")) {
      continue;
    } else {
      rawLine = line;
    }

    const parts = rawLine.split("\t");
    if (parts.length < 7) {
      continue;
    }

    const domain = String(parts[0] || "").toLowerCase();
    if (!domain.includes("youtube.com") && !domain.includes("google.com")) {
      continue;
    }

    const name = String(parts[5] || "").trim();
    const value = String(parts[6] || "").trim();
    if (!name || !value) {
      continue;
    }

    cookieMap.set(name, value);
  }

  if (cookieMap.size === 0) {
    return "";
  }

  return [...cookieMap.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function resolveYoutubeCookie() {
  const envCookie = String(YOUTUBE_COOKIE || "").trim();
  if (envCookie) {
    return { value: envCookie, source: "env" };
  }

  try {
    const cookiePath = resolveCookiesFilePath();
    const cookieHeader = parseCookieFileToHeader(cookiePath);
    if (cookieHeader) {
      return { value: cookieHeader, source: "file", filePath: cookiePath };
    }
  } catch (error) {
    console.warn("[Music] Could not parse cookie file:", error.message);
  }

  return null;
}

async function initSourceAuth() {
  const tokenPayload = {};
  let soundCloudReady = false;
  let spotifyReady = false;
  const youtubeCookie = resolveYoutubeCookie();

  if (youtubeCookie?.value) {
    tokenPayload.youtube = { cookie: youtubeCookie.value };
  }

  if (SOUNDCLOUD_CLIENT_ID) {
    tokenPayload.soundcloud = { client_id: SOUNDCLOUD_CLIENT_ID };
    soundCloudReady = true;
  } else {
    try {
      const freeClientId = await play.getFreeClientID();
      tokenPayload.soundcloud = { client_id: freeClientId };
      soundCloudReady = true;
    } catch (error) {
      console.warn("[Music] SoundCloud client id not available:", error.message);
    }
  }

  if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && SPOTIFY_REFRESH_TOKEN) {
    tokenPayload.spotify = {
      client_id: SPOTIFY_CLIENT_ID,
      client_secret: SPOTIFY_CLIENT_SECRET,
      refresh_token: SPOTIFY_REFRESH_TOKEN,
      market: SPOTIFY_MARKET || "US",
    };
    spotifyReady = true;
  }

  if (Object.keys(tokenPayload).length > 0) {
    await play.setToken(tokenPayload);
  }

  if (youtubeCookie?.source === "file") {
    console.log(`[Music] YouTube cookie loaded from file: ${youtubeCookie.filePath}`);
  }

  return {
    soundCloudReady,
    spotifyReady,
    youtubeCookieReady: Boolean(youtubeCookie?.value),
    youtubeCookieSource: youtubeCookie?.source || "none",
  };
}

module.exports = {
  initSourceAuth,
};
