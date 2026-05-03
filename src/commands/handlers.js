const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require("discord.js");
const { MUSIC_TEXT_CHANNEL_ID, MUSIC_TEXT_CHANNEL_NAME } = require("../config");
const { resolveSearchCandidates, resolveTracks } = require("../music/resolveTrack");
const { BUTTON_IDS, buildActionEmbed, buildPlayerEmbed, buildQueueEmbed } = require("../ui/panel");
const { formatDuration, loopLabel, safeLinkText, truncate } = require("../utils/format");

const EPHEMERAL_REPLY = { flags: MessageFlags.Ephemeral };
const DEFAULT_MUSIC_CHANNEL_NAME = "\u043c\u0443\u0437\u044b\u043a\u0430";
const playRequestQueueByGuild = new Map();
const PLAY_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.PLAY_REQUEST_TIMEOUT_MS || "0", 10);
const HAS_PLAY_REQUEST_TIMEOUT = Number.isFinite(PLAY_REQUEST_TIMEOUT_MS) && PLAY_REQUEST_TIMEOUT_MS > 0;
const PLAY_TIMEOUT_ERROR_CODE = "PLAY_REQUEST_TIMEOUT";
const URL_RESOLVE_TIMEOUT_MS = Number.parseInt(process.env.URL_RESOLVE_TIMEOUT_MS || "300000", 10);
const HAS_URL_RESOLVE_TIMEOUT = Number.isFinite(URL_RESOLVE_TIMEOUT_MS) && URL_RESOLVE_TIMEOUT_MS > 0;
const URL_RESOLVE_TIMEOUT_ERROR_CODE = "URL_RESOLVE_TIMEOUT";
const URL_RESOLVE_HEARTBEAT_INTERVAL_MS = 5_000;
const QUICK_PLAY_MODAL_ID = "music:quickplay:modal";
const QUICK_PLAY_QUERY_INPUT_ID = "music:quickplay:query";
const QUEUE_PICKER_PAGE_SIZE = 25;
const QUEUE_PICKER_SELECT_ID = "music:queue:pick";
const QUEUE_PICKER_PREV_ID = "music:queue:prev";
const QUEUE_PICKER_NEXT_ID = "music:queue:next";
const QUEUE_PICKER_CLOSE_ID = "music:queue:close";
const VOICE_PANEL_PREFIX = "voicepanel";
const VOICE_PANEL_STATE_TTL_MS = 30 * 60_000;
const voicePanelStateByMessageId = new Map();
const queuePickerPageState = new Map();
const VOICE_PANEL_OWNER_LOGIN = String(process.env.VOICE_PANEL_OWNER_LOGIN || "darksnowlucky")
  .trim()
  .toLowerCase();
const VOICE_PANEL_OWNER_ID = String(process.env.VOICE_PANEL_OWNER_ID || "").trim();

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

function normalizePickerText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLinkPickerCandidates(primaryTrack, extraCandidates = []) {
  const merged = [
    primaryTrack,
    ...(Array.isArray(primaryTrack?.fallbackTracks) ? primaryTrack.fallbackTracks : []),
    ...extraCandidates,
  ];

  const unique = [];
  const seenUrls = new Set();
  const seenTitleKeys = new Set();

  for (const track of merged) {
    if (!track?.url) {
      continue;
    }

    if (seenUrls.has(track.url)) {
      continue;
    }

    const titleKey = normalizePickerText(track.title);
    if (titleKey && seenTitleKeys.has(titleKey)) {
      continue;
    }

    seenUrls.add(track.url);
    if (titleKey) {
      seenTitleKeys.add(titleKey);
    }
    unique.push(track);

    if (unique.length >= 5) {
      break;
    }
  }

  return unique;
}

function buildPlayTimeoutError() {
  const error = new Error(PLAY_TIMEOUT_ERROR_CODE);
  error.code = PLAY_TIMEOUT_ERROR_CODE;
  return error;
}

function buildUrlResolveTimeoutError() {
  const error = new Error(URL_RESOLVE_TIMEOUT_ERROR_CODE);
  error.code = URL_RESOLVE_TIMEOUT_ERROR_CODE;
  return error;
}

function withPromiseTimeout(promise, timeoutMs, timeoutErrorFactory) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return Promise.resolve(promise);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(typeof timeoutErrorFactory === "function" ? timeoutErrorFactory() : new Error("Timed out"));
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
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

function getQueuePickerStateKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function getQueuePickerPage(interaction, totalPages) {
  const key = getQueuePickerStateKey(interaction);
  const raw = Number(queuePickerPageState.get(key));
  const maxPage = Math.max(0, totalPages - 1);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.min(maxPage, Math.floor(raw)));
}

function setQueuePickerPage(interaction, page) {
  const key = getQueuePickerStateKey(interaction);
  queuePickerPageState.set(key, Math.max(0, Math.floor(Number(page) || 0)));
}

