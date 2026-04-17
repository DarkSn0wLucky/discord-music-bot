const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  StreamType,
} = require("@discordjs/voice");
const play = require("play-dl");
const { AUTO_DISCONNECT_MS, DEFAULT_VOLUME, MAX_QUEUE_SIZE } = require("../config");
const { buildActionEmbed, buildControlsRow, buildPlayerEmbed, buildQueueEmbed } = require("../ui/panel");
const { safeLinkText } = require("../utils/format");

class GuildMusicPlayer {
  constructor({ guild, client }) {
    this.guild = guild;
    this.client = client;

    this.queue = [];
    this.currentTrack = null;
    this.loopMode = "off";
    this.forceSkip = false;
    this.transitionLock = false;

    this.textChannelId = null;
    this.panelMessageId = null;
    this.voiceChannelId = null;
    this.connection = null;
    this.boundConnection = null;
    this.autoDisconnectTimer = null;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.handleTrackEnd().catch((error) => {
        console.error(`[Music:${this.guild.id}] Idle handler failed`, error);
      });
    });

    this.player.on("error", (error) => {
      console.error(`[Music:${this.guild.id}] Audio player error`, error);
      this.sendAction("Ошибка плеера", `Трек пропущен: \`${error.message}\``).catch(() => null);
      this.forceSkip = true;
      this.player.stop(true);
    });
  }

  async setTextChannel(channelId) {
    this.textChannelId = channelId;
  }

  isPaused() {
    return (
      this.player.state.status === AudioPlayerStatus.Paused ||
      this.player.state.status === AudioPlayerStatus.AutoPaused
    );
  }

  addTracks(tracks) {
    const available = Math.max(0, MAX_QUEUE_SIZE - this.queue.length - (this.currentTrack ? 1 : 0));
    const acceptedTracks = tracks.slice(0, available);
    this.queue.push(...acceptedTracks);
    return {
      accepted: acceptedTracks.length,
      dropped: tracks.length - acceptedTracks.length,
    };
  }

  async connect(voiceChannel) {
    this.clearAutoDisconnect();

    const existing = getVoiceConnection(this.guild.id);
    if (existing && existing.joinConfig.channelId !== voiceChannel.id) {
      existing.destroy();
    }

    const nextConnection =
      existing && existing.joinConfig.channelId === voiceChannel.id
        ? existing
        : joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: this.guild.id,
            adapterCreator: this.guild.voiceAdapterCreator,
            selfDeaf: true,
          });

    this.connection = nextConnection;
    this.voiceChannelId = voiceChannel.id;
    this.connection.subscribe(this.player);

    if (this.boundConnection !== this.connection) {
      this.boundConnection = this.connection;
      this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (!this.connection) {
          return;
        }

        try {
          await Promise.race([
            entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          await this.disconnectFromVoice(false, "Потеряно голосовое соединение.");
        }
      });
    }

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
  }

  async playIfIdle() {
    if (this.currentTrack || this.transitionLock) {
      await this.refreshPanel();
      return;
    }

    await this.playNext();
  }

  async playNext() {
    if (this.transitionLock) {
      return;
    }

    this.transitionLock = true;
    this.clearAutoDisconnect();

    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        this.currentTrack = { ...next, startedAt: Date.now() };

        try {
          const { spawn } = require("child_process");

          function createStream(url) {
            return spawn("yt-dlp", [
              "-o", "-",
              "-f", "bestaudio",
              "--no-playlist",
              url
            ], {
              stdio: ["ignore", "pipe", "ignore"]
            }).stdout;
          }

          const stream = createStream(next.url);

          const resource = createAudioResource(stream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
          });

          if (resource.volume) {
            resource.volume.setVolume(DEFAULT_VOLUME);
          }

          this.player.play(resource);
          await this.refreshPanel();
          await this.sendAction("Старт", `[${safeLinkText(next.title)}](${next.url})`);
          return;
        } catch (error) {
          this.currentTrack = null;
          await this.sendAction("Трек пропущен", `[${safeLinkText(next.title)}](${next.url})\n\`${error.message}\``);
        }
      }

      this.currentTrack = null;
      await this.refreshPanel();
      this.scheduleAutoDisconnect();
    } finally {
      this.transitionLock = false;
    }
  }

  async handleTrackEnd() {
    if (!this.currentTrack) {
      if (this.queue.length === 0) {
        this.scheduleAutoDisconnect();
      }
      return;
    }

    const finished = this.currentTrack;
    const skipped = this.forceSkip;
    this.forceSkip = false;

    if (!skipped) {
      if (this.loopMode === "track") {
        this.queue.unshift(finished);
      } else if (this.loopMode === "queue") {
        this.queue.push(finished);
      }
    }

    this.currentTrack = null;
    await this.playNext();
  }

  async togglePause() {
    if (!this.currentTrack) {
      return { ok: false, message: "Сейчас нет активного трека." };
    }

    if (this.isPaused()) {
      const resumed = this.player.unpause();
      await this.refreshPanel();
      return resumed
        ? { ok: true, message: "Продолжаю воспроизведение." }
        : { ok: false, message: "Не удалось продолжить." };
    }

    const paused = this.player.pause(true);
    await this.refreshPanel();
    return paused ? { ok: true, message: "Поставлено на паузу." } : { ok: false, message: "Не удалось поставить на паузу." };
  }

  async pause() {
    if (!this.currentTrack) {
      return { ok: false, message: "Сейчас нет активного трека." };
    }

    const paused = this.player.pause(true);
    await this.refreshPanel();
    return paused ? { ok: true, message: "Пауза." } : { ok: false, message: "Не удалось поставить на паузу." };
  }

  async resume() {
    const resumed = this.player.unpause();
    await this.refreshPanel();
    return resumed ? { ok: true, message: "Продолжаю." } : { ok: false, message: "Не удалось продолжить." };
  }

  async skip() {
    if (!this.currentTrack) {
      return { ok: false, message: "Сейчас нечего скипать." };
    }

    this.forceSkip = true;
    this.player.stop(true);
    await this.sendAction("Скип", "Текущий трек пропущен.");
    return { ok: true, message: "Трек пропущен." };
  }

  async stop() {
    const hadTracks = Boolean(this.currentTrack) || this.queue.length > 0;
    this.clearAutoDisconnect();
    this.queue = [];
    this.currentTrack = null;
    this.forceSkip = true;
    this.player.stop(true);
    await this.disconnectFromVoice(true);
    await this.refreshPanel();
    return hadTracks ? { ok: true, message: "Очередь очищена, бот отключён." } : { ok: false, message: "Очередь уже пуста." };
  }

  async shuffle() {
    if (this.queue.length < 2) {
      return { ok: false, message: "Для шафла нужно минимум 2 трека в очереди." };
    }

    for (let i = this.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }

    await this.refreshPanel();
    return { ok: true, message: "Очередь перемешана." };
  }

  async cycleLoopMode() {
    if (this.loopMode === "off") {
      this.loopMode = "track";
    } else if (this.loopMode === "track") {
      this.loopMode = "queue";
    } else {
      this.loopMode = "off";
    }

    await this.refreshPanel();
    return this.loopMode;
  }

  async setLoopMode(mode) {
    if (!["off", "track", "queue"].includes(mode)) {
      return false;
    }

    this.loopMode = mode;
    await this.refreshPanel();
    return true;
  }

  async disconnectFromVoice(sendNotice = false, reason = "Отключаюсь.") {
    if (sendNotice) {
      await this.sendAction("Стоп", reason);
    }

    if (this.connection) {
      this.connection.destroy();
    }

    this.connection = null;
    this.boundConnection = null;
    this.voiceChannelId = null;
  }

  scheduleAutoDisconnect() {
    if (!this.connection || AUTO_DISCONNECT_MS <= 0 || this.autoDisconnectTimer) {
      return;
    }

    this.autoDisconnectTimer = setTimeout(async () => {
      this.autoDisconnectTimer = null;

      if (this.currentTrack || this.queue.length > 0 || !this.connection) {
        return;
      }

      await this.disconnectFromVoice(true, "Пустая очередь более 3 минут.");
      await this.refreshPanel();
    }, AUTO_DISCONNECT_MS);
  }

  clearAutoDisconnect() {
    if (!this.autoDisconnectTimer) {
      return;
    }

    clearTimeout(this.autoDisconnectTimer);
    this.autoDisconnectTimer = null;
  }

  async getTextChannel() {
    if (!this.textChannelId) {
      return null;
    }

    const cached = this.client.channels.cache.get(this.textChannelId);
    if (cached?.isTextBased()) {
      return cached;
    }

    try {
      const fetched = await this.client.channels.fetch(this.textChannelId);
      return fetched?.isTextBased() ? fetched : null;
    } catch {
      return null;
    }
  }

  async refreshPanel() {
    const channel = await this.getTextChannel();
    if (!channel) {
      return;
    }

    const payload = {
      embeds: [buildPlayerEmbed(this)],
      components: [buildControlsRow(this)],
    };

    if (this.panelMessageId) {
      try {
        const message = await channel.messages.fetch(this.panelMessageId);
        await message.edit(payload);
        return;
      } catch {
        this.panelMessageId = null;
      }
    }

    const message = await channel.send(payload);
    this.panelMessageId = message.id;
  }

  async sendQueue() {
    const channel = await this.getTextChannel();
    if (!channel) {
      return;
    }

    await channel.send({ embeds: [buildQueueEmbed(this)] });
  }

  async sendAction(title, description) {
    const channel = await this.getTextChannel();
    if (!channel) {
      return;
    }

    await channel.send({
      embeds: [buildActionEmbed(title, description)],
    });
  }
}

module.exports = {
  GuildMusicPlayer,
};
