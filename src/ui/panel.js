const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { EMBED_COLOR_HEX, PROGRESS_FRAME_EMOJIS } = require("../config");
const { formatDuration, loopLabel, safeLinkText, truncate } = require("../utils/format");

const BUTTON_IDS = {
  toggle: "music:toggle",
  skip: "music:skip",
  stop: "music:stop",
  shuffle: "music:shuffle",
  loop: "music:loop",
  queueOpen: "music:queue:open",
  quickPlay: "music:quickplay",
};

const SOURCE_EMOJIS = {
  youtube: "<:youtube_cutout_alpha:1500386470261817364>",
  vk: "<:vk_cutout_alpha_smooth2:1500386453136609400>",
  yandex: "<:star_cutout_alpha:1500386482706448384>",
};
const PROGRESS_FRAME_STEP_MS = 5_000;

function detectSourceKey(track) {
  const raw = `${String(track?.catalogSource || "")} ${String(track?.source || "")}`.toLowerCase();
  if (raw.includes("yandex")) return "yandex";
  if (raw.includes("vk")) return "vk";
  if (raw.includes("youtube")) return "youtube";
  if (raw.includes("soundcloud")) return "soundcloud";
  if (raw.includes("spotify")) return "spotify";
  if (raw.includes("deezer")) return "deezer";
  return "unknown";
}

function sourceLabel(track) {
  const key = detectSourceKey(track);
  const prefix = SOURCE_EMOJIS[key] ? `${SOURCE_EMOJIS[key]} ` : "";
  if (key === "youtube") return `${prefix}YouTube`;
  if (key === "yandex") return `${prefix}Yandex Music`;
  if (key === "vk") return `${prefix}VK Music`;
  if (key === "soundcloud") return "SoundCloud";
  if (key === "spotify") return "Spotify";
  if (key === "deezer") return "Deezer";
  return safeLinkText(track?.source || "Источник не указан");
}