function buildQueuePickerPayload(player, page, options = {}) {
  const notice = String(options.notice || "").trim();
  const total = player.queue.length;
  const totalPages = Math.max(1, Math.ceil(total / QUEUE_PICKER_PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(totalPages - 1, Math.floor(Number(page) || 0)));

  if (total === 0) {
    return {
      embeds: [buildActionEmbed("Очередь", `${notice ? `${notice}\n` : ""}Очередь пуста.`)],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(QUEUE_PICKER_CLOSE_ID)
            .setLabel("Закрыть")
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    };
  }

  const start = currentPage * QUEUE_PICKER_PAGE_SIZE;
  const slice = player.queue.slice(start, start + QUEUE_PICKER_PAGE_SIZE);
  const optionsList = slice.map((track, idx) => {
    const absoluteIndex = start + idx;
    const position = absoluteIndex + 1;
    return {
      label: truncate(`${position}. ${safeLinkText(track.title)}`, 95),
      description: truncate(`${formatDuration(track.durationSec)} • ${safeLinkText(track.author || track.source || "track")}`, 95),
      value: String(absoluteIndex),
    };
  });

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(QUEUE_PICKER_SELECT_ID)
      .setPlaceholder(`Страница ${currentPage + 1}/${totalPages} • выбери трек`)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(optionsList)
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(QUEUE_PICKER_PREV_ID)
      .setLabel("Назад")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 0),
    new ButtonBuilder()
      .setCustomId(QUEUE_PICKER_NEXT_ID)
      .setLabel("Вперёд")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(QUEUE_PICKER_CLOSE_ID)
      .setLabel("Закрыть")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [
      buildActionEmbed(
        "Очередь",
        `${notice ? `${notice}\n` : ""}Треков в очереди: **${total}**\nНажми на трек, чтобы запустить его сразу.`
      ),
    ],
    components: [selectRow, navRow],
  };
}

async function showQuickPlayModal(interaction) {
  const modal = new ModalBuilder().setCustomId(QUICK_PLAY_MODAL_ID).setTitle("Включить музыку");

  const queryInput = new TextInputBuilder()
    .setCustomId(QUICK_PLAY_QUERY_INPUT_ID)
    .setLabel("Что включить?")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("Ссылка или текстовый запрос")
    .setMaxLength(300);

  modal.addComponents(new ActionRowBuilder().addComponents(queryInput));
  await interaction.showModal(modal);
}

function interactionUserMention(interaction) {
  return interaction?.user?.id ? `<@${interaction.user.id}>` : safeLinkText(interaction?.user?.tag || "unknown");
}

function buildSkipNotice(result, interaction) {
  const actor = interactionUserMention(interaction);
  const title = result?.track?.title ? `**${safeLinkText(result.track.title)}**\n` : "";
  return `${title}Пропустил ${actor}`;
}

function buildLoopNotice(mode, interaction) {
  const actor = interactionUserMention(interaction);
  if (mode === "off") {
    return `Цикл выключен.\nВыключил ${actor}`;
  }

  return `Цикл включён: ${loopLabel(mode)}.\nВключил ${actor}`;
}

async function movePlayerPanelBelowActions(player) {
  if (!player || typeof player.refreshPanel !== "function") {
    return;
  }

  await player.refreshPanel({ moveToBottom: true }).catch(() => null);
}

