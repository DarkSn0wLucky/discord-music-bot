const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { EMBED_COLOR_HEX } = require("../config");
const { formatDuration, loopLabel, progressBar, safeLinkText, truncate } = require("../utils/format");

const BUTTON_IDS = {
  toggle: "music:toggle",
  skip: "music:skip",
  stop: "music:stop",
  shuffle: "music:shuffle",
  loop: "music:loop",
};

function buildPlayerEmbed(player) {
  if (!player.currentTrack) {
    return new EmbedBuilder()
      .setColor(EMBED_COLOR_HEX)
      .setTitle("Музыкальный плеер")
      .setDescription("Очередь пуста. Добавь трек через `/play <ссылка или запрос>`")
      .addFields(
        { name: "Статус", value: "Ожидание", inline: true },
        { name: "Цикл", value: loopLabel(player.loopMode), inline: true },
        { name: "В очереди", value: String(player.queue.length), inline: true }
      )
      .setFooter({ text: "Music mode" });
  }

  const track = player.currentTrack;
  const elapsedMs = track.startedAt ? Date.now() - track.startedAt : 0;
  const durationMs = track.durationMs || 0;
  const durationText =
    durationMs > 0
      ? `${formatDuration(elapsedMs / 1000)} / ${formatDuration(durationMs / 1000)}`
      : "LIVE";

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
      { name: "Источник", value: track.source, inline: true },
      { name: "Цикл", value: loopLabel(player.loopMode), inline: true },
      { name: "Длина очереди", value: String(player.queue.length), inline: true },
      { name: "TIME", value: `${progressBar(elapsedMs, durationMs)}\n${durationText}` },
      { name: "Дальше в очереди", value: queuePreview }
    )
    .setFooter({ text: `Запросил ${track.requestedByTag}` });

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
  buildQueueEmbed,
  buildActionEmbed,
};
