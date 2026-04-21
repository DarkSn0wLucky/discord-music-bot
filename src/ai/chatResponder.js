const {
  AI_BATCH_WINDOW_MS,
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
const TYPING_INTERVAL_MS = 4000;
const MAX_BATCH_MESSAGES = 80;
const CONVO_NEAR_MS = 25_000;

const pendingBatchesByChannel = new Map();
const generationQueueByChannel = new Map();

const STOP_WORDS = new Set([
  "это",
  "так",
  "как",
  "что",
  "чтобы",
  "чтоб",
  "если",
  "или",
  "для",
  "его",
  "ее",
  "она",
  "они",
  "мы",
  "вы",
  "тебя",
  "тебе",
  "меня",
  "мне",
  "твой",
  "твоя",
  "ваш",
  "ваша",
  "мой",
  "моя",
  "and",
  "the",
  "you",
  "your",
  "with",
  "this",
  "that",
  "from",
]);

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

function tokenizeForTopic(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^0-9a-zа-яё]+/gi, " ");

  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token));

  return Array.from(new Set(tokens));
}

function overlapCount(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) {
    return 0;
  }

  const smaller = tokensA.length <= tokensB.length ? tokensA : tokensB;
  const largerSet = new Set(tokensA.length <= tokensB.length ? tokensB : tokensA);
  let count = 0;
  for (const token of smaller) {
    if (largerSet.has(token)) {
      count += 1;
    }
  }
  return count;
}

function buildPairKey(leftUserId, rightUserId) {
  return leftUserId < rightUserId
    ? `${leftUserId}|${rightUserId}`
    : `${rightUserId}|${leftUserId}`;
}

function getPairStats(pairMap, leftUserId, rightUserId) {
  const key = buildPairKey(leftUserId, rightUserId);
  const existing = pairMap.get(key);
  if (existing) {
    return existing;
  }

  const stats = {
    leftUserId: leftUserId < rightUserId ? leftUserId : rightUserId,
    rightUserId: leftUserId < rightUserId ? rightUserId : leftUserId,
    turnLinks: 0,
    mentionLinks: 0,
    replyLinks: 0,
    tokenOverlapMax: 0,
  };
  pairMap.set(key, stats);
  return stats;
}

function shouldConnectUsers(stats) {
  if (!stats) {
    return false;
  }

  if (stats.replyLinks > 0 || stats.mentionLinks > 0) {
    return true;
  }
  if (stats.tokenOverlapMax >= 2) {
    return true;
  }
  if (stats.tokenOverlapMax >= 1 && stats.turnLinks >= 1) {
    return true;
  }
  if (stats.turnLinks >= 3) {
    return true;
  }

  return false;
}

function buildConversationGroups(entries) {
  const decorated = entries
    .filter((entry) => entry?.userId)
    .map((entry, index) => ({
      ...entry,
      index,
      timestampMs: Number(entry.timestampMs || 0),
      tokens: tokenizeForTopic(entry.text),
      mentionUserIds: Array.isArray(entry.mentionUserIds) ? entry.mentionUserIds : [],
      replyToMessageId: String(entry.replyToMessageId || ""),
      messageId: String(entry.messageId || ""),
    }));

  const participants = Array.from(new Set(decorated.map((entry) => entry.userId)));
  if (participants.length === 0) {
    return [];
  }

  const pairStatsMap = new Map();
  for (let i = 0; i < decorated.length; i += 1) {
    const left = decorated[i];
    for (let j = i + 1; j < decorated.length; j += 1) {
      const right = decorated[j];
      if (!left.userId || !right.userId || left.userId === right.userId) {
        continue;
      }

      const stats = getPairStats(pairStatsMap, left.userId, right.userId);
      const overlap = overlapCount(left.tokens, right.tokens);
      if (overlap > stats.tokenOverlapMax) {
        stats.tokenOverlapMax = overlap;
      }

      const msDiff = Math.abs(left.timestampMs - right.timestampMs);
      if (j === i + 1 && msDiff <= CONVO_NEAR_MS) {
        stats.turnLinks += 1;
      }

      if (left.mentionUserIds.includes(right.userId) || right.mentionUserIds.includes(left.userId)) {
        stats.mentionLinks += 1;
      }

      if (left.replyToMessageId && left.replyToMessageId === right.messageId) {
        stats.replyLinks += 1;
      }
      if (right.replyToMessageId && right.replyToMessageId === left.messageId) {
        stats.replyLinks += 1;
      }
    }
  }

  const adjacency = new Map(participants.map((userId) => [userId, new Set()]));
  for (const stats of pairStatsMap.values()) {
    if (!shouldConnectUsers(stats)) {
      continue;
    }
    adjacency.get(stats.leftUserId)?.add(stats.rightUserId);
    adjacency.get(stats.rightUserId)?.add(stats.leftUserId);
  }

  const visited = new Set();
  const components = [];
  for (const userId of participants) {
    if (visited.has(userId)) {
      continue;
    }

    const stack = [userId];
    visited.add(userId);
    const component = [];
    while (stack.length > 0) {
      const current = stack.pop();
      component.push(current);
      for (const next of adjacency.get(current) || []) {
        if (visited.has(next)) {
          continue;
        }
        visited.add(next);
        stack.push(next);
      }
    }

    components.push(component);
  }

  return components;
}

