const { GuildMusicPlayer } = require("./GuildMusicPlayer");

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
}

module.exports = {
  MusicManager,
};
