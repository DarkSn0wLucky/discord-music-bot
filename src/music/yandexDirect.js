const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { L2TP_SOURCE_IP, YANDEX_COOKIES_PATH } = require("../config");

const YANDEX_DIRECT_TIMEOUT_MS = 15_000;
const YANDEX_DIRECT_SIGN_SALT = "XGRlBW9FXlekgbPrRHuSiA";

let l2tpAddressChecked = false;
let l2tpAddressAvailable = false;

function hasLocalAddress(address) {
  const target = String(address || "").trim();
  if (!target) {
    return false;
  }

  for (const entries of Object.values(os.networkInterfaces())) {
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
  return l2tpAddressAvailable;
}

function yandexLocalAddress() {
  const enabled = ["1", "true", "yes", "on", "enabled"].includes(
    String(process.env.ENABLE_L2TP_BIND || "").trim().toLowerCase()
  );
  const address = String(L2TP_SOURCE_IP || "").trim();
  return enabled && address && canUseConfiguredL2tpAddress() ? address : "";
}

function resolveConfiguredPath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const absolutePath = path.isAbsolute(text) ? text : path.resolve(process.cwd(), text);
  return fs.existsSync(absolutePath) ? absolutePath : "";
}

function normalizeCookieDomain(rawDomain) {
  return String(rawDomain || "")
    .trim()
    .toLowerCase()
    .replace(/^#httponly_/i, "")
    .replace(/^\.+/, "");
}

function hostMatchesCookieDomain(hostname, domain, includeSubdomains) {
  const host = String(hostname || "").toLowerCase();
  const normalizedDomain = normalizeCookieDomain(domain);
  if (!host || !normalizedDomain) {
    return false;
  }

  return host === normalizedDomain || (includeSubdomains && host.endsWith(`.${normalizedDomain}`));
}

function parseNetscapeCookieLine(line) {
  const parts = String(line || "").split("\t");
  if (parts.length < 7) {
    return null;
  }

  const [domainRaw, includeSubdomainsRaw, _pathRaw, _secureRaw, _expiresRaw, nameRaw, ...valueParts] = parts;
  const domain = normalizeCookieDomain(domainRaw);
  const name = String(nameRaw || "").trim();
  const value = String(valueParts.join("\t") || "").trim();
  if (!domain || !name) {
    return null;
  }

  return {
    domain,
    includeSubdomains: String(includeSubdomainsRaw || "").trim().toUpperCase() === "TRUE",
    name,
    value,
  };
}

function buildCookieHeader(url, cookiesPath = "") {
  const absolutePath = resolveConfiguredPath(cookiesPath || YANDEX_COOKIES_PATH);
  if (!absolutePath) {
    return "";
  }

  let hostname = "";
  try {
    hostname = new URL(String(url || "")).hostname;
  } catch {
    return "";
  }

  const cookies = [];
  for (const line of fs.readFileSync(absolutePath, "utf8").split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) {
      continue;
    }

    const cookie = parseNetscapeCookieLine(line);
    if (cookie && hostMatchesCookieDomain(hostname, cookie.domain, cookie.includeSubdomains)) {
      cookies.push(`${cookie.name}=${cookie.value}`);
    }
  }

  return cookies.join("; ");
}

function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(String(url || ""));
    const client = parsedUrl.protocol === "http:" ? http : https;
    const headers = { ...(options.headers || {}) };
    const cookieHeader = buildCookieHeader(parsedUrl.toString(), options.cookiesPath || "");
    if (cookieHeader && !headers.cookie && !headers.Cookie) {
      headers.cookie = cookieHeader;
    }

    const requestOptions = {
      method: String(options.method || "GET").toUpperCase(),
      headers,
    };
    const localAddress = String(options.localAddress || "").trim();
    if (localAddress) {
      requestOptions.localAddress = localAddress;
    }

    const req = client.request(parsedUrl, requestOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Yandex HTTP ${res.statusCode}: ${body.slice(0, 160)}`));
          return;
        }
        resolve(body);
      });
    });

    req.setTimeout(Number(options.timeoutMs) || YANDEX_DIRECT_TIMEOUT_MS, () => {
      req.destroy(new Error("Yandex direct request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function requestJson(url, options = {}) {
  const body = await requestText(url, options);
  return JSON.parse(body);
}

function parseYandexTrackUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const albumTrackMatch = parsed.pathname.match(/\/album\/(\d+)\/track\/(\d+)/u);
    if (albumTrackMatch) {
      return {
        albumId: albumTrackMatch[1],
        trackId: albumTrackMatch[2],
        url: parsed.toString(),
      };
    }

    const trackMatch = parsed.pathname.match(/\/track\/(\d+)/u);
    if (!trackMatch) {
      return null;
    }

    return {
      albumId: "",
      trackId: trackMatch[1],
      url: parsed.toString(),
    };
  } catch {
    return null;
  }
}

function normalizeHttpsUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.startsWith("//")) {
    return `https:${text}`;
  }
  if (text.startsWith("http://")) {
    return `https://${text.slice("http://".length)}`;
  }
  return text;
}

function appendFormatJson(value) {
  const url = normalizeHttpsUrl(value);
  if (!url) {
    return "";
  }
  return `${url}${url.includes("?") ? "&" : "?"}format=json`;
}

function buildMp3Url(downloadInfo, trackId) {
  const host = String(downloadInfo?.host || "").trim();
  const pathName = String(downloadInfo?.path || "").trim();
  const timestamp = String(downloadInfo?.ts || "").trim();
  const secret = String(downloadInfo?.s || "").trim();
  if (!host || !pathName || !timestamp || !secret) {
    return "";
  }

  const key = crypto
    .createHash("md5")
    .update(`${YANDEX_DIRECT_SIGN_SALT}${pathName.slice(1)}${secret}`)
    .digest("hex");

  return `https://${host}/get-mp3/${key}/${timestamp}${pathName}?track-id=${encodeURIComponent(trackId)}`;
}

async function resolveYandexDirectStreamUrl(trackUrl, options = {}) {
  const info = parseYandexTrackUrl(trackUrl);
  if (!info) {
    return "";
  }

  const cookiesPath = options.cookiesPath || YANDEX_COOKIES_PATH;
  const localAddress = options.localAddress === undefined ? yandexLocalAddress() : String(options.localAddress || "");
  const timeoutMs = Number(options.timeoutMs) || YANDEX_DIRECT_TIMEOUT_MS;
  const trackParam = info.albumId ? `${info.trackId}:${info.albumId}` : info.trackId;
  const downloadUrl = new URL(
    `/api/v2.1/handlers/track/${trackParam}/web-album_track-track-track-main/download/m`,
    "https://music.yandex.ru"
  );
  downloadUrl.searchParams.set("hq", "1");

  const requestOptions = {
    cookiesPath,
    localAddress,
    timeoutMs,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      accept: "application/json,text/plain,*/*",
      "accept-language": "ru,en-US;q=0.9,en;q=0.8",
      referer: info.url,
      "x-requested-with": "XMLHttpRequest",
      "x-retpath-y": info.url,
    },
  };

  const downloadData = await requestJson(downloadUrl.toString(), requestOptions);
  const sourceUrl = appendFormatJson(downloadData?.src);
  if (!sourceUrl) {
    throw new Error("Yandex direct source is empty");
  }

  const downloadInfo = await requestJson(sourceUrl, requestOptions);
  const mp3Url = buildMp3Url(downloadInfo, info.trackId);
  if (!mp3Url) {
    throw new Error("Yandex direct mp3 URL is empty");
  }

  return mp3Url;
}

module.exports = {
  resolveYandexDirectStreamUrl,
};