function startUrlResolveHeartbeat(progress) {
  let stopped = false;
  let percent = 30;
  let tick = 0;
  const texts = [
    "Получаю данные по ссылке",
    "Анализирую источник",
    "Сопоставляю треки с YouTube",
    "Формирую список для очереди",
  ];

  const timer = setInterval(() => {
    if (stopped) {
      return;
    }

    percent = Math.min(66, percent + 2);
    const text = texts[tick % texts.length];
    tick += 1;
    progress.update(percent, text).catch(() => null);
  }, URL_RESOLVE_HEARTBEAT_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
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

  const message = `\u041c\u0443\u0437\u044b\u043a\u0430\u043b\u044c\u043d\u044b\u0435 \u043a\u043e\u043c\u0430\u043d\u0434\u044b \u0440\u0430\u0431\u043e\u0442\u0430\u044e\u0442 \u0442\u043e\u043b\u044c\u043a\u043e \u0432 ${getMusicChannelLabel()}.`;

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

function cleanupVoicePanelState() {
  const now = Date.now();
  for (const [messageId, state] of voicePanelStateByMessageId.entries()) {
    if (!state || now - Number(state.updatedAt || 0) > VOICE_PANEL_STATE_TTL_MS) {
      voicePanelStateByMessageId.delete(messageId);
    }
  }
}

function isVoicePanelOwner(interaction) {
  const user = interaction?.user;
  if (!user) {
    return false;
  }

  if (VOICE_PANEL_OWNER_ID && user.id === VOICE_PANEL_OWNER_ID) {
    return true;
  }

  if (!VOICE_PANEL_OWNER_LOGIN) {
    return false;
  }

  const aliases = [user.username, user.globalName, interaction?.member?.displayName]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  return aliases.includes(VOICE_PANEL_OWNER_LOGIN);
}

function canUseVoicePanel(interaction) {
  return isVoicePanelOwner(interaction);
}

function buildVoicePanelCustomId(type, ownerId, action = "") {
  if (type === "action") {
    return `${VOICE_PANEL_PREFIX}:action:${action}:${ownerId}`;
  }

  return `${VOICE_PANEL_PREFIX}:${type}:${ownerId}`;
}

function parseVoicePanelCustomId(customId) {
  const parts = String(customId || "").split(":");
  if (parts[0] !== VOICE_PANEL_PREFIX) {
    return null;
  }

  if (parts[1] === "action" && parts.length >= 4) {
    return {
      type: "action",
      action: parts[2],
      ownerId: parts[3],
    };
  }

  if ((parts[1] === "user" || parts[1] === "move") && parts.length >= 3) {
    return {
      type: parts[1],
      ownerId: parts[2],
    };
  }

  return null;
}

function buildVoiceMoveOptions(guild) {
  if (!guild?.channels?.cache) {
    return [];
  }

  return guild.channels.cache
    .filter((channel) => channel && [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type))
    .sort((left, right) => {
      const byPosition = Number(left.rawPosition || 0) - Number(right.rawPosition || 0);
      if (byPosition !== 0) {
        return byPosition;
      }
      return String(left.name || "").localeCompare(String(right.name || ""));
    })
    .map((channel) => ({
      label: truncate(channel.name || `voice-${channel.id}`, 80),
      value: channel.id,
      description: channel.type === ChannelType.GuildStageVoice ? "Stage channel" : "Voice channel",
    }))
    .slice(0, 25);
}

function buildVoicePanelComponents(ownerId, guild, hasTarget = false) {
  const moveOptions = buildVoiceMoveOptions(guild);

  const userRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(buildVoicePanelCustomId("user", ownerId))
      .setPlaceholder("Выбери участника")
      .setMinValues(1)
      .setMaxValues(1)
  );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildVoicePanelCustomId("action", ownerId, "mute"))
      .setLabel("Замутить")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTarget),
    new ButtonBuilder()
      .setCustomId(buildVoicePanelCustomId("action", ownerId, "unmute"))
      .setLabel("Размутить")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTarget),
    new ButtonBuilder()
      .setCustomId(buildVoicePanelCustomId("action", ownerId, "deafen"))
      .setLabel("Уши OFF")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTarget),
    new ButtonBuilder()
      .setCustomId(buildVoicePanelCustomId("action", ownerId, "undeafen"))
      .setLabel("Уши ON")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTarget),
    new ButtonBuilder()
      .setCustomId(buildVoicePanelCustomId("action", ownerId, "disconnect"))
      .setLabel("Кик из войса")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasTarget)
  );

  const moveRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildVoicePanelCustomId("move", ownerId))
      .setPlaceholder(moveOptions.length ? "Переместить в любой voice-канал" : "Нет voice-каналов")
      .setMinValues(1)
      .setMaxValues(1)
      .setDisabled(!hasTarget || moveOptions.length === 0)
      .addOptions(
        moveOptions.length
          ? moveOptions
          : [{ label: "Нет голосовых каналов", value: "none", description: "Создай voice-канал" }]
      )
  );

  const utilityRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildVoicePanelCustomId("action", ownerId, "clear"))
      .setLabel("Сбросить выбор")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasTarget),
    new ButtonBuilder()
      .setCustomId(buildVoicePanelCustomId("action", ownerId, "refresh"))
      .setLabel("Обновить")
      .setStyle(ButtonStyle.Secondary)
  );

  return [userRow, actionRow, moveRow, utilityRow];
}

function buildVoicePanelEmbed({ guild, targetMember, lastAction = "" }) {
  const targetLabel = targetMember ? `<@${targetMember.id}>` : "Не выбран";
  const voiceChannelLabel = targetMember?.voice?.channelId
    ? `<#${targetMember.voice.channelId}>`
    : "Не в голосовом";
  const muteLabel = targetMember ? (targetMember.voice.serverMute ? "Да" : "Нет") : "—";
  const deafLabel = targetMember ? (targetMember.voice.serverDeaf ? "Да" : "Нет") : "—";

  const embed = new EmbedBuilder()
    .setColor(0x4da3ff)
    .setTitle("Voice Панель")
    .setDescription("Эту панель видишь только ты.")
    .addFields(
      { name: "Сервер", value: safeLinkText(guild?.name || "Unknown"), inline: true },
      { name: "Цель", value: targetLabel, inline: true },
      { name: "Канал", value: voiceChannelLabel, inline: true },
      { name: "Server Mute", value: muteLabel, inline: true },
      { name: "Server Deaf", value: deafLabel, inline: true },
      { name: "Последнее действие", value: lastAction || "—", inline: false }
    )
    .setTimestamp(new Date());

  return embed;
}

async function resolveVoicePanelTargetMember(guild, state) {
  if (!state?.targetUserId) {
    return null;
  }

  const member = await guild.members.fetch(state.targetUserId).catch(() => null);
  return member || null;
}

function ensureVoiceTargetForAction(targetMember, actionName) {
  if (!targetMember) {
    return "Сначала выбери участника.";
  }

  if (!targetMember.voice?.channelId) {
    return `Участник ${safeLinkText(targetMember.user?.tag || targetMember.displayName || targetMember.id)} не в голосовом канале.`;
  }

  if (actionName === "disconnect" && !targetMember.voice.channelId) {
    return "Участник уже не в голосовом канале.";
  }

  return "";
}

