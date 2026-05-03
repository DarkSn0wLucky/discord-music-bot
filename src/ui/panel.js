const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { EMBED_COLOR_HEX } = require("../config");
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

  const queuePreview =
    player.queue
      .slice(0, 3)
      .map((item, index) => `${index + 1}. [${truncate(safeLinkText(item.title), 38)}](${item.url})`)
      .join("\n") || "Пусто";

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_HEX)
    .setTitle("Сейчас играет")
    .setDescription(`[${truncate(safeLinkText(track.title), 90)}](${track.url})`)
    .addFields(
      { name: "Источник", value: sourceLabel(track) },
      {
        name: "TIME",
        value: `${isStarting ? progressBar(loadingProgressMs, 10_000, 34) : progressBar(barElapsedMs, durationMs, 34)}\n${durationText}`,
      },
      { name: "Дальше в очереди", value: queuePreview }
    );

  if (track.thumbnail) {
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
    ? `[${truncate(safeLinkText(player.currentTrack.title), 64)}](${player.currentTrack.url})`
    : "Ничего не играет";

  const queueText =
    player.queue
      .slice(0, 15)
      .map(
        (track, index) =>
          `${index + 1}. [${truncate(safeLinkText(track.title), 56)}](${track.url}) · ${formatDuration(track.durationSec)}`
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
};
