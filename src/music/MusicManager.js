const { ChannelType } = require("discord.js");
const { MUSIC_TEXT_CHANNEL_ID, MUSIC_TEXT_CHANNEL_NAME } = require("../config");
const { buildPanelComponents, buildPlayerEmbed } = require("../ui/panel");
const { GuildMusicPlayer } = require("./GuildMusicPlayer");

const DEFAULT_MUSIC_CHANNEL_NAME = "музыка";

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

  async resolveMusicTextChannel(guild) {
    if (!guild) {
      return null;
    }

    if (MUSIC_TEXT_CHANNEL_ID) {
      const byId = guild.channels.cache.get(MUSIC_TEXT_CHANNEL_ID) || (await guild.channels.fetch(MUSIC_TEXT_CHANNEL_ID).catch(() => null));
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

  async ensureIdlePanelForGuild(guild) {
    const channel = await this.resolveMusicTextChannel(guild);
    if (!channel?.isTextBased()) {
      return;
    }

    const messages = await channel.messages.fetch({ limit: 30 }).catch(() => null);
    const existingPanel = messages
      ? [...messages.values()].find((message) => this.isMusicPanelMessage(message))
      : null;

    if (existingPanel) {
      return;
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
}

module.exports = {
  MusicManager,
};
