const {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  PLAYBACK_DIAGNOSTICS_GEMINI_COOLDOWN_MS,
  PLAYBACK_DIAGNOSTICS_GEMINI_ENABLED,
  PLAYBACK_DIAGNOSTICS_GEMINI_MAX_PER_HOUR,
  PLAYBACK_DIAGNOSTICS_GEMINI_MODE,
  PLAYBACK_DIAGNOSTICS_GEMINI_TIMEOUT_MS,
} = require("../config");

const MAX_ERROR_CHARS = 1800;
const MAX_TRACK_CHARS = 220;
const geminiCooldowns = new Map();
const geminiHourlyCalls = [];

function sourceKey(track) {
  const raw = `${String(track?.catalogSource || "")} ${String(track?.source || "")} ${String(
    track?.url || ""
  )} ${String(track?.playbackUrl || "")}`.toLowerCase();

  if (raw.includes("music.yandex") || raw.includes("yandex")) return "yandex";
  if (raw.includes("vk.com") || raw.includes("vk")) return "vk";
  if (raw.includes("youtube.com") || raw.includes("youtu.be") || raw.includes("youtube")) return "youtube";
  if (raw.includes("soundcloud")) return "soundcloud";
  return "unknown";
}

function trimText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function redactSensitive(value) {
  return String(value || "")
    .replace(/(cookie|authorization|x-goog-api-key|api[_-]?key|token|sid|session)[=:]\s*[^\s;]+/giu, "$1=<redacted>")
    .replace(/([?&](?:key|token|sid|session|hash|sig|signature)=)[^&\s]+/giu, "$1<redacted>")
    .replace(/\b[A-Za-z0-9_=-]{72,}\b/gu, "<redacted-long-token>");
}

function normalizedSignature(errorText) {
  return redactSensitive(errorText)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[a-z0-9_-]{8,}\b/g, "<id>")
    .replace(/\d+/g, "0")
    .slice(0, 240);
}

function deterministicClassification({ errorText, track }) {
  const text = String(errorText || "");
  const source = sourceKey(track);

  if (/yandex direct stream is preview only|preview only/i.test(text)) {
    return {
      category: "yandex_preview_cookies",
      confidence: 0.98,
      action: "Refresh Yandex cookies and verify full-track access; keep preview guard enabled.",
    };
  }

  if (/music\.yandex|yandex/i.test(text) && /(captcha|anti.?bot|unauthorized|forbidden|403|401|session|cookies?)/i.test(text)) {
    return {
      category: "yandex_auth_or_antibot",
      confidence: 0.9,
      action: "Refresh Yandex cookies and check that the account has Music access.",
    };
  }

  if (
    /sign in to confirm|not a bot|po token|gvs po token|n challenge|only images are available|requested format is not available|http error 403/i.test(
      text
    )
  ) {
    return {
      category: "youtube_antibot_or_runtime",
      confidence: 0.95,
      action: "Check YouTube cookies, yt-dlp version, PO token need, and JS runtime in YTDLP_RUNTIME_PATH.",
    };
  }

  if (/vk/i.test(text) && /(cookies?|remixsid|login|unauth|forbidden|403|access|reload_audio)/i.test(text)) {
    return {
      category: "vk_auth_or_access",
      confidence: 0.88,
      action: "Refresh VK cookies and verify account access to the playlist.",
    };
  }

  if (/timeout|timed out|econnreset|enotfound|eai_again|network|socket|source-address|l2tp|etimedout/i.test(text)) {
    return {
      category: "network_or_l2tp",
      confidence: 0.86,
      action: "Check network route, L2TP source address, and temporary source availability.",
    };
  }

  if (/source stream closed before playback start|playback start timeout|source exited with error/i.test(text)) {
    return {
      category: "source_stream_failed",
      confidence: 0.75,
      action: "Retry source resolution; if repeated, inspect source-specific logs.",
    };
  }

  return {
    category: `${source}_unknown`,
    confidence: 0.45,
    action: "Inspect full playback logs and source health checks.",
  };
}

function isUnknownOrLowConfidence(diagnostic) {
  return Number(diagnostic?.confidence || 0) < 0.7 || String(diagnostic?.category || "").includes("unknown");
}

function withinGeminiHourlyBudget() {
  const maxPerHour = Math.max(0, Number(PLAYBACK_DIAGNOSTICS_GEMINI_MAX_PER_HOUR) || 0);
  if (maxPerHour <= 0) {
    return false;
  }

  const cutoff = Date.now() - 60 * 60_000;
  while (geminiHourlyCalls.length > 0 && geminiHourlyCalls[0] < cutoff) {
    geminiHourlyCalls.shift();
  }

  if (geminiHourlyCalls.length >= maxPerHour) {
    return false;
  }

  geminiHourlyCalls.push(Date.now());
  return true;
}

