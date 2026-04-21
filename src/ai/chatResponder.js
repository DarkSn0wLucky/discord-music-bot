const {
  AI_BATCH_WINDOW_MS,
  AI_CHAT_CHANNEL_ID,
  AI_CHAT_CHANNEL_NAME,
  AI_CHAT_ENABLED,
  AI_MAX_OUTPUT_CHARS,
  AI_MAX_PROMPT_CHARS,
  AI_REQUEST_TIMEOUT_MS,
  AI_TEMPERATURE,
  AI_TOP_P,
  GEMINI_API_KEY,
  GEMINI_MODEL,
} = require("../config");

const DISCORD_MESSAGE_LIMIT = 1900;
const TYPING_INTERVAL_MS = 4000;
const MAX_BATCH_MESSAGES = 80;

const pendingBatchesByChannel = new Map();
const generationQueueByChannel = new Map();

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

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeChannelName(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function sanitizeDiscordMentions(value) {
  return String(value || "")
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere");
}

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function isLikelyUnfinishedReply(value) {
  const text = String(value || "").trim();
  if (!text) {
    return true;
  }

  const words = countWords(text);
  if (words < 5) {
    return true;
  }

  if (/[,:;\-–—]$/.test(text)) {
    return true;
  }

  const lastWord = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .pop();
  const danglingWords = new Set(["и", "или", "но", "а", "что", "чтоб", "чтобы", "как", "ты"]);
  return danglingWords.has(lastWord);
}

function isAiEnabled() {
  return Boolean(AI_CHAT_ENABLED && GEMINI_API_KEY);
}

function isTargetChannel(channel) {
  if (!channel) {
    return false;
  }

  if (AI_CHAT_CHANNEL_ID) {
    return channel.id === AI_CHAT_CHANNEL_ID;
  }

  const expected = normalizeChannelName(AI_CHAT_CHANNEL_NAME);
  const actual = normalizeChannelName(channel.name);
  return Boolean(expected && actual && expected === actual);
}

function extractMessageText(message) {
  const text = trimText(message.content, AI_MAX_PROMPT_CHARS);
  if (text) {
    return text;
  }

  const attachmentCount = Number(message.attachments?.size || 0);
  if (attachmentCount > 0) {
    return `[вложений: ${attachmentCount}]`;
  }

  return "";
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

  if (!isTargetChannel(message.channel)) {
    return false;
  }

  return Boolean(extractMessageText(message));
}

function getOrCreateBatchState(channelId) {
  const existing = pendingBatchesByChannel.get(channelId);
  if (existing) {
    return existing;
  }

  const state = {
    timer: null,
    entries: [],
  };
  pendingBatchesByChannel.set(channelId, state);
  return state;
}

function enqueuePerChannel(channelId, task) {
  const previous = generationQueueByChannel.get(channelId) || Promise.resolve();
  const next = previous
    .catch(() => null)
    .then(task)
    .finally(() => {
      if (generationQueueByChannel.get(channelId) === next) {
        generationQueueByChannel.delete(channelId);
      }
    });

  generationQueueByChannel.set(channelId, next);
  return next;
}

function buildBatchPrompt(channelName, entries) {
  const lines = entries
    .slice(0, MAX_BATCH_MESSAGES)
    .map((entry, index) => `${index + 1}. ${entry.author}: ${entry.text}`);

  return [
    `Канал: #${channelName || "чатик-🦍"}.`,
    "Сводка сообщений за последние 60 секунд:",
    ...lines,
    "",
    "Ответь одним сообщением в стиле персонажа.",
  ].join("\n");
}

async function fetchGeminiBatchReply(prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1500, AI_REQUEST_TIMEOUT_MS));

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "Ты персонаж: дерзкий парень 16 лет с дворовым вайбом, колкий и ироничный. Пиши по-русски, коротко (1-4 предложения), реагируй на общий вайб сводки. Ответ всегда должен быть законченным, без обрыва фразы. Допускается резкий тон и уличный сленг, но без реальных угроз насилия, без травли и без призывов к вреду.",
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: clamp(AI_TEMPERATURE, 0, 2, 0.9),
          topP: clamp(AI_TOP_P, 0, 1, 0.95),
          maxOutputTokens: 260,
        },
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = payload?.error?.message || `${response.status} ${response.statusText}`;
      throw new Error(errorMessage);
    }

    const text = (payload?.candidates?.[0]?.content?.parts || [])
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

async function generateBatchReply(channel, entries) {
  if (!entries.length) {
    return;
  }

  const prompt = buildBatchPrompt(channel.name, entries);
  let typingTimer = null;
  try {
    await channel.sendTyping().catch(() => null);
    typingTimer = setInterval(() => {
      channel.sendTyping().catch(() => null);
    }, TYPING_INTERVAL_MS);

    let rawReply = await fetchGeminiBatchReply(prompt);
    if (isLikelyUnfinishedReply(rawReply)) {
      rawReply = await fetchGeminiBatchReply(
        `${prompt}\n\nТребование: дай завершённый, цельный ответ без обрыва в конце.`
      );
    }

    const reply = trimText(sanitizeDiscordMentions(rawReply), Math.min(AI_MAX_OUTPUT_CHARS, DISCORD_MESSAGE_LIMIT));
    if (!reply) {
      return;
    }

    await channel.send({ content: reply });
  } catch (error) {
    console.warn(`[AI] Batch reply failed in #${channel.id}: ${error.message || error}`);
  } finally {
    if (typingTimer) {
      clearInterval(typingTimer);
    }
  }
}

function flushBatch(channel) {
  const channelId = channel.id;
  const state = pendingBatchesByChannel.get(channelId);
  if (!state) {
    return;
  }

  const snapshot = state.entries.slice(0, MAX_BATCH_MESSAGES);
  state.entries = [];
  state.timer = null;
  if (snapshot.length === 0) {
    return;
  }

  enqueuePerChannel(channelId, async () => {
    await generateBatchReply(channel, snapshot);
  }).catch(() => null);
}

async function handleAiMessage(message) {
  if (!shouldHandleMessage(message)) {
    return;
  }

  const text = extractMessageText(message);
  if (!text) {
    return;
  }

  const state = getOrCreateBatchState(message.channelId);
  state.entries.push({
    author: trimText(message.member?.displayName || message.author?.username || "user", 64),
    text,
  });
  if (state.entries.length > MAX_BATCH_MESSAGES) {
    state.entries = state.entries.slice(-MAX_BATCH_MESSAGES);
  }

  if (!state.timer) {
    state.timer = setTimeout(() => flushBatch(message.channel), Math.max(5_000, AI_BATCH_WINDOW_MS));
  }
}

module.exports = {
  handleAiMessage,
};