async function executeVoicePanelAction({ action, targetMember, actor, destinationChannel }) {
  const reason = `Voice panel by ${actor.tag} (${actor.id})`;

  if (action === "refresh") {
    return "Панель обновлена.";
  }

  if (action === "clear") {
    return "Выбор участника сброшен.";
  }

  const targetName = safeLinkText(targetMember.displayName || targetMember.user?.tag || targetMember.id);

  if (action === "mute") {
    await targetMember.voice.setMute(true, reason);
    return `🔇 ${targetName} замучен.`;
  }

  if (action === "unmute") {
    await targetMember.voice.setMute(false, reason);
    return `🔊 ${targetName} размучен.`;
  }

  if (action === "deafen") {
    await targetMember.voice.setDeaf(true, reason);
    return `🎧 ${targetName}: уши выключены.`;
  }

  if (action === "undeafen") {
    await targetMember.voice.setDeaf(false, reason);
    return `🎧 ${targetName}: уши включены.`;
  }

  if (action === "disconnect") {
    await targetMember.voice.setChannel(null, reason);
    return `⛔ ${targetName} отключён от войса.`;
  }

  if (action === "move") {
    await targetMember.voice.setChannel(destinationChannel, reason);
    return `➡️ ${targetName} перемещён в <#${destinationChannel.id}>.`;
  }

  return "Неизвестное действие.";
}

async function handleVoicePanel(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Команда доступна только на сервере.", ...EPHEMERAL_REPLY });
    return;
  }

  if (!canUseVoicePanel(interaction)) {
    await interaction.reply({
      content: "Эта панель доступна только для `darksnowlucky`.",
      ...EPHEMERAL_REPLY,
    });
    return;
  }

  cleanupVoicePanelState();
  await interaction.reply({
    embeds: [buildVoicePanelEmbed({ guild: interaction.guild, targetMember: null })],
    components: buildVoicePanelComponents(interaction.user.id, interaction.guild, false),
    ...EPHEMERAL_REPLY,
  });

  const panelMessage = await interaction.fetchReply().catch(() => null);
  if (!panelMessage?.id) {
    return;
  }

  voicePanelStateByMessageId.set(panelMessage.id, {
    ownerId: interaction.user.id,
    guildId: interaction.guildId,
    targetUserId: null,
    lastAction: "",
    updatedAt: Date.now(),
  });
}

async function handleVoicePanelComponent(interaction) {
  const parsed = parseVoicePanelCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Компонент доступен только на сервере.", ...EPHEMERAL_REPLY }).catch(() => null);
    return true;
  }

  if (interaction.user.id !== parsed.ownerId) {
    await interaction
      .reply({ content: `Эта панель доступна только <@${parsed.ownerId}>.`, ...EPHEMERAL_REPLY })
      .catch(() => null);
    return true;
  }

  if (!canUseVoicePanel(interaction)) {
    await interaction
      .reply({
        content: "Эта панель доступна только для `darksnowlucky`.",
        ...EPHEMERAL_REPLY,
      })
      .catch(() => null);
    return true;
  }

  cleanupVoicePanelState();
  const messageId = interaction.message?.id;
  if (!messageId) {
    await interaction.reply({ content: "Панель не найдена. Запусти /voicepanel снова.", ...EPHEMERAL_REPLY }).catch(() => null);
    return true;
  }

  const state = voicePanelStateByMessageId.get(messageId) || {
    ownerId: parsed.ownerId,
    guildId: interaction.guildId,
    targetUserId: null,
    lastAction: "",
    updatedAt: Date.now(),
  };

  if (parsed.type === "user") {
    const targetUserId = interaction.values?.[0] || null;
    state.targetUserId = targetUserId;
    state.lastAction = targetUserId ? `Выбран <@${targetUserId}>.` : "Выбор сброшен.";
    state.updatedAt = Date.now();
    voicePanelStateByMessageId.set(messageId, state);

    const targetMember = await resolveVoicePanelTargetMember(interaction.guild, state);
    if (!targetMember && state.targetUserId) {
      state.targetUserId = null;
      state.lastAction = "Участник не найден на сервере.";
      state.updatedAt = Date.now();
      voicePanelStateByMessageId.set(messageId, state);
    }

    await interaction
      .update({
        embeds: [buildVoicePanelEmbed({ guild: interaction.guild, targetMember, lastAction: state.lastAction })],
        components: buildVoicePanelComponents(state.ownerId, interaction.guild, Boolean(targetMember)),
      })
      .catch(() => null);
    return true;
  }

  let targetMember = await resolveVoicePanelTargetMember(interaction.guild, state);
  if (!targetMember && state.targetUserId) {
    state.targetUserId = null;
    state.lastAction = "Выбранный участник не найден на сервере.";
  }

  if (parsed.type === "move") {
    if (!targetMember) {
      await interaction.reply({ content: "Сначала выбери участника.", ...EPHEMERAL_REPLY }).catch(() => null);
      return true;
    }

    const destinationId = interaction.values?.[0];
    if (!destinationId || destinationId === "none") {
      await interaction.reply({ content: "Нет доступного канала для перемещения.", ...EPHEMERAL_REPLY }).catch(() => null);
      return true;
    }

    const destinationChannel =
      interaction.guild.channels.cache.get(destinationId) ||
      (await interaction.guild.channels.fetch(destinationId).catch(() => null));

    if (
      !destinationChannel ||
      ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(destinationChannel.type)
    ) {
      await interaction.reply({ content: "Выбран неверный голосовой канал.", ...EPHEMERAL_REPLY }).catch(() => null);
      return true;
    }

    const targetError = ensureVoiceTargetForAction(targetMember, "move");
    if (targetError) {
      await interaction.reply({ content: targetError, ...EPHEMERAL_REPLY }).catch(() => null);
      return true;
    }

    try {
      const actionText = await executeVoicePanelAction({
        action: "move",
        targetMember,
        actor: interaction.user,
        destinationChannel,
      });
      state.lastAction = actionText;
      state.updatedAt = Date.now();
      voicePanelStateByMessageId.set(messageId, state);
    } catch (error) {
      state.lastAction = `Ошибка: ${error.message}`;
      state.updatedAt = Date.now();
      voicePanelStateByMessageId.set(messageId, state);
    }

    targetMember = await resolveVoicePanelTargetMember(interaction.guild, state);
    await interaction
      .update({
        embeds: [buildVoicePanelEmbed({ guild: interaction.guild, targetMember, lastAction: state.lastAction })],
        components: buildVoicePanelComponents(state.ownerId, interaction.guild, Boolean(targetMember)),
      })
      .catch(() => null);
    return true;
  }

  if (parsed.type === "action") {
    const action = parsed.action;
    if (action === "clear") {
      state.targetUserId = null;
      state.lastAction = "Выбор участника сброшен.";
      state.updatedAt = Date.now();
      voicePanelStateByMessageId.set(messageId, state);

      await interaction
        .update({
          embeds: [buildVoicePanelEmbed({ guild: interaction.guild, targetMember: null, lastAction: state.lastAction })],
          components: buildVoicePanelComponents(state.ownerId, interaction.guild, false),
        })
        .catch(() => null);
      return true;
    }

    if (action !== "refresh") {
      const targetError = ensureVoiceTargetForAction(targetMember, action);
      if (targetError) {
        await interaction.reply({ content: targetError, ...EPHEMERAL_REPLY }).catch(() => null);
        return true;
      }
    }

    try {
      const actionText = await executeVoicePanelAction({
        action,
        targetMember,
        actor: interaction.user,
        destinationChannel: null,
      });
      state.lastAction = actionText;
    } catch (error) {
      state.lastAction = `Ошибка: ${error.message}`;
    }

    state.updatedAt = Date.now();
    voicePanelStateByMessageId.set(messageId, state);
    targetMember = await resolveVoicePanelTargetMember(interaction.guild, state);

    await interaction
      .update({
        embeds: [buildVoicePanelEmbed({ guild: interaction.guild, targetMember, lastAction: state.lastAction })],
        components: buildVoicePanelComponents(state.ownerId, interaction.guild, Boolean(targetMember)),
      })
      .catch(() => null);
    return true;
  }

  await interaction.reply({ content: "Неизвестный элемент панели.", ...EPHEMERAL_REPLY }).catch(() => null);
  return true;
}