function shouldAskGemini(key, deterministic) {
  if (!PLAYBACK_DIAGNOSTICS_GEMINI_ENABLED || !GEMINI_API_KEY) {
    return false;
  }

  const mode = String(PLAYBACK_DIAGNOSTICS_GEMINI_MODE || "unknown_only").trim().toLowerCase();
  if (mode !== "all" && !isUnknownOrLowConfidence(deterministic)) {
    return false;
  }

  const cooldownMs = Math.max(60_000, Number(PLAYBACK_DIAGNOSTICS_GEMINI_COOLDOWN_MS) || 15 * 60_000);
  const lastAt = geminiCooldowns.get(key) || 0;
  if (Date.now() - lastAt < cooldownMs) {
    return false;
  }

  if (!withinGeminiHourlyBudget()) {
    return false;
  }

  geminiCooldowns.set(key, Date.now());
  return true;
}

function parseGeminiJson(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/\{[\s\S]*\}/u);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]);
    const category = trimText(parsed.category, 80);
    const action = trimText(parsed.action, 180);
    const confidence = Number(parsed.confidence);
    if (!category || !action || !Number.isFinite(confidence)) {
      return null;
    }

    return {
      category,
      confidence: Math.max(0, Math.min(1, confidence)),
      action,
    };
  } catch {
    return null;
  }
}

async function askGemini(context) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(2_000, Number(PLAYBACK_DIAGNOSTICS_GEMINI_TIMEOUT_MS) || 12_000)
  );

  const prompt = [
    "Classify this Discord music bot playback failure.",
    "Return only compact JSON with keys: category, confidence, action.",
    "Allowed categories: youtube_antibot_or_runtime, youtube_cookies, yandex_preview_cookies, yandex_auth_or_antibot, vk_auth_or_access, network_or_l2tp, source_stream_failed, unknown.",
    "Do not suggest code changes, deploys, or revealing secrets.",
    `Source: ${context.source}`,
    `Track: ${trimText(context.trackTitle, MAX_TRACK_CHARS)}`,
    `Error: ${trimText(context.errorText, MAX_ERROR_CHARS)}`,
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        GEMINI_MODEL
      )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 160,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error?.message || `Gemini HTTP ${response.status}`);
    }

    const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    return parseGeminiJson(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyPlaybackFailure({ error, track, guildId = "", queueLength = 0 } = {}) {
  const errorText = redactSensitive(error?.message || String(error || ""));
  const source = sourceKey(track);
  const deterministic = deterministicClassification({ errorText, track });
  const key = `${source}|${deterministic.category}|${normalizedSignature(errorText)}`;

  let gemini = null;
  if (shouldAskGemini(key, deterministic)) {
    try {
      gemini = await askGemini({
        source,
        trackTitle: track?.title || "",
        errorText,
      });
    } catch (diagnosticError) {
      gemini = {
        category: "diagnostic_unavailable",
        confidence: 0,
        action: trimText(diagnosticError.message, 160),
      };
    }
  }

  const chosen = gemini && gemini.category !== "diagnostic_unavailable" ? gemini : deterministic;
  return {
    source,
    guildId: String(guildId || ""),
    queueLength: Number(queueLength) || 0,
    trackTitle: trimText(track?.title || "", MAX_TRACK_CHARS),
    category: chosen.category,
    confidence: chosen.confidence,
    action: chosen.action,
    deterministicCategory: deterministic.category,
    geminiCategory: gemini?.category || "",
  };
}

function logPlaybackDiagnostic(diagnostic) {
  if (!diagnostic) {
    return;
  }

  const parts = [
    `source=${diagnostic.source}`,
    `category=${diagnostic.category}`,
    `confidence=${Number(diagnostic.confidence || 0).toFixed(2)}`,
    diagnostic.geminiCategory ? `gemini=${diagnostic.geminiCategory}` : "",
    diagnostic.deterministicCategory && diagnostic.deterministicCategory !== diagnostic.category
      ? `deterministic=${diagnostic.deterministicCategory}`
      : "",
    diagnostic.guildId ? `guild=${diagnostic.guildId}` : "",
    `queue=${diagnostic.queueLength}`,
    diagnostic.trackTitle ? `track="${diagnostic.trackTitle}"` : "",
    `action="${diagnostic.action}"`,
  ].filter(Boolean);

  console.warn(`[PlaybackDiagnostic] ${parts.join(" ")}`);
}

function reportPlaybackFailure(context) {
  classifyPlaybackFailure(context)
    .then(logPlaybackDiagnostic)
    .catch((error) => {
      console.warn(`[PlaybackDiagnostic] failed: ${redactSensitive(error.message)}`);
    });
}

module.exports = {
  classifyPlaybackFailure,
  logPlaybackDiagnostic,
  reportPlaybackFailure,
};
