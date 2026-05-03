const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { EMBED_COLOR_HEX, PROGRESS_FRAME_EMOJIS } = require("../config");
const { formatDuration, loopLabel, progressBar, safeLinkText, truncate } = require("../utils/format");

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

function authorDisplayUrl(track) {
  const directUrl = firstText(track?.authorUrl, track?.channelUrl, track?.channel_url, track?.uploaderUrl, track?.uploader_url);
  if (isHttpUrl(directUrl)) {
    return directUrl;
  }

  const author = firstText(track?.author);
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

function trackTitleLine(track, maxLength = 90) {
  const title = truncate(safeLinkText(track?.title), maxLength);
  return markdownLink(title, trackDisplayUrl(track));
}

function trackAuthorLine(track, maxLength = 90) {
  const author = truncate(safeLinkText(track?.author || track?.source || ""), maxLength);
  if (!author) {
    return "";
  }
  return markdownLink(author, authorDisplayUrl(track));
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

function visualProgressBar(elapsedMs, totalMs, size = 28) {
  const emojiFrame = frameProgressBar(elapsedMs, totalMs);
  if (emojiFrame) {
    return emojiFrame;
  }

  return progressBar(elapsedMs, totalMs, size);
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
  const loadingProgressMs = Math.min(loadingElapsedMs, 9_000);
  const barElapsedMs =
    !isStarting && playbackStatus === "playing" && durationMs > 0
      ? Math.min(elapsedMs, Math.max(0, durationMs - 1))
      : elapsedMs;
  const displayElapsedMs =
    !isStarting && playbackStatus === "playing" && durationMs > 0 ? Math.min(elapsedMs, durationMs) : elapsedMs;
  const durationText =
    isStarting
      ? `Запускаю трек... ${formatDuration(loadingElapsedMs / 1000)}`
      : durationMs > 0
      ? `${formatDuration(displayElapsedMs / 1000)} / ${formatDuration(durationMs / 1000)}`
      : `${formatDuration(displayElapsedMs / 1000)} / --:--`;

  const trackLine = trackTitleLine(track, 90);
  const authorLine = trackAuthorLine(track, 90);
  const requestedBy = track.requestedById ? `<@${track.requestedById}>` : safeLinkText(track.requestedByTag || "unknown");
  const progressLine = isStarting
    ? progressBar(loadingProgressMs, 10_000, 28)
    : visualProgressBar(barElapsedMs, durationMs, 28);
  const details = [
    trackLine,
    authorLine,
    "",
    `${durationText.split(" / ")[0]}  ${progressLine}  ${durationMs > 0 ? formatDuration(durationMs / 1000) : "--:--"}`,
    "",
    `${sourceLabel(track)} · Треков в очереди: ${player.queue.length} · Добавил ${requestedBy}`,
  ].filter((line) => line !== null && line !== undefined).join("\n");

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_HEX)
    .setTitle("Сейчас играет")
    .setDescription(details);

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
}

function buildTrackNoticeEmbed(title, track, options = {}) {
  const actorText = String(options.actorText || "").trim();
  const actionText = String(options.actionText || "").trim();
  const durationSec = Number(track?.durationSec) || 0;
  const authorLine = trackAuthorLine(track, 72);
  const lines = [trackTitleLine(track, 72)];

  if (authorLine) {
    lines.push(authorLine);
  }

  if (durationSec > 0) {
    lines.push("**Длительность**", formatDuration(durationSec));
  }

  if (actionText || actorText) {
    lines.push(`${actionText || "Запросил"} ${actorText}`.trim());
  }
  if (options.extraText) {
    lines.push(String(options.extraText).trim());
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_HEX)
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setTimestamp(new Date());

  if (track?.thumbnail) {
    embed.setThumbnail(track.thumbnail);
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
      .setLabel(`Очередь (${player.queue.length})`)
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

function buildActionEmbed(title, description) {
  const embed = new EmbedBuilder().setColor(EMBED_COLOR_HEX).setDescription(description).setTimestamp(new Date());

  if (title) {
    embed.setTitle(title);
  }

  return embed;
}

module.exports = {
  BUTTON_IDS,
  buildPlayerEmbed,
  buildControlsRow,
  buildPanelComponents,
  buildQueueEmbed,
  buildActionEmbed,
  buildTrackNoticeEmbed,
  trackDisplayUrl,
};
