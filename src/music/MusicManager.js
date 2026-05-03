const { AudioPlayerStatus, getVoiceConnection } = require("@discordjs/voice");
const { ChannelType } = require("discord.js");
const { MUSIC_TEXT_CHANNEL_ID, MUSIC_TEXT_CHANNEL_NAME } = require("../config");
const { buildPanelComponents, buildPlayerEmbed } = require("../ui/panel");
const { GuildMusicPlayer } = require("./GuildMusicPlayer");

const DEFAULT_MUSIC_CHANNEL_NAME = "\u043c\u0443\u0437\u044b\u043a\u0430";
const IDLE_PANEL_BUMP_MS = 5 * 60_000;
const QUICKPLAY_BUTTON_ID = "music:quickplay";

function normalizeChannelName(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
}

class MusicManager {
  constructor(client) {
    this.client = client;
    this.players = new Map();
    this.idlePanelBumpTimer = null;
  }

  get(guildId) {
    return this.players.get(guildId);
  }

  delete(guildId) {
    this.players.delete(guildId);
  }

  getOrCreate(guild) {
    const existing = this.players.get(guild.id);
    if (existing) {
      return existing;
    }

    const player = new GuildMusicPlayer({
      guild,
      client: this.client,
      onDispose: (guildId) => this.delete(guildId),
    });

    this.players.set(guild.id, player);
    return player;
  }

  isMusicPanelMessage(message) {
    if (!message || message.author?.id !== this.client.user?.id) {
      return false;
    }

    if (!Array.isArray(message.components) || message.components.length === 0) {
      return false;
    }

    return message.components.some((row) =>
      Array.isArray(row.components) &&
      row.components.some(
        (component) => typeof component.customId === "string" && component.customId.startsWith("music:")
      )
    );
  }

  hasQuickPlayButton(message) {
    if (!message || !Array.isArray(message.components)) {
      return false;
    }

    return message.components.some((row) =>
      Array.isArray(row.components) &&
      row.components.some((component) => component?.customId === QUICKPLAY_BUTTON_ID)
    );
  }

  async resolveMusicTextChannel(guild) {
    if (!guild) {
      return null;
    }

    if (MUSIC_TEXT_CHANNEL_ID) {
      const byId =
        guild.channels.cache.get(MUSIC_TEXT_CHANNEL_ID) ||
        (await guild.channels.fetch(MUSIC_TEXT_CHANNEL_ID).catch(() => null));
      if (byId?.isTextBased()) {
        return byId;
      }
      return null;
    }

    const expected = normalizeChannelName(MUSIC_TEXT_CHANNEL_NAME || DEFAULT_MUSIC_CHANNEL_NAME);
    if (!expected) {
      return null;
    }

    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) {
      return null;
    }

    const target = channels.find((channel) => {
      if (!channel || channel.type !== ChannelType.GuildText) {
        return false;
      }

      const normalized = normalizeChannelName(channel.name || "");
      return normalized.startsWith(expected);
    });

    return target || null;
  }

  async ensureIdlePanelForGuild(guild, options = {}) {
    const { moveToBottom = false } = options;
    const channel = await this.resolveMusicTextChannel(guild);
    if (!channel?.isTextBased()) {
      return;
    }

    const player = this.players.get(guild.id);
    if (player) {
      const voiceConnection = player.connection || getVoiceConnection(guild.id);
      const hasVoiceConnection = Boolean(voiceConnection);
      const playerState = player.player?.state?.status;
      const hasPlaybackState =
        playerState === AudioPlayerStatus.Playing ||
        playerState === AudioPlayerStatus.Paused ||
        playerState === AudioPlayerStatus.AutoPaused ||
        playerState === AudioPlayerStatus.Buffering;

      if (!hasVoiceConnection && !hasPlaybackState && (player.currentTrack || player.queue.length > 0 || player.transitionLock)) {
        player.currentTrack = null;
        player.queue = [];
        player.transitionLock = false;
        player.forceSkip = false;
        player.preservePanelOnNextTrack = false;
        player.suppressNextTrackAction = false;
        player.stopProgressUpdater();
      }

      const hasActivePlayback = Boolean(player.currentTrack) || player.queue.length > 0 || player.transitionLock;
      if (hasActivePlayback) {
        return;
      }

      await player.setTextChannel(channel.id);
      await player.refreshPanel({ moveToBottom: true });
      return;
    }

    const messages = await channel.messages.fetch({ limit: 40 }).catch(() => null);
    const panelMessages = messages
      ? [...messages.values()]
          .filter((message) => this.isMusicPanelMessage(message))
          .sort((left, right) => right.createdTimestamp - left.createdTimestamp)
      : [];

    if (panelMessages.length > 0 && !moveToBottom) {
      const latestPanel = panelMessages[0];
      if (this.hasQuickPlayButton(latestPanel)) {
        return;
      }

      for (const message of panelMessages) {
        await message.delete().catch(() => null);
      }
    }

    if (moveToBottom) {
      for (const message of panelMessages) {
        await message.delete().catch(() => null);
      }
    }

    const idlePlayer = {
      currentTrack: null,
      queue: [],
      loopMode: "off",
      isPaused: () => false,
    };

    await channel
      .send({
        embeds: [buildPlayerEmbed(idlePlayer)],
        components: buildPanelComponents(idlePlayer),
      })
      .catch(() => null);
  }

  async ensureIdlePanels() {
    const guilds = Array.from(this.client.guilds.cache.values());
    for (const guild of guilds) {
      await this.ensureIdlePanelForGuild(guild).catch(() => null);
    }
  }

  async bumpIdlePanelsToBottom() {
    const guilds = Array.from(this.client.guilds.cache.values());
    for (const guild of guilds) {
      await this.ensureIdlePanelForGuild(guild, { moveToBottom: true }).catch(() => null);
    }
  }

  startIdlePanelBumpTask(intervalMs = IDLE_PANEL_BUMP_MS) {
    this.stopIdlePanelBumpTask();
    this.idlePanelBumpTimer = setInterval(() => {
      this.bumpIdlePanelsToBottom().catch(() => null);
    }, Math.max(60_000, Number(intervalMs) || IDLE_PANEL_BUMP_MS));
  }

  stopIdlePanelBumpTask() {
    if (!this.idlePanelBumpTimer) {
      return;
    }

    clearInterval(this.idlePanelBumpTimer);
    this.idlePanelBumpTimer = null;
  }
}

module.exports = {
  MusicManager,
};
