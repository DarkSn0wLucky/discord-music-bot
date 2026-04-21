const {
  AI_ALLOWED_CHANNEL_IDS,
  AI_CHAT_ENABLED,
  AI_COOLDOWN_MS,
  AI_MAX_CONTEXT_MESSAGES,
  AI_MAX_OUTPUT_CHARS,
  AI_MAX_PROMPT_CHARS,
  AI_REQUEST_TIMEOUT_MS,
  AI_TEMPERATURE,
  AI_TOP_P,
  GEMINI_API_KEY,
  GEMINI_MODEL,
} = require("../config");

const HISTORY_TTL_MS = 20 * 60_000;
const TYPING_INTERVAL_MS = 4000;
const DISCORD_MESSAGE_LIMIT = 1900;

const requestQueueByChannel = new Map();
const historyByChannel = new Map();
const cooldownUntilByChannel = new Map();

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function trimText(value, maxLength) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) {
    return "";
  }
  if (raw.length <= maxLength) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sanitizeDiscordMentions(value) {
  return String(value || "")
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere");
}

function pruneHistory(channelId) {
  const now = Date.now();
  const history = historyByChannel.get(channelId) || [];
  const pruned = history.filter((entry) => now - Number(entry.at || 0) <= HISTORY_TTL_MS);
  if (pruned.length > 0) {
    historyByChannel.set(channelId, pruned);
  } else {
    historyByChannel.delete(channelId);
  }
}

function getHistory(channelId) {
  pruneHistory(channelId);
  return historyByChannel.get(channelId) || [];
}

function pushHistory(channelId, role, text) {
  const history = getHistory(channelId);
  history.push({
    role,
    text: trimText(text, AI_MAX_PROMPT_CHARS * 2),
    at: Date.now(),
  });
  const maxItems = Math.max(2, AI_MAX_CONTEXT_MESSAGES * 2);
  const next = history.slice(-maxItems);
  historyByChannel.set(channelId, next);
}

function withChannelQueue(channelId, task) {
  const previous = requestQueueByChannel.get(channelId) || Promise.resolve();
  const next = previous
    .catch(() => null)
    .then(task)
    .finally(() => {
      if (requestQueueByChannel.get(channelId) === next) {
        requestQueueByChannel.delete(channelId);
      }
    });

  requestQueueByChannel.set(channelId, next);
  return next;
}

function isAiEnabled() {
  return Boolean(AI_CHAT_ENABLED && GEMINI_API_KEY);
}

function shouldHandleMessage(message) {
  if (!isAiEnabled()) {
    return false;
  }

  if (!message || !message.inGuild()) {
    return false;
  }

  if (message.author?.bot || message.webhookId) {
    return false;
  }

  if (AI_ALLOWED_CHANNEL_IDS.length > 0 && !AI_ALLOWED_CHANNEL_IDS.includes(message.channelId)) {
    return false;
  }

  const content = String(message.content || "").trim();
  if (!content) {
    return false;
  }

  return true;
}

async function fetchGeminiReply(prompt, contextEntries) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const contents = contextEntries.map((entry) => ({
    role: entry.role === "assistant" ? "model" : "user",
    parts: [{ text: entry.text }],
  }));
  contents.push({
    role: "user",
    parts: [{ text: prompt }],
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, AI_REQUEST_TIMEOUT_MS));

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are a playful Discord companion. Keep replies short (1-3 sentences), friendly, and useful. Use the same language as the user message.",
            },
          ],
        },
        contents,
        generationConfig: {
          temperature: clamp(AI_TEMPERATURE, 0, 2, 0.9),
          topP: clamp(AI_TOP_P, 0, 1, 0.95),
          maxOutputTokens: 220,
        },
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = payload?.error?.message || `${response.status} ${response.statusText}`;
      throw new Error(errorMessage);
    }

    const parts = payload?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Empty Gemini response");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPromptFromMessage(message) {
  const username = message.member?.displayName || message.author?.username || "user";
  const content = trimText(message.content, AI_MAX_PROMPT_CHARS);
  return `${username}: ${content}`;
}

async function processAiReply(message) {
  const now = Date.now();
  const cooldownUntil = Number(cooldownUntilByChannel.get(message.channelId) || 0);
  if (cooldownUntil > now) {
    return;
  }

  cooldownUntilByChannel.set(message.channelId, now + Math.max(0, AI_COOLDOWN_MS));

  const prompt = buildPromptFromMessage(message);
  if (!prompt) {
    return;
  }

  const contextEntries = getHistory(message.channelId).slice(-Math.max(0, AI_MAX_CONTEXT_MESSAGES * 2));
  let typingTimer = null;
  try {
    await message.channel.sendTyping().catch(() => null);
    typingTimer = setInterval(() => {
      message.channel.sendTyping().catch(() => null);
    }, TYPING_INTERVAL_MS);

    const rawReply = await fetchGeminiReply(prompt, contextEntries);
    const reply = trimText(sanitizeDiscordMentions(rawReply), Math.min(AI_MAX_OUTPUT_CHARS, DISCORD_MESSAGE_LIMIT));

    if (!reply) {
      return;
    }

    await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
    pushHistory(message.channelId, "user", prompt);
    pushHistory(message.channelId, "assistant", reply);
  } catch (error) {
    console.warn(`[AI] Reply failed in #${message.channelId}: ${error.message || error}`);
  } finally {
    if (typingTimer) {
      clearInterval(typingTimer);
    }
  }
}

async function handleAiMessage(message) {
  if (!shouldHandleMessage(message)) {
    return;
  }

  await withChannelQueue(message.channelId, async () => {
    await processAiReply(message);
  });
}

module.exports = {
  handleAiMessage,
};

