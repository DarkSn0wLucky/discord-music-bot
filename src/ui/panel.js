const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { EMBED_COLOR_HEX } = require("../config");
const { formatDuration, loopLabel, progressBar, safeLinkText, truncate } = require("../utils/format");

const BUTTON_IDS = {
  toggle: "music:toggle",
  skip: "music:skip",
  stop: "music:stop",
  shuffle: "music:shuffle",
  loop: "music:loop",
  quickPlay: "music:quickplay",
};

function buildPlayerEmbed(player) {
  if (!player.currentTrack) {
    return new EmbedBuilder()
      .setColor(EMBED_COLOR_HEX)
      .setTitle("РњСѓР·С‹РєР°Р»СЊРЅС‹Р№ РїР»РµРµСЂ")
      .setDescription("РћС‡РµСЂРµРґСЊ РїСѓСЃС‚Р°. Р”РѕР±Р°РІСЊ С‚СЂРµРє С‡РµСЂРµР· `/play <СЃСЃС‹Р»РєР° РёР»Рё Р·Р°РїСЂРѕСЃ>` РёР»Рё РєРЅРѕРїРєСѓ РЅРёР¶Рµ.")
      .addFields(
        { name: "РЎС‚Р°С‚СѓСЃ", value: "РћР¶РёРґР°РЅРёРµ", inline: true },
        { name: "Р¦РёРєР»", value: loopLabel(player.loopMode), inline: true },
        { name: "Р’ РѕС‡РµСЂРµРґРё", value: String(player.queue.length), inline: true }
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
      .join("\n") || "РџСѓСЃС‚Рѕ";

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_HEX)
    .setTitle("РЎРµР№С‡Р°СЃ РёРіСЂР°РµС‚")
    .setDescription(`[${truncate(safeLinkText(track.title), 90)}](${track.url})`)
    .addFields(
      { name: "РСЃС‚РѕС‡РЅРёРє", value: track.source, inline: true },
      { name: "Р¦РёРєР»", value: loopLabel(player.loopMode), inline: true },
      { name: "Р”Р»РёРЅР° РѕС‡РµСЂРµРґРё", value: String(player.queue.length), inline: true },
      { name: "TIME", value: `${progressBar(elapsedMs, durationMs, 28)}\n${durationText}` },
      { name: "Р”Р°Р»СЊС€Рµ РІ РѕС‡РµСЂРµРґРё", value: queuePreview }
    );

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
}

function buildControlsRow(player) {
  const idle = !player.currentTrack && player.queue.length === 0;
  const pauseLabel = player.isPaused() ? "РџСЂРѕРґРѕР»Р¶РёС‚СЊ" : "РџР°СѓР·Р°";
  const loopButtonLabel = `Р¦РёРєР»: ${loopLabel(player.loopMode)}`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.toggle)
      .setLabel(pauseLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idle),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.skip)
      .setLabel("РЎРєРёРї")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idle),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.stop)
      .setLabel("РЎС‚РѕРї")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(idle),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.shuffle)
      .setLabel("РЁР°С„Р»")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.queue.length < 2),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.loop)
      .setLabel(loopButtonLabel)
      .setStyle(player.loopMode === "off" ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(idle)
  );
}

function buildQuickPlayRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.quickPlay)
      .setLabel("ВКЛЮЧИТЬ МУЗЫКУ")
      .setStyle(ButtonStyle.Danger)
  );
}

function buildPanelComponents(player) {
  const idle = !player.currentTrack && player.queue.length === 0;
  if (idle) {
    return [buildQuickPlayRow()];
  }
  return [buildControlsRow(player)];
}

function buildQueueEmbed(player) {
  const current = player.currentTrack
    ? `[${truncate(safeLinkText(player.currentTrack.title), 64)}](${player.currentTrack.url})`
    : "РќРёС‡РµРіРѕ РЅРµ РёРіСЂР°РµС‚";

  const queueText =
    player.queue
      .slice(0, 15)
      .map(
        (track, index) =>
          `${index + 1}. [${truncate(safeLinkText(track.title), 56)}](${track.url}) В· ${formatDuration(track.durationSec)}`
      )
      .join("\n") || "РџСѓСЃС‚Рѕ";

  return new EmbedBuilder()
    .setColor(EMBED_COLOR_HEX)
    .setTitle("РћС‡РµСЂРµРґСЊ")
    .setDescription(`**РЎРµР№С‡Р°СЃ:** ${current}`)
    .addFields({ name: `РўСЂРµРєРѕРІ РІ РѕС‡РµСЂРµРґРё: ${player.queue.length}`, value: queueText })
    .setFooter({ text: `Р¦РёРєР»: ${loopLabel(player.loopMode)}` });
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