async function handlePlayRequest(interaction, manager, rawQuery) {
  const query = String(rawQuery || "").trim();
  if (!query) {
    await interaction.reply({ content: "Укажи ссылку или текстовый запрос.", ...EPHEMERAL_REPLY }).catch(() => null);
    return;
  }

  const memberVoice = interaction.member?.voice?.channel;
  if (!memberVoice) {
    const player = manager.get(interaction.guild.id);
    const hasActiveMusic = Boolean(player?.currentTrack) || (Array.isArray(player?.queue) && player.queue.length > 0) || Boolean(player?.transitionLock);
    const buttonLabel = hasActiveMusic ? "Добавить трек" : "ВКЛЮЧИТЬ МУЗЫКУ СЕЙЧАС";
    await interaction.reply({ content: `Зайди в голосовой канал и нажми красную кнопку «${buttonLabel}» в плеере выше.`, ...EPHEMERAL_REPLY });
    return;
  }

  const botVoiceId = interaction.guild.members.me?.voice?.channelId;
  if (botVoiceId && botVoiceId !== memberVoice.id) {
    await interaction.reply({
      content:
        "\u042f \u0443\u0436\u0435 \u0432 \u0434\u0440\u0443\u0433\u043e\u043c \u0433\u043e\u043b\u043e\u0441\u043e\u0432\u043e\u043c \u043a\u0430\u043d\u0430\u043b\u0435. \u0417\u0430\u0439\u0434\u0438 \u0442\u0443\u0434\u0430 \u0438\u043b\u0438 \u043e\u0441\u0442\u0430\u043d\u043e\u0432\u0438 \u043f\u043b\u0435\u0435\u0440 \u0447\u0435\u0440\u0435\u0437 `/stop`.",
      ...EPHEMERAL_REPLY,
    });
    return;
  }

  await interaction.deferReply();
  const progress = createPlayProgressReporter(interaction);
  await progress.update(1, "Принял запрос");
  await progress.update(5, "Ожидаю очередь обработки");
  let interactionTimedOut = false;
  let thinkingTimer = null;
  if (HAS_PLAY_REQUEST_TIMEOUT) {
    const timeoutSec = Math.max(1, Math.round(PLAY_REQUEST_TIMEOUT_MS / 1000));
    thinkingTimer = setTimeout(async () => {
      interactionTimedOut = true;
      thinkingTimer = null;
      await interaction
        .editReply({
          embeds: [
            buildActionEmbed(
              "\u0422\u0430\u0439\u043c\u0430\u0443\u0442 \u0437\u0430\u043f\u0440\u043e\u0441\u0430",
              `\u041d\u0435 \u0443\u0441\u043f\u0435\u043b \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c \u0437\u0430\u043f\u0440\u043e\u0441 \u0437\u0430 ${timeoutSec} \u0441\u0435\u043a\u0443\u043d\u0434. \u041d\u0430\u0436\u043c\u0438 \u043a\u043d\u043e\u043f\u043a\u0443 \u00ab\u0412\u041a\u041b\u042e\u0427\u0418\u0422\u042c \u041c\u0423\u0417\u042b\u041a\u0423 \u0421\u0415\u0419\u0427\u0410\u0421\u00bb \u0438 \u043f\u043e\u0432\u0442\u043e\u0440\u0438 \u0437\u0430\u043f\u0440\u043e\u0441.`
            ),
          ],
          components: [],
        })
        .catch(() => null);
    }, PLAY_REQUEST_TIMEOUT_MS);
  }

  const clearThinkingTimer = () => {
    if (!thinkingTimer) {
      return;
    }
    clearTimeout(thinkingTimer);
    thinkingTimer = null;
  };

  const ensurePlayActive = () => {
    if (interactionTimedOut) {
      throw buildPlayTimeoutError();
    }
  };

  const runWithPlayTimeout = (promise) =>
    HAS_PLAY_REQUEST_TIMEOUT
      ? withPromiseTimeout(promise, PLAY_REQUEST_TIMEOUT_MS, buildPlayTimeoutError)
      : Promise.resolve(promise);

  await enqueuePlayRequest(interaction.guild.id, async () => {
    try {
      await progress.update(12, "Разбираю запрос");
      ensurePlayActive();
      const isDirectUrl = isUrlLike(query);
      let tracksToAdd = [];

      if (isDirectUrl) {
        await progress.update(30, "Получаю данные по ссылке");
        const stopUrlResolveHeartbeat = startUrlResolveHeartbeat(progress);
        let resolved;
        try {
          const resolvePromise = HAS_URL_RESOLVE_TIMEOUT
            ? withPromiseTimeout(resolveTracks(query, interaction.user), URL_RESOLVE_TIMEOUT_MS, buildUrlResolveTimeoutError)
            : resolveTracks(query, interaction.user);
          resolved = await runWithPlayTimeout(resolvePromise);
        } finally {
          stopUrlResolveHeartbeat();
        }
        ensurePlayActive();
        await progress.update(62, "Ссылку обработал");
        tracksToAdd = resolved.tracks;

        if (tracksToAdd.length === 1 && tracksToAdd[0]?.searchQuery) {
          const primaryTrack = tracksToAdd[0];
          await progress.update(48, "Ищу похожие варианты");
          const extraCandidates = await runWithPlayTimeout(
            resolveSearchCandidates(primaryTrack.searchQuery, interaction.user, {
              limit: 8,
            })
          ).catch(() => []);
          ensurePlayActive();
          const candidates = buildLinkPickerCandidates(primaryTrack, extraCandidates);

          if (candidates.length > 1) {
            clearThinkingTimer();
            progress.stop();
            const selectedTrack = await pickTrackFromMenu(interaction, primaryTrack.searchQuery, candidates);
            if (!selectedTrack) return;

            selectedTrack.searchQuery = primaryTrack.searchQuery;
            selectedTrack.fallbackTracks = candidates.filter((candidate) => candidate.url !== selectedTrack.url).slice(0, 4);
            tracksToAdd = [selectedTrack];
          } else if (candidates.length === 1) {
            const selectedTrack = candidates[0];
            selectedTrack.searchQuery = primaryTrack.searchQuery;
            selectedTrack.fallbackTracks = [];
            tracksToAdd = [selectedTrack];
          }
        }
      } else {
        await progress.update(35, "Ищу подходящие треки");
        const candidates = await runWithPlayTimeout(resolveSearchCandidates(query, interaction.user, { limit: 5 }));
        ensurePlayActive();
        if (!candidates.length) {
          clearThinkingTimer();
          progress.stop();
          await interaction.editReply("\u041d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e \u043f\u043e \u0437\u0430\u043f\u0440\u043e\u0441\u0443.");
          return;
        }

        clearThinkingTimer();
        progress.stop();
        const selectedTrack = await pickTrackFromMenu(interaction, query, candidates);
        if (!selectedTrack) return;

        selectedTrack.searchQuery = query;
        selectedTrack.fallbackTracks = candidates.filter((candidate) => candidate.url !== selectedTrack.url).slice(0, 4);
        tracksToAdd = [selectedTrack];
      }

      if (!tracksToAdd.length) {
        clearThinkingTimer();
        progress.stop();
        await interaction.editReply("\u041d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e \u043f\u043e \u0437\u0430\u043f\u0440\u043e\u0441\u0443.");
        return;
      }

      await progress.update(70, "Подключаюсь к голосовому каналу");
      const player = manager.getOrCreate(interaction.guild);
      await player.setTextChannel(interaction.channelId);
      await runWithPlayTimeout(player.connect(memberVoice));
      ensurePlayActive();
      const wasQueueEmpty = !player.currentTrack && !player.transitionLock && player.queue.length === 0;

      await progress.update(85, "Добавляю трек в очередь");
      ensurePlayActive();
      const { accepted, dropped } = player.addTracks(tracksToAdd);
      if (accepted === 0) {
        clearThinkingTimer();
        progress.stop();
        await interaction.editReply(
          "\u041e\u0447\u0435\u0440\u0435\u0434\u044c \u0437\u0430\u043f\u043e\u043b\u043d\u0435\u043d\u0430, \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u043d\u043e\u0432\u044b\u0435 \u0442\u0440\u0435\u043a\u0438 \u043f\u043e\u043a\u0430 \u043d\u0435\u043b\u044c\u0437\u044f."
        );
        return;
      }

      const first = tracksToAdd[0];
      const summary =
        accepted === 1
          ? `[${safeLinkText(first.title)}](${first.url}) \u00b7 ${formatDuration(first.durationSec)}`
          : `\u0414\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u043e \u0442\u0440\u0435\u043a\u043e\u0432: ${accepted}`;
      await progress.update(95, "Запускаю воспроизведение");
      const startedNow = await runWithPlayTimeout(player.playIfIdle({ movePanelToBottomOnStart: wasQueueEmpty }));

      if (wasQueueEmpty) {
        if (!startedNow) {
          await movePlayerPanelBelowActions(player);
        }
        clearThinkingTimer();
        progress.stop();
        await clearDeferredReply(interaction);
        return;
      }

      const dropHint =
        dropped > 0 ? `\n\u041d\u0435 \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u043e \u0438\u0437-\u0437\u0430 \u043b\u0438\u043c\u0438\u0442\u0430 \u043e\u0447\u0435\u0440\u0435\u0434\u0438: ${dropped}` : "";
      const requestedBy = first?.requestedById ? `<@${first.requestedById}>` : safeLinkText(first?.requestedByTag || "unknown");
      await progress.update(100, "Готово");
      clearThinkingTimer();
      progress.stop();
      await interaction.editReply({
        embeds: [
          buildActionEmbed(
            "\u0414\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u043e \u0432 \u043e\u0447\u0435\u0440\u0435\u0434\u044c",
            `${summary}${dropHint}\n\u0417\u0430\u043f\u0440\u043e\u0441\u0438\u043b ${requestedBy}`
          ),
        ],
      });
      await player.refreshPanel({ moveToBottom: true });
    } catch (error) {
      if (error?.code === PLAY_TIMEOUT_ERROR_CODE) {
        return;
      }
      if (error?.code === URL_RESOLVE_TIMEOUT_ERROR_CODE) {
        clearThinkingTimer();
        progress.stop();
        const timeoutSec = Math.max(1, Math.round(URL_RESOLVE_TIMEOUT_MS / 1000));
        await interaction
          .editReply({
            embeds: [
              buildActionEmbed(
                "Таймаут разбора ссылки",
                `Не успел обработать ссылку за ${timeoutSec} сек. Попробуй ещё раз или отправь другую ссылку.`
              ),
            ],
            components: [],
          })
          .catch(() => null);
        return;
      }

      clearThinkingTimer();
      progress.stop();
      console.error("[Command:/play]", { query }, error);
      await interaction.editReply(`\u041e\u0448\u0438\u0431\u043a\u0430: ${error.message}`);
    } finally {
      clearThinkingTimer();
      progress.stop();
      await progress.wait();
    }
  });
}