function compactSourceName(track) {
  const key = detectSourceKey(track);
  const prefix = SOURCE_EMOJIS[key] ? `${SOURCE_EMOJIS[key]} ` : "";
  if (key === "youtube") return `${prefix}YouTube`;
  if (key === "yandex") return `${prefix}Yandex`;
  if (key === "vk") return `${prefix}VK`;
  return sourceLabel(track);
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function trackDisplayUrl(track) {
  const url = firstText(track?.webpageUrl, track?.webpage_url, track?.displayUrl, track?.originalUrl, track?.original_url, track?.url);
  return isHttpUrl(url) ? url : "";
}

function playlistDisplayUrl(track) {
  const url = firstText(track?.sourcePlaylistUrl, track?.playlistUrl, track?.playlist_url);
  return isHttpUrl(url) ? url : "";
}

function playlistDisplayTitle(track) {
  return truncate(safeLinkText(firstText(track?.sourcePlaylistTitle, track?.playlistTitle, track?.playlist_title, "плейлист")), 48);
}

function authorDisplayUrl(track) {
  const directUrl = firstText(track?.authorUrl, track?.channelUrl, track?.channel_url, track?.uploaderUrl, track?.uploader_url);
  if (isHttpUrl(directUrl)) {
    return directUrl;
  }

  const author = firstText(track?.artist, track?.author);
  if (!author) {
    return "";
  }

  const sourceKey = detectSourceKey(track);
  const encoded = encodeURIComponent(author);
  if (sourceKey === "yandex") {
    return `https://music.yandex.ru/search?text=${encoded}`;
  }
  if (sourceKey === "vk") {
    return `https://vk.com/audio?q=${encoded}`;
  }
  if (sourceKey === "youtube") {
    return `https://www.youtube.com/results?search_query=${encoded}`;
  }

  return "";
}

function markdownLink(label, url) {
  const text = safeLinkText(label);
  return isHttpUrl(url) ? `[${text}](${url})` : text;
}

function subtextLine(text) {
  return `-# ${String(text || "").trim()}`;
}

function noticeMetaText(actorText) {
  const timestamp = `<t:${Math.floor(Date.now() / 1000)}:t>`;
  const actor = String(actorText || "").trim();
  return [`Сегодня, в ${timestamp}`, actor].filter(Boolean).join(" · ");
}

function noticeMetaLine(actorText) {
  return subtextLine(noticeMetaText(actorText));
}

function compactTitle(track) {
  const rawTitle = safeLinkText(track?.title);
  const author = firstText(track?.artist, track?.author);
  let title = rawTitle
    .replace(/\s*\((?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|lyric video|visualizer|hd video)\)\s*$/i, "")
    .replace(/\s*\[(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|lyric video|visualizer|hd video)\]\s*$/i, "")
    .trim();

  if (author) {
    const escapedAuthor = author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title
      .replace(new RegExp(`^${escapedAuthor}\\s+[-–—]\\s+`, "i"), "")
      .replace(new RegExp(`\\s+[-–—]\\s+${escapedAuthor}$`, "i"), "")
      .trim();
  }

  return title || rawTitle;
}

function trackTitleLine(track, maxLength = 90) {
  const title = truncate(compactTitle(track), maxLength);
  return markdownLink(title, trackDisplayUrl(track));
}

function trackTitleText(track, maxLength = 90) {
  return truncate(compactTitle(track), maxLength) || "Без названия";
}

function setTrackTitle(embed, track, maxLength = 90) {
  embed.setTitle(trackTitleText(track, maxLength));
  const url = trackDisplayUrl(track);
  if (url) {
    embed.setURL(url);
  }
  return embed;
}

function trackAuthorLine(track, maxLength = 90) {
  const author = truncate(safeLinkText(track?.artist || track?.author || track?.source || ""), maxLength);
  if (!author) {
    return "";
  }
  return markdownLink(author, authorDisplayUrl(track));
}

function trackRequesterMention(track) {
  if (track?.requestedById) {
    return `<@${track.requestedById}>`;
  }

  return compactActorLabel(firstText(track?.requestedByDisplayName, track?.requestedByTag, track?.requestedById, "unknown"));
}

function compactActorLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const mention = raw.match(/^<@!?(\d+)>$/);
  if (mention) {
    return `@${mention[1]}`;
  }

  const withoutDiscriminator = raw.replace(/#0{1,4}$/u, "").replace(/#\d{4}$/u, "").trim();
  const label = safeLinkText(withoutDiscriminator || raw);
  return label.startsWith("@") ? label : `@${label}`;
}

function buildActorFooter(actionText, actorText, track) {
  const action = String(actionText || "Запросил").trim();
  const actor = compactActorLabel(
    firstText(track?.requestedByDisplayName, actorText, track?.requestedByTag, track?.requestedById)
  );
  return [action, actor].filter(Boolean).join(" ");
}

function frameProgressBar(elapsedMs, totalMs) {
  const frames = Array.isArray(PROGRESS_FRAME_EMOJIS) ? PROGRESS_FRAME_EMOJIS.filter(Boolean) : [];
  if (frames.length < 2 || !Number.isFinite(totalMs) || totalMs <= 0) {
    return "";
  }

  const ratio = Math.max(0, Math.min(1, Number(elapsedMs || 0) / totalMs));
  const index = Math.max(0, Math.min(frames.length - 1, Math.round(ratio * (frames.length - 1))));
  return frames[index];
}

function steppedProgressMs(elapsedMs, totalMs) {
  const safeElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  const safeTotalMs = Number(totalMs) > 0 ? Number(totalMs) : 0;
  if (safeTotalMs > 0 && safeElapsedMs >= safeTotalMs) {
    return safeTotalMs;
  }
  return Math.floor(safeElapsedMs / PROGRESS_FRAME_STEP_MS) * PROGRESS_FRAME_STEP_MS;
}

function visualProgressBar(elapsedMs, totalMs, size = 28) {
  const emojiFrame = frameProgressBar(elapsedMs, totalMs);
  if (emojiFrame) {
    return emojiFrame;
  }

  const safeSize = Math.max(8, Number(size) || 18);
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return `${"━".repeat(Math.max(0, safeSize - 1))}●`;
  }

  const ratio = Math.max(0, Math.min(1, Number(elapsedMs || 0) / totalMs));
  const markerIndex =
    elapsedMs >= totalMs
      ? safeSize - 1
      : Math.max(0, Math.min(safeSize - 1, Math.floor(ratio * (safeSize - 1))));

  return Array.from({ length: safeSize }, (_, index) => {
    if (index === markerIndex) {
      return "●";
    }
    return "━";
  }).join("");
}

function buildQueuePreview(player, limit = 3) {
  const tracks = Array.isArray(player?.queue) ? player.queue.slice(0, limit) : [];
  if (tracks.length === 0) {
    return "Пусто";
  }

  return tracks
    .map((track, index) => `${index + 1}. ${trackTitleLine(track, 46)}`)
    .join("\n");
}

