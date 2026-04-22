const {
  AI_CHAT_CHANNEL_ID,
  AI_CHAT_CHANNEL_NAME,
  AI_CHAT_ENABLED,
  AI_GEMINI_MAX_OUTPUT_TOKENS,
  AI_MAX_OUTPUT_CHARS,
  AI_MAX_PROMPT_CHARS,
  AI_REQUEST_TIMEOUT_MS,
  AI_TEMPERATURE,
  AI_TOP_P,
  GEMINI_API_KEY,
  GEMINI_MODEL,
} = require("../config");
const { buildAssociationPrompt } = require("./personAssociations");

const DISCORD_MESSAGE_LIMIT = 1900;
const CONTEXT_TARGET_MESSAGES = 10;
const WINDOW_DURATION_MS = 5 * 60_000;
const TYPING_INTERVAL_MS = 4000;
const MAX_CONTEXT_MESSAGES = CONTEXT_TARGET_MESSAGES;
const MAX_WINDOW_MESSAGES = 150;

const stateByChannel = new Map();
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
    return `[attachments: ${attachmentCount}]`;
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

function getOrCreateState(channelId) {
  const existing = stateByChannel.get(channelId);
  if (existing) {
    return existing;
  }

  const state = {
    humanCountSinceBot: 0,
    recentContext: [],
    readyForWindow: false,
    activeWindow: null,
    awaitingBotReply: false,
  };

  stateByChannel.set(channelId, state);
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

function buildEntry(message, text) {
  return {
    messageId: message.id || "",
    timestampMs: Number(message.createdTimestamp || Date.now()),
    userId: message.author?.id || "",
    username: message.author?.username || "",
    globalName: message.author?.globalName || "",
    displayName: message.member?.displayName || "",
    author: trimText(message.member?.displayName || message.author?.username || "user", 64),
    text,
  };
}

function appendToRecentContext(state, entry) {
  state.recentContext.push(entry);
  if (state.recentContext.length > MAX_CONTEXT_MESSAGES) {
    state.recentContext = state.recentContext.slice(-MAX_CONTEXT_MESSAGES);
  }
}

function buildPrompt(channelName, contextEntries, windowEntries) {
  const contextLines = contextEntries.map((entry, index) => `${index + 1}. ${entry.author}: ${entry.text}`);
  const windowLines = windowEntries.map((entry, index) => `${index + 1}. ${entry.author}: ${entry.text}`);
  const associationBlock = buildAssociationPrompt([...contextEntries, ...windowEntries]);

  const parts = [
    `Канал: #${channelName || "чатик-🦍"}.`,
    "Контекст (последние 10 сообщений ДО окна):",
    ...(contextLines.length > 0 ? contextLines : ["(контекст пуст)"]),
    "",
    "Сообщения за окно 5 минут:",
    ...(windowLines.length > 0 ? windowLines : ["(за окно нет сообщений)"]),
  ];

  if (associationBlock) {
    parts.push("");
    parts.push(associationBlock);
  }

  parts.push("");
  parts.push("Ответь ОДНИМ сообщением в стиле персонажа. 1-4 предложения, по-русски, реакция только на сообщения окна, но с учетом контекста.");

  return parts.join("\n");
}

async function fetchGeminiReply(prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

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
                "Ты персонаж: дерзкий парень 16 лет с дворовым вайбом, колкий и ироничный. Пиши по-русски, коротко (1-4 предложения), реагируй по сути. Допускается резкий сленг, но без реальных угроз, призывов к вреду или травли.",
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
          maxOutputTokens: clamp(AI_GEMINI_MAX_OUTPUT_TOKENS, 256, 8192, 1024),
        },
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = payload?.error?.message || `${response.status} ${response.statusText}`;
      throw new Error(errorMessage);
    }

    const candidate = payload?.candidates?.[0] || {};
    const text = (candidate?.content?.parts || [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Empty Gemini response");
    }

    return {
      text,
      finishReason: String(candidate?.finishReason || ""),
      promptFeedback: payload?.promptFeedback || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function resetCycle(state) {
  state.humanCountSinceBot = 0;
  state.recentContext = [];
  state.readyForWindow = false;
  state.activeWindow = null;
  state.awaitingBotReply = false;
}

async function sendWindowReply(channel, contextEntries, windowEntries, participantIds, state) {
  if (!windowEntries.length) {
    resetCycle(state);
    return;
  }

  let typingTimer = null;
  try {
    await channel.sendTyping().catch(() => null);
    typingTimer = setInterval(() => {
      channel.sendTyping().catch(() => null);
    }, TYPING_INTERVAL_MS);

    const prompt = buildPrompt(channel.name, contextEntries, windowEntries);
    const generation = await fetchGeminiReply(prompt);

    if (generation.finishReason && generation.finishReason !== "STOP") {
      console.warn(`[AI] finishReason=${generation.finishReason} channel=${channel.id}`);
    }

    if (generation.promptFeedback?.blockReason) {
      console.warn(`[AI] prompt blocked reason=${generation.promptFeedback.blockReason} channel=${channel.id}`);
    }

    const tags = participantIds.map((userId) => `<@${userId}>`).join(" ");
    const replyBody = trimText(
      sanitizeDiscordMentions(generation.text),
      Math.min(AI_MAX_OUTPUT_CHARS, DISCORD_MESSAGE_LIMIT)
    );

    if (!replyBody) {
      resetCycle(state);
      return;
    }

    const composed = tags ? `${tags} ${replyBody}` : replyBody;
    const content = trimText(composed, DISCORD_MESSAGE_LIMIT);

    await channel.send({
      content,
      allowedMentions: {
        parse: [],
        users: participantIds,
      },
    });

    resetCycle(state);
  } catch (error) {
    console.warn(`[AI] Reply failed in #${channel.id}: ${error.message || error}`);
    resetCycle(state);
  } finally {
    if (typingTimer) {
      clearInterval(typingTimer);
    }
  }
}

function flushWindow(channel) {
  const state = stateByChannel.get(channel.id);
  if (!state?.activeWindow) {
    return;
  }

  const window = state.activeWindow;
  if (window.timer) {
    clearTimeout(window.timer);
  }

  state.activeWindow = null;
  state.awaitingBotReply = true;

  const contextSnapshot = window.startContext.slice(-MAX_CONTEXT_MESSAGES);
  const windowSnapshot = window.entries.slice(0, MAX_WINDOW_MESSAGES);
  const participantIds = Array.from(window.participantIds).filter(Boolean);

  enqueuePerChannel(channel.id, async () => {
    await sendWindowReply(channel, contextSnapshot, windowSnapshot, participantIds, state);
  }).catch(() => {
    resetCycle(state);
  });
}

function startWindow(channel, state, firstEntry) {
  const activeWindow = {
    startContext: state.recentContext.slice(-MAX_CONTEXT_MESSAGES),
    entries: [firstEntry],
    participantIds: new Set(firstEntry.userId ? [firstEntry.userId] : []),
    timer: null,
  };

  activeWindow.timer = setTimeout(() => flushWindow(channel), WINDOW_DURATION_MS);

  state.activeWindow = activeWindow;
  state.readyForWindow = false;

  console.log(
    `[AI] windowStarted channel=${channel.id} context=${activeWindow.startContext.length} firstUser=${firstEntry.userId}`
  );
}

async function handleAiMessage(message) {
  if (!shouldHandleMessage(message)) {
    return;
  }

  const text = extractMessageText(message);
  if (!text) {
    return;
  }

  const state = getOrCreateState(message.channelId);

  if (state.awaitingBotReply) {
    return;
  }

  const entry = buildEntry(message, text);

  if (state.activeWindow) {
    state.activeWindow.entries.push(entry);
    if (state.activeWindow.entries.length > MAX_WINDOW_MESSAGES) {
      state.activeWindow.entries = state.activeWindow.entries.slice(-MAX_WINDOW_MESSAGES);
    }

    if (entry.userId) {
      state.activeWindow.participantIds.add(entry.userId);
    }

    return;
  }

  if (state.readyForWindow) {
    startWindow(message.channel, state, entry);
    return;
  }

  appendToRecentContext(state, entry);
  state.humanCountSinceBot += 1;

  if (state.humanCountSinceBot >= CONTEXT_TARGET_MESSAGES) {
    state.readyForWindow = true;
    console.log(`[AI] readyForWindow channel=${message.channelId} count=${state.humanCountSinceBot}`);
  }
}

module.exports = {
  handleAiMessage,
};