function buildGroupPrompt(channelName, entries) {
  const lines = entries
    .slice(0, MAX_BATCH_MESSAGES)
    .map((entry, index) => `${index + 1}. ${entry.author}: ${entry.text}`);
  const associationBlock = buildAssociationPrompt(entries);

  const promptParts = [
    `Канал: #${channelName || "чатик-🦍"}.`,
    "Сводка сообщений за последние 60 секунд:",
    ...lines,
  ];

  if (associationBlock) {
    promptParts.push("");
    promptParts.push(associationBlock);
  }

  promptParts.push("");
  promptParts.push("Ответь одним сообщением в стиле персонажа с короткой реакцией на эту группу сообщений.");
  return promptParts.join("\n");
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
                "Ты персонаж: дерзкий парень 16 лет с дворовым вайбом, колкий и ироничный. Пиши по-русски, коротко (1-4 предложения), реагируй на общий вайб сводки. Допускается резкий тон и уличный сленг, но без реальных угроз насилия, без травли и без призывов к вреду.",
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

async function sendGroupedReplies(channel, entries) {
  if (!entries.length) {
    return;
  }

  const uniqueUsers = Array.from(new Set(entries.map((entry) => entry.userId).filter(Boolean)));

  const sortedEntries = entries
    .filter((entry) => entry?.userId)
    .sort((left, right) => Number(left.timestampMs || 0) - Number(right.timestampMs || 0));

  const groups = buildConversationGroups(sortedEntries);
  if (groups.length === 0) {
    return;
  }

  console.log(
    `[AI] groupedReplies channel=${channel.id} participants=${uniqueUsers.length} groups=${groups.length}`
  );

  let typingTimer = null;
  try {
    await channel.sendTyping().catch(() => null);
    typingTimer = setInterval(() => {
      channel.sendTyping().catch(() => null);
    }, TYPING_INTERVAL_MS);

    for (const groupUserIds of groups) {
      const groupSet = new Set(groupUserIds);
      const groupEntries = sortedEntries.filter((entry) => groupSet.has(entry.userId));
      if (groupEntries.length === 0) {
        continue;
      }

      const prompt = buildGroupPrompt(channel.name, groupEntries);
      const generation = await fetchGeminiBatchReply(prompt);
      if (generation.finishReason && generation.finishReason !== "STOP") {
        console.warn(
          `[AI] finishReason=${generation.finishReason} channel=${channel.id} entries=${groupEntries.length}`
        );
      }
      if (generation.promptFeedback?.blockReason) {
        console.warn(
          `[AI] prompt blocked reason=${generation.promptFeedback.blockReason} channel=${channel.id}`
        );
      }

      const tags = groupUserIds.filter(Boolean).map((userId) => `<@${userId}>`).join(" ");
      const replyBody = trimText(
        sanitizeDiscordMentions(generation.text),
        Math.min(AI_MAX_OUTPUT_CHARS, DISCORD_MESSAGE_LIMIT)
      );
      if (!replyBody) {
        continue;
      }

      const composed = tags ? `${tags} ${replyBody}` : replyBody;
      const content = trimText(composed, DISCORD_MESSAGE_LIMIT);

      await channel.send({
        content,
        allowedMentions: {
          parse: [],
          users: groupUserIds.filter(Boolean),
        },
      });
    }
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
    await sendGroupedReplies(channel, snapshot);
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
    messageId: message.id || "",
    timestampMs: Number(message.createdTimestamp || Date.now()),
    replyToMessageId: message.reference?.messageId || "",
    mentionUserIds: Array.from(message.mentions?.users?.keys?.() || []),
    userId: message.author?.id || "",
    username: message.author?.username || "",
    globalName: message.author?.globalName || "",
    displayName: message.member?.displayName || "",
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
