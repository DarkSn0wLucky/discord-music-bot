const { MessageFlags } = require("discord.js");
const { MUSIC_TEXT_CHANNEL_ID, MUSIC_TEXT_CHANNEL_NAME } = require("../config");
const { resolveTracks } = require("../music/resolveTrack");
const { BUTTON_IDS, buildActionEmbed, buildPlayerEmbed, buildQueueEmbed } = require("../ui/panel");
const { formatDuration, loopLabel, safeLinkText } = require("../utils/format");

const EPHEMERAL_REPLY = { flags: MessageFlags.Ephemeral };
const DEFAULT_MUSIC_CHANNEL_NAME = "\u043c\u0443\u0437\u044b\u043a\u0430";

function normalizeChannelName(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
}

function getMusicChannelLabel() {
  if (MUSIC_TEXT_CHANNEL_ID) {
    return `<#${MUSIC_TEXT_CHANNEL_ID}>`;
  }

  const name = MUSIC_TEXT_CHANNEL_NAME || DEFAULT_MUSIC_CHANNEL_NAME;
  return `#${name}`;
}

function isAllowedMusicChannel(interaction) {
  if (!interaction.inGuild() || !interaction.channel) {
    return false;
  }

  if (MUSIC_TEXT_CHANNEL_ID) {
    return interaction.channelId === MUSIC_TEXT_CHANNEL_ID;
  }

  const expected = normalizeChannelName(MUSIC_TEXT_CHANNEL_NAME || DEFAULT_MUSIC_CHANNEL_NAME);
  if (!expected) {
    return true;
  }

  const current = normalizeChannelName(interaction.channel.name || "");
  return current.startsWith(expected);
}

async function ensureMusicChannel(interaction) {
  if (isAllowedMusicChannel(interaction)) {
    return true;
  }

  const message = `Music commands are available only in ${getMusicChannelLabel()}.`;

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: message, ...EPHEMERAL_REPLY }).catch(() => null);
  } else {
    await interaction.reply({ content: message, ...EPHEMERAL_REPLY }).catch(() => null);
  }

  return false;
}

async function clearDeferredReply(interaction) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await interaction.deleteReply();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  await interaction.editReply({ content: "\u200b", embeds: [], components: [] }).catch(() => null);
}

function isSameVoiceWithBot(interaction, player) {
  const memberVoiceId = interaction.member?.voice?.channelId;
  if (!memberVoiceId) {
    return { ok: false, message: "Зайди в голосовой канал." };
  }

  if (!player.voiceChannelId) {
    return { ok: false, message: "Бот не подключён к голосовому каналу." };
  }

  if (memberVoiceId !== player.voiceChannelId) {
    return { ok: false, message: "Ты должен быть в том же голосовом канале, что и бот." };
  }

  return { ok: true };
}

async function withPlayer(interaction, manager) {
  const player = manager.get(interaction.guild.id);
  if (!player) {
    await interaction.reply({ content: "Плеер ещё не запущен. Используй `/play`.", ...EPHEMERAL_REPLY });
    return null;
  }

  if (player.textChannelId !== interaction.channelId) {
    await player.setTextChannel(interaction.channelId);
  }
  return player;
}

