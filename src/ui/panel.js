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
  if (key === "youtube") return "YouTube";
  if (key === "yandex") return "Yandex Music";
  if (key === "vk") return "VK Music";
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
      .setDescription("Очередь пуста. Включи музыку кнопкой ниже.")
      .addFields(
        { name: "Статус", value: "Ожидание", inline: true },
        { name: "Цикл", value: loopLabel(player.loopMode), inline: true },
        { name: "В очереди", value: String(player.queue.length), inline: true }
      )
      .setFooter({ text: "Режим музыки" });
  }

  const track = player.currentTrack;
  const playbackDurationMs = Number(player.player?.state?.resource?.playbackDuration) || 0;
  const elapsedMs = track.startedAt ? Math.max(0, Date.now() - track.startedAt) : Math.max(0, playbackDurationMs);
  const durationMsRaw =
    Number(track.durationMs) > 0
      ? Number(track.durationMs)
      : Number(track.durationSec) > 0
        ? Number(track.durationSec) * 1000
        : 0;
  const durationMs = Math.max(0, durationMsRaw);
  const durationText =
    durationMs > 0
      ? `${formatDuration(elapsedMs / 1000)} / ${formatDuration(durationMs / 1000)}`
      : `${formatDuration(elapsedMs / 1000)} / --:--`;

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
      { name: "Источник", value: sourceLabel(track), inline: true },
      { name: "Цикл", value: loopLabel(player.loopMode), inline: true },
      { name: "Длина очереди", value: String(player.queue.length), inline: true },
      { name: "TIME", value: `${progressBar(elapsedMs, durationMs, 34)}\n${durationText}` },
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
      .setCustomId(BUTTON_IDS.stop)
      .setLabel("Стоп")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(idle),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.shuffle)
      .setLabel("Шафл")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.queue.length < 2),
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
      .setCustomId(BUTTON_IDS.queueOpen)
      .setLabel(`Очередь (${player.queue.length})`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.queue.length === 0)
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
