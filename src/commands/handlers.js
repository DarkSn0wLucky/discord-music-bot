const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } = require("discord.js");
const { MUSIC_TEXT_CHANNEL_ID, MUSIC_TEXT_CHANNEL_NAME } = require("../config");
const { resolveSearchCandidates, resolveTracks } = require("../music/resolveTrack");
const { BUTTON_IDS, buildActionEmbed, buildPlayerEmbed, buildQueueEmbed } = require("../ui/panel");
const { formatDuration, loopLabel, safeLinkText, truncate } = require("../utils/format");

const EPHEMERAL_REPLY = { flags: MessageFlags.Ephemeral };
const DEFAULT_MUSIC_CHANNEL_NAME = "\u043c\u0443\u0437\u044b\u043a\u0430";
const playRequestQueueByGuild = new Map();

function enqueuePlayRequest(guildId, task) {
  const previous = playRequestQueueByGuild.get(guildId) || Promise.resolve();
  const next = previous
    .catch(() => null)
    .then(task)
    .finally(() => {
      if (playRequestQueueByGuild.get(guildId) === next) {
        playRequestQueueByGuild.delete(guildId);
      }
    });

  playRequestQueueByGuild.set(guildId, next);
  return next;
}

function isUrlLike(value) {
  try {
    new URL(String(value || "").trim());
    return true;
  } catch {
    return false;
  }
}

function buildTrackPickerRows(customIdPrefix, tracks) {
  const topTracks = tracks.slice(0, 5);
  const rows = topTracks.slice(0, 4).map((track, index) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${customIdPrefix}:${index}`)
        .setLabel(`${index + 1}. ${truncate(safeLinkText(track.title), 70)}`)
        .setStyle(ButtonStyle.Secondary)
    )
  );

  const lastTrack = topTracks[4];
  if (lastTrack) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${customIdPrefix}:4`)
          .setLabel(`5. ${truncate(safeLinkText(lastTrack.title), 48)}`)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`${customIdPrefix}:cancel`)
          .setLabel("Отменить")
          .setStyle(ButtonStyle.Danger)
      )
    );
  } else {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${customIdPrefix}:cancel`)
          .setLabel("Отменить")
          .setStyle(ButtonStyle.Danger)
      )
    );
  }

  return rows;
}

function buildTrackPickerDescription(query, tracks) {
  return `Запрос: **${safeLinkText(query)}**\nНажми на кнопку с нужным треком (таймаут 30 сек).`;
}

async function pickTrackFromMenu(interaction, query, tracks) {
  if (!tracks.length) {
    return null;
  }

  const customIdPrefix = `pick:${interaction.id}`;
  const pickerRows = buildTrackPickerRows(customIdPrefix, tracks);

  const promptMessage = await interaction.editReply({
    embeds: [
      buildActionEmbed(
        "Выбор трека",
        buildTrackPickerDescription(query, tracks)
      ),
    ],
    components: pickerRows,
  });

  try {
    const selected = await promptMessage.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 30_000,
      filter: async (componentInteraction) => {
        if (!componentInteraction.customId.startsWith(`${customIdPrefix}:`)) {
          return false;
        }

        if (componentInteraction.user.id !== interaction.user.id) {
          await componentInteraction
            .reply({
              content: `Выбор доступен только <@${interaction.user.id}>.`,
              ...EPHEMERAL_REPLY,
            })
            .catch(() => null);
          return false;
        }

        return true;
      },
    });

    const selectedValue = String(selected.customId.split(":").pop());
    if (selectedValue === "cancel") {
      await selected.update({
        embeds: [buildActionEmbed("Выбор отменён", "Добавление трека отменено.")],
        components: [],
      });
      return null;
    }

    const selectedIndex = Number(selectedValue);
    const track = tracks[selectedIndex] || tracks[0];
    await selected.update({
      embeds: [buildActionEmbed("Выбрано", `[${safeLinkText(track.title)}](${track.url}) • ${formatDuration(track.durationSec)}`)],
      components: [],
    });

    return track;
  } catch {
    const fallbackTrack = tracks[0];
    await interaction.editReply({
      embeds: [
        buildActionEmbed(
          "Выбор по умолчанию",
          `Время выбора вышло, запускаю первый вариант:\n[${safeLinkText(fallbackTrack.title)}](${fallbackTrack.url})`
        ),
      ],
      components: [],
    });
    return fallbackTrack;
  }
}

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

async function sendStoppedByNotice(player, user) {
  await player
    .sendAction(
      "Музыка остановлена",
      `Сессию завершил <@${user.id}>.\nОчередь очищена, бот отключился от голосового канала.`
    )
    .catch(() => null);
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

  await enqueuePlayRequest(interaction.guild.id, async () => {
    try {
      const query = interaction.options.getString("query", true);
      const isDirectUrl = isUrlLike(query);
      let tracksToAdd = [];

      if (isDirectUrl) {
        const resolved = await resolveTracks(query, interaction.user);
        tracksToAdd = resolved.tracks;
      } else {
        const candidates = await resolveSearchCandidates(query, interaction.user, { limit: 5 });
        if (!candidates.length) {
          await interaction.editReply("Ничего не найдено по запросу.");
          return;
        }

        const selectedTrack = await pickTrackFromMenu(interaction, query, candidates);
        if (!selectedTrack) return;

        selectedTrack.searchQuery = query;
        selectedTrack.fallbackTracks = candidates.filter((candidate) => candidate.url !== selectedTrack.url).slice(0, 4);
        tracksToAdd = [selectedTrack];
      }

      if (!tracksToAdd.length) {
        await interaction.editReply("Ничего не найдено по запросу.");
        return;
      }

      const player = manager.getOrCreate(interaction.guild);
      await player.setTextChannel(interaction.channelId);
      await player.connect(memberVoice);
      const wasQueueEmpty = !player.currentTrack && !player.transitionLock && player.queue.length === 0;

      const { accepted, dropped } = player.addTracks(tracksToAdd);
      if (accepted === 0) {
        await interaction.editReply("Очередь заполнена, добавить новые треки пока нельзя.");
        return;
      }

      const first = tracksToAdd[0];
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
      await player.refreshPanel({ moveToBottom: true });
    } catch (error) {
      console.error("[Command:/play]", error);
      await interaction.editReply(`Ошибка: ${error.message}`);
    }
  });
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

  await interaction.deferReply({ ...EPHEMERAL_REPLY });
  const result = await player.skip();
  if (result.ok) {
    await interaction.deleteReply().catch(() => null);
    return;
  }

  await interaction.editReply(result.message);
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

  if (result.ok) {
    await sendStoppedByNotice(player, interaction.user);
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
    const result = await player.stop();
    if (result.ok) {
      await sendStoppedByNotice(player, interaction.user);
      return;
    }

    await interaction.followUp({ content: result.message, ...EPHEMERAL_REPLY });
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