function buildPlayerEmbed(player) {
  if (!player.currentTrack) {
    return new EmbedBuilder()
      .setColor(EMBED_COLOR_HEX)
      .setTitle("Музыкальный плеер")
      .setDescription("Очередь пуста. Включи музыку кнопкой ниже.");
  }

  const track = player.currentTrack;
  const playbackDurationMs = Number(player.player?.state?.resource?.playbackDuration) || 0;
  const playbackStatus = String(player.player?.state?.status || "");
  const isStarting = !track.startedAt;
  const fallbackElapsedMs = track.startedAt ? Math.max(0, Date.now() - track.startedAt) : 0;
  const elapsedMs = isStarting ? 0 : playbackDurationMs > 0 ? Math.max(0, playbackDurationMs) : fallbackElapsedMs;
  const durationMsRaw =
    Number(track.durationMs) > 0
      ? Number(track.durationMs)
      : Number(track.durationSec) > 0
        ? Number(track.durationSec) * 1000
        : 0;
  const durationMs = Math.max(0, durationMsRaw);
  const loadingStartedAt = Number(track.loadingStartedAt || player.transitionStartedAt || 0);
  const loadingElapsedMs = loadingStartedAt > 0 ? Math.max(0, Date.now() - loadingStartedAt) : 0;
  const loadingProgressMs = Math.min(loadingElapsedMs, 10_000);
  const barElapsedMs =
    !isStarting && playbackStatus === "playing" && durationMs > 0
      ? Math.min(elapsedMs, Math.max(0, durationMs - 1))
      : elapsedMs;
  const displayElapsedMs =
    !isStarting && playbackStatus === "playing" && durationMs > 0 ? Math.min(elapsedMs, durationMs) : elapsedMs;
  const authorLine = trackAuthorLine(track, 46);
  const requestedBy = trackRequesterMention(track);
  const steppedBarElapsedMs = isStarting ? loadingProgressMs : steppedProgressMs(barElapsedMs, durationMs);
  const steppedDisplayElapsedMs = isStarting ? loadingElapsedMs : steppedProgressMs(displayElapsedMs, durationMs);
  const loadingPercent = Math.max(0, Math.min(100, Math.round((loadingProgressMs / 10_000) * 100)));
  const progressLine = isStarting
    ? visualProgressBar(loadingProgressMs, 10_000, 12)
    : visualProgressBar(steppedBarElapsedMs, durationMs, 12);
  const elapsedText = isStarting ? "Запускаю трек..." : formatDuration(steppedDisplayElapsedMs / 1000);
  const totalText = isStarting ? `${loadingPercent}%` : durationMs > 0 ? formatDuration(durationMs / 1000) : "--:--";
  const playlistUrl = playlistDisplayUrl(track);
  const sourceMetaLines = [];
  if (playlistUrl) {
    sourceMetaLines.push(`Плейлист: ${markdownLink(playlistDisplayTitle(track), playlistUrl)}`);
  }
  sourceMetaLines.push(subtextLine(`${compactSourceName(track)} · Очередь: ${player.queue.length} · ${requestedBy}`));
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_HEX)
    .setAuthor({ name: "Сейчас играет" })
    .addFields(
      { name: "TIME", value: `${elapsedText}  ${progressLine}  ${totalText}` },
      { name: "Дальше в очереди", value: buildQueuePreview(player) },
      { name: "\u200b", value: sourceMetaLines.join("\n") }
    );
  setTrackTitle(embed, track, 54);
  if (authorLine) {
    embed.setDescription(authorLine);
  }

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
}

function buildTrackNoticeEmbed(title, track, options = {}) {
  const actorText = String(options.actorText || "").trim();
  const durationSec = Number(track?.durationSec) || 0;
  const authorLine = trackAuthorLine(track, 46);
  const lines = [];

  if (authorLine) {
    lines.push(authorLine);
  }

  if (durationSec > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("**Длительность**", formatDuration(durationSec));
  }

  if (options.extraText) {
    const extraText = String(options.extraText).trim();
    if (extraText) {
      lines.push(extraText);
    }
  }

  const metaParts = [];
  if (options.showSource) {
    metaParts.push(sourceLabel(track));
  }
  metaParts.push(noticeMetaText(actorText || trackRequesterMention(track)));
  lines.push(subtextLine(metaParts.filter(Boolean).join(" · ")));

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_HEX)
    .setAuthor({ name: title });
  setTrackTitle(embed, track, 48);
  if (lines.length > 0) {
    embed.setDescription(lines.join("\n"));
  }

  if (track?.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
}