async function handlePlay(interaction, manager) {
  const memberVoice = interaction.member?.voice?.channel;
  if (!memberVoice) {
    await interaction.reply({ content: "Зайди в голосовой канал и повтори `/play`.", ...EPHEMERAL_REPLY });
    return;
  }

  const botVoiceId = interaction.guild.members.me?.voice?.channelId;
  if (botVoiceId && botVoiceId !== memberVoice.id) {
    await interaction.reply({
      content: "Я уже в другом голосовом канале. Зайди туда или останови плеер через `/stop`.",
      ...EPHEMERAL_REPLY,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const query = interaction.options.getString("query", true);
    const resolved = await resolveTracks(query, interaction.user);

    if (!resolved.tracks.length) {
      await interaction.editReply("Ничего не найдено по запросу.");
      return;
    }

    const player = manager.getOrCreate(interaction.guild);
    await player.setTextChannel(interaction.channelId);
    await player.connect(memberVoice);
    const wasQueueEmpty = !player.currentTrack && !player.transitionLock && player.queue.length === 0;

    const { accepted, dropped } = player.addTracks(resolved.tracks);
    if (accepted === 0) {
      await interaction.editReply("Очередь заполнена, добавить новые треки пока нельзя.");
      return;
    }

    const first = resolved.tracks[0];
    const summary =
      accepted === 1
        ? `[${safeLinkText(first.title)}](${first.url}) · ${formatDuration(first.durationSec)}`
        : `Добавлено треков: ${accepted}`;
    const startedNow = await player.playIfIdle();

    // First play in an empty queue: keep only now-playing action message.
    if (wasQueueEmpty) {
      if (!startedNow) {
        await player.refreshPanel();
      }
      await clearDeferredReply(interaction);
      return;
    }

    const dropHint = dropped > 0 ? `\nНе добавлено из-за лимита очереди: ${dropped}` : "";
    await interaction.editReply({
      embeds: [buildActionEmbed("Добавлено в очередь", `${summary}${dropHint}`)],
    });
    await player.refreshPanel();
  } catch (error) {
    console.error("[Command:/play]", error);
    await interaction.editReply(`Ошибка: ${error.message}`);
  }
}

async function handleSkip(interaction, manager) {
  const player = await withPlayer(interaction, manager);
  if (!player) {
    return;
  }

  const voiceCheck = isSameVoiceWithBot(interaction, player);
  if (!voiceCheck.ok) {
    await interaction.reply({ content: voiceCheck.message, ...EPHEMERAL_REPLY });
    return;
  }

  const result = await player.skip();
  await interaction.reply({ content: result.message });
}

async function handlePause(interaction, manager) {
  const player = await withPlayer(interaction, manager);
  if (!player) {
    return;
  }

  const voiceCheck = isSameVoiceWithBot(interaction, player);
  if (!voiceCheck.ok) {
    await interaction.reply({ content: voiceCheck.message, ...EPHEMERAL_REPLY });
    return;
  }

  const result = await player.pause();
  await interaction.reply({ content: result.message });
}

async function handleResume(interaction, manager) {
  const player = await withPlayer(interaction, manager);
  if (!player) {
    return;
  }

  const voiceCheck = isSameVoiceWithBot(interaction, player);
  if (!voiceCheck.ok) {
    await interaction.reply({ content: voiceCheck.message, ...EPHEMERAL_REPLY });
    return;
  }

  const result = await player.resume();
  await interaction.reply({ content: result.message });
}

async function handleStop(interaction, manager) {
  const player = await withPlayer(interaction, manager);
  if (!player) {
    return;
  }

  const voiceCheck = isSameVoiceWithBot(interaction, player);
  if (!voiceCheck.ok) {
    await interaction.reply({ content: voiceCheck.message, ...EPHEMERAL_REPLY });
    return;
  }

  await interaction.deferReply({ ...EPHEMERAL_REPLY });
  const result = await player.stop();

  // For successful stop, avoid extra ack message in the channel.
  if (result.ok) {
    await interaction.deleteReply().catch(() => null);
    return;
  }

  await interaction.editReply(result.message);
}

async function handleQueue(interaction, manager) {
  const player = await withPlayer(interaction, manager);
  if (!player) {
    return;
  }

  await interaction.reply({
    embeds: [buildQueueEmbed(player)],
  });
}

async function handleNowPlaying(interaction, manager) {
  const player = await withPlayer(interaction, manager);
  if (!player) {
    return;
  }

  await interaction.reply({ embeds: [buildPlayerEmbed(player)] });
}

async function handleShuffle(interaction, manager) {
  const player = await withPlayer(interaction, manager);
  if (!player) {
    return;
  }

  const voiceCheck = isSameVoiceWithBot(interaction, player);
  if (!voiceCheck.ok) {
    await interaction.reply({ content: voiceCheck.message, ...EPHEMERAL_REPLY });
    return;
  }

  const result = await player.shuffle();
  await interaction.reply({ content: result.message });
}

async function handleLoop(interaction, manager) {
  const player = await withPlayer(interaction, manager);
  if (!player) {
    return;
  }

  const voiceCheck = isSameVoiceWithBot(interaction, player);
  if (!voiceCheck.ok) {
    await interaction.reply({ content: voiceCheck.message, ...EPHEMERAL_REPLY });
    return;
  }

  const mode = interaction.options.getString("mode", true);
  const updated = await player.setLoopMode(mode);
  if (!updated) {
    await interaction.reply({ content: "Некорректный режим loop.", ...EPHEMERAL_REPLY });
    return;
  }

  await interaction.reply({ content: `Цикл: ${loopLabel(mode)}.` });
}

async function handleButton(interaction, manager) {
  if (!(await ensureMusicChannel(interaction))) {
    return;
  }

  const player = manager.get(interaction.guild.id);
  if (!player) {
    await interaction.reply({ content: "Плеер неактивен.", ...EPHEMERAL_REPLY });
    return;
  }

  const voiceCheck = isSameVoiceWithBot(interaction, player);
  if (!voiceCheck.ok) {
    await interaction.reply({ content: voiceCheck.message, ...EPHEMERAL_REPLY });
    return;
  }

  await interaction.deferUpdate();

  if (interaction.customId === BUTTON_IDS.toggle) {
    const result = await player.togglePause();
    if (!result.ok) {
      await interaction.followUp({ content: result.message, ...EPHEMERAL_REPLY });
    }
    return;
  }

  if (interaction.customId === BUTTON_IDS.skip) {
    const result = await player.skip();
    if (!result.ok) {
      await interaction.followUp({ content: result.message, ...EPHEMERAL_REPLY });
    }
    return;
  }

  if (interaction.customId === BUTTON_IDS.stop) {
    await player.stop();
    return;
  }

  if (interaction.customId === BUTTON_IDS.shuffle) {
    const result = await player.shuffle();
    if (!result.ok) {
      await interaction.followUp({ content: result.message, ...EPHEMERAL_REPLY });
    }
    return;
  }

  if (interaction.customId === BUTTON_IDS.loop) {
    await player.cycleLoopMode();
    return;
  }

  await interaction.followUp({ content: "Неизвестная кнопка.", ...EPHEMERAL_REPLY });
}

async function handleChatInput(interaction, manager) {
  if (!(await ensureMusicChannel(interaction))) {
    return;
  }

  if (interaction.commandName === "play") {
    await handlePlay(interaction, manager);
    return;
  }

  if (interaction.commandName === "skip") {
    await handleSkip(interaction, manager);
    return;
  }

  if (interaction.commandName === "pause") {
    await handlePause(interaction, manager);
    return;
  }

  if (interaction.commandName === "resume") {
    await handleResume(interaction, manager);
    return;
  }

  if (interaction.commandName === "stop") {
    await handleStop(interaction, manager);
    return;
  }

  if (interaction.commandName === "queue") {
    await handleQueue(interaction, manager);
    return;
  }

  if (interaction.commandName === "nowplaying") {
    await handleNowPlaying(interaction, manager);
    return;
  }

  if (interaction.commandName === "shuffle") {
    await handleShuffle(interaction, manager);
    return;
  }

  if (interaction.commandName === "loop") {
    await handleLoop(interaction, manager);
    return;
  }

  await interaction.reply({ content: "Неизвестная команда.", ...EPHEMERAL_REPLY });
}

module.exports = {
  handleChatInput,
  handleButton,
};