async function handlePlay(interaction, manager) {
  const query = interaction.options.getString("query", true);
  await handlePlayRequest(interaction, manager, query);
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
    await interaction
      .followUp({
        embeds: [buildActionEmbed("Скип", buildSkipNotice(result, interaction))],
        allowedMentions: { users: [interaction.user.id] },
      })
      .catch(() => null);
    await movePlayerPanelBelowActions(player);
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
    await interaction.deleteReply().catch(() => null);
    return;
  }

  await interaction.editReply(result.message);
}

async function handleLeave(interaction, manager) {
  const player = manager.get(interaction.guild.id);
  if (!player) {
    await interaction.reply({
      content:
        "\u0411\u043e\u0442 \u0443\u0436\u0435 \u043d\u0435 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d \u043a \u0433\u043e\u043b\u043e\u0441\u043e\u0432\u043e\u043c\u0443 \u043a\u0430\u043d\u0430\u043b\u0443.",
      ...EPHEMERAL_REPLY,
    });
    return;
  }

  const voiceCheck = isSameVoiceWithBot(interaction, player);
  if (!voiceCheck.ok) {
    await interaction.reply({ content: voiceCheck.message, ...EPHEMERAL_REPLY });
    return;
  }

  await interaction.deferReply({ ...EPHEMERAL_REPLY });
  const result = await player.leave();

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

  if (interaction.customId === BUTTON_IDS.quickPlay) {
    await showQuickPlayModal(interaction);
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

  if (interaction.customId === BUTTON_IDS.queueOpen) {
    setQueuePickerPage(interaction, 0);
    await interaction.reply({
      ...buildQueuePickerPayload(player, 0),
      ...EPHEMERAL_REPLY,
    });
    return;
  }

  if (interaction.customId === QUEUE_PICKER_CLOSE_ID) {
    await interaction.update({
      embeds: [buildActionEmbed("Очередь", "Меню очереди закрыто.")],
      components: [],
    });
    return;
  }

  if (interaction.customId === QUEUE_PICKER_PREV_ID || interaction.customId === QUEUE_PICKER_NEXT_ID) {
    const totalPages = Math.max(1, Math.ceil(player.queue.length / QUEUE_PICKER_PAGE_SIZE));
    const currentPage = getQueuePickerPage(interaction, totalPages);
    const nextPage =
      interaction.customId === QUEUE_PICKER_PREV_ID
        ? Math.max(0, currentPage - 1)
        : Math.min(totalPages - 1, currentPage + 1);
    setQueuePickerPage(interaction, nextPage);
    await interaction.update(buildQueuePickerPayload(player, nextPage));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === QUEUE_PICKER_SELECT_ID) {
    const selectedIndex = Number(interaction.values?.[0]);
    const result = await player.playQueueIndex(selectedIndex);
    const totalPages = Math.max(1, Math.ceil(player.queue.length / QUEUE_PICKER_PAGE_SIZE));
    const currentPage = getQueuePickerPage(interaction, totalPages);
    const page = Math.max(0, Math.min(totalPages - 1, currentPage));
    setQueuePickerPage(interaction, page);
    await interaction.update(buildQueuePickerPayload(player, page, { notice: result.message }));
    if (result.ok) {
      await player.refreshPanel({ moveToBottom: true });
    }
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
      return;
    }
    await interaction
      .followUp({
        embeds: [buildActionEmbed("Скип", buildSkipNotice(result, interaction))],
        allowedMentions: { users: [interaction.user.id] },
      })
      .catch(() => null);
    await movePlayerPanelBelowActions(player);
    return;
  }

  if (interaction.customId === BUTTON_IDS.stop) {
    const result = await player.stop();
    if (result.ok) {
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
    const mode = await player.cycleLoopMode();
    await interaction
      .followUp({
        embeds: [buildActionEmbed("Цикл", buildLoopNotice(mode, interaction))],
        allowedMentions: { users: [interaction.user.id] },
      })
      .catch(() => null);
    await movePlayerPanelBelowActions(player);
    return;
  }

  await interaction.followUp({ content: "Неизвестная кнопка.", ...EPHEMERAL_REPLY });
}

async function handleModalSubmit(interaction, manager) {
  if (!interaction.isModalSubmit() || interaction.customId !== QUICK_PLAY_MODAL_ID) {
    return false;
  }

  if (!(await ensureMusicChannel(interaction))) {
    return true;
  }

  const query = String(interaction.fields.getTextInputValue(QUICK_PLAY_QUERY_INPUT_ID) || "").trim();
  if (!query) {
    await interaction.reply({ content: "Укажи ссылку или текстовый запрос.", ...EPHEMERAL_REPLY }).catch(() => null);
    return true;
  }

  await handlePlayRequest(interaction, manager, query);
  return true;
}

async function handleChatInput(interaction, manager) {
  if (interaction.commandName === "voicepanel") {
    await handleVoicePanel(interaction);
    return;
  }

  if (interaction.commandName === "leave") {
    await handleLeave(interaction, manager);
    return;
  }

  await interaction.reply({
    content:
      "Slash-\u043a\u043e\u043c\u0430\u043d\u0434\u044b \u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d\u044b. \u0418\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0439 \u043a\u043d\u043e\u043f\u043a\u0438 \u043c\u0443\u0437\u044b\u043a\u0430\u043b\u044c\u043d\u043e\u0439 \u043f\u0430\u043d\u0435\u043b\u0438.",
    ...EPHEMERAL_REPLY,
  });
}

function buildPercentBar(percent, size = 20) {
  const clamped = Math.max(1, Math.min(100, Math.round(Number(percent) || 1)));
  const filled = Math.max(1, Math.min(size, Math.round((clamped / 100) * size)));
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, size - filled))}]`;
}

function createPlayProgressReporter(interaction) {
  let active = true;
  let lastPercent = 0;
  let lastText = "";
  let lastUpdateAt = 0;
  let queue = Promise.resolve();

  const update = async (percent, text) => {
    if (!active) {
      return;
    }

    const clamped = Math.max(1, Math.min(100, Math.round(Number(percent) || 1)));
    const normalizedText = String(text || "Обрабатываю запрос...");
    const now = Date.now();

    if (
      clamped === lastPercent &&
      normalizedText === lastText &&
      now - lastUpdateAt < 1200
    ) {
      return;
    }

    lastPercent = clamped;
    lastText = normalizedText;
    lastUpdateAt = now;
    const bar = buildPercentBar(clamped);

    queue = queue.finally(() =>
      interaction
        .editReply({
          embeds: [
            buildActionEmbed(
              "Обработка запроса",
              `${safeLinkText(normalizedText)}\n\`${bar}\` **${clamped}%**`
            ),
          ],
          components: [],
        })
        .catch(() => null)
    );

    await queue;
  };

  return {
    update,
    stop: () => {
      active = false;
    },
    wait: async () => {
      await queue.catch(() => null);
    },
  };
}

module.exports = {
  handleChatInput,
  handleButton,
  handleModalSubmit,
  handleVoicePanelComponent,
};