function buildPlaylistNoticeEmbed(title, playlist, options = {}) {
  const actorText = String(options.actorText || "").trim();
  const playlistTitle = truncate(safeLinkText(playlist?.title || "Плейлист"), 64);
  const playlistUrl = firstText(playlist?.url, playlist?.sourcePlaylistUrl, playlist?.playlistUrl);
  const trackCount = Math.max(0, Math.floor(Number(playlist?.trackCount) || 0));
  const durationSec = Math.max(0, Number(playlist?.durationSec) || 0);
  const lines = [
    `Треков: **${trackCount}**`,
    `Длительность: **${durationSec > 0 ? formatDuration(durationSec) : "--:--"}**`,
  ];

  if (options.extraText) {
    const extraText = String(options.extraText).trim();
    if (extraText) {
      lines.push(extraText);
    }
  }

  lines.push(noticeMetaLine(actorText));

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_HEX)
    .setAuthor({ name: title })
    .setTitle(playlistTitle)
    .setDescription(lines.join("\n"));

  if (isHttpUrl(playlistUrl)) {
    embed.setURL(playlistUrl);
  }

  return embed;
}

function buildControlsRow(player) {
  const idle = !player.currentTrack && player.queue.length === 0;
  const pauseLabel = player.isPaused() ? "Продолжить" : "Пауза";
  const loopButtonLabel = `Цикл: ${loopLabel(player.loopMode)}`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.stop)
      .setLabel("Стоп")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(idle),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.toggle)
      .setLabel(pauseLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idle),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.skip)
      .setLabel("Скип")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idle),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.loop)
      .setLabel(loopButtonLabel)
      .setStyle(player.loopMode === "off" ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(idle)
  );
}

function buildQueueRow(player) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.quickPlay)
      .setLabel("Добавить трек")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.queueOpen)
      .setLabel("Очередь")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.queue.length === 0),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.shuffle)
      .setLabel("Шафл")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.queue.length < 2)
  );
}

function buildQuickPlayRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.quickPlay)
      .setLabel("🔥 ВКЛЮЧИТЬ МУЗЫКУ СЕЙЧАС 🔥")
      .setStyle(ButtonStyle.Danger)
  );
}

function buildPanelComponents(player) {
  const idle = !player.currentTrack && player.queue.length === 0;
  if (idle) {
    return [buildQuickPlayRow()];
  }
  return [buildControlsRow(player), buildQueueRow(player)];
}

function buildQueueEmbed(player) {
  const current = player.currentTrack
    ? markdownLink(truncate(safeLinkText(player.currentTrack.title), 64), trackDisplayUrl(player.currentTrack))
    : "Ничего не играет";

  const queueText =
    player.queue
      .slice(0, 15)
      .map(
        (track, index) =>
          `${index + 1}. ${markdownLink(truncate(safeLinkText(track.title), 56), trackDisplayUrl(track))} · ${formatDuration(track.durationSec)}`
      )
      .join("\n") || "Пусто";

  return new EmbedBuilder()
    .setColor(EMBED_COLOR_HEX)
    .setTitle("Очередь")
    .setDescription(`**Сейчас:** ${current}`)
    .addFields({ name: `Треков в очереди: ${player.queue.length}`, value: queueText })
    .setFooter({ text: `Цикл: ${loopLabel(player.loopMode)}` });
}

function buildActionEmbed(title, description, options = {}) {
  const embed = new EmbedBuilder().setColor(EMBED_COLOR_HEX).setDescription(description);
  if (options.timestamp !== false) {
    embed.setTimestamp(new Date());
  }

  if (title) {
    embed.setTitle(title);
  }

  return embed;
}

function buildNoticeEmbed(title, text, actorText) {
  const lines = [];
  const body = String(text || "").trim();
  if (body) {
    lines.push(body);
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(noticeMetaLine(actorText));
  return buildActionEmbed(title, lines.join("\n"), { timestamp: false });
}

module.exports = {
  BUTTON_IDS,
  buildPlayerEmbed,
  buildControlsRow,
  buildPanelComponents,
  buildQueueEmbed,
  buildActionEmbed,
  buildNoticeEmbed,
  buildTrackNoticeEmbed,
  buildPlaylistNoticeEmbed,
  trackDisplayUrl,
};
