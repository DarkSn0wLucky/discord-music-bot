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

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { AUTO_DISCONNECT_MS, DEFAULT_VOLUME, MAX_QUEUE_SIZE, YTDLP_COOKIES_PATH } = require("../config");
const { buildActionEmbed, buildControlsRow, buildPlayerEmbed, buildQueueEmbed } = require("../ui/panel");
const { safeLinkText } = require("../utils/format");

function resolveYtDlpCookiesPath() {
  const configuredPath = String(YTDLP_COOKIES_PATH || "").trim();
  if (!configuredPath) {
    return null;
  }

  const absolutePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);

  return fs.existsSync(absolutePath) ? absolutePath : null;
}

function isSourceUnavailableError(message) {
  if (!message) {
    return false;
  }

  return /(not available|unavailable|private video|video is unavailable|copyright|deleted|blocked|403|410|no video formats found)/i.test(
    String(message)
  );
}

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
    this.updateInterval = null;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on("stateChange", (oldState, newState) => {
      console.log(
        `[PlayerState:${this.guild.id}] ${oldState.status} -> ${newState.status} | current=${this.currentTrack?.title || "none"}`
      );
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.handleTrackEnd().catch((error) => {
        console.error(`[Music:${this.guild.id}] Idle handler failed`, error);
      });
    });

    this.player.on("error", (error) => {
      console.error(`[Music:${this.guild.id}] Audio player error`, error);
      this.sendAction("РћС€РёР±РєР° РїР»РµРµСЂР°", `РўСЂРµРє РїСЂРѕРїСѓС‰РµРЅ: \`${error.message}\``).catch(() => null);
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
        if (!this.connection) return;

        try {
          await Promise.race([
            entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          await this.disconnectFromVoice(false, "РџРѕС‚РµСЂСЏРЅРѕ РіРѕР»РѕСЃРѕРІРѕРµ СЃРѕРµРґРёРЅРµРЅРёРµ.");
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
    if (this.transitionLock) return;

    this.transitionLock = true;
    this.clearAutoDisconnect();

    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        this.currentTrack = { ...next, startedAt: Date.now() };

        try {
          console.log(`[Play] Р—Р°РїСѓСЃРє С‚СЂРµРєР°: ${next.title} | ${next.url}`);

          let ytdlpFailed = false;
          let ytdlpErrorText = "";
          let processClosed = false;
          const cookiesPath = resolveYtDlpCookiesPath();

          const ytDlpArgs = [
            "-o",
            "-",
            "-f",
            "bestaudio[ext=m4a]/bestaudio/best",
            "--no-playlist",
            "--no-warnings",
            "--quiet",
            "--buffer-size",
            "128K",
            "--geo-bypass",
            "--force-ipv4",
            "--extractor-args",
            "youtube:player_client=android,ios,tv",
          ];

          if (cookiesPath) {
            ytDlpArgs.push("--cookies", cookiesPath);
            console.log(`[yt-dlp] РСЃРїРѕР»СЊР·СѓРµРј cookies: ${cookiesPath}`);
          }

          ytDlpArgs.push(next.url);

          const ytDlp = spawn("yt-dlp", ytDlpArgs, { stdio: ["ignore", "pipe", "pipe"] });

          ytDlp.stderr.on("data", (data) => {
            const line = data.toString().trim();
            if (!line) return;

            console.error(`[yt-dlp stderr] ${line}`);
            ytdlpErrorText += `${line}\n`;

            if (/ERROR:/i.test(line) || /This video is not available/i.test(line)) {
              ytdlpFailed = true;
            }
          });

          ytDlp.on("error", (err) => {
            ytdlpFailed = true;
            ytdlpErrorText += `${err.message}\n`;
            console.error(`[yt-dlp process error] ${err.message}`);
          });

          ytDlp.on("close", (code, signal) => {
            processClosed = true;
            console.log(`[yt-dlp exited] code=${code} signal=${signal} track=${next.title}`);

            if (code !== 0) {
              ytdlpFailed = true;
            }
          });

          const resource = createAudioResource(ytDlp.stdout, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
          });

          if (resource.volume) {
            resource.volume.setVolume(DEFAULT_VOLUME);
          }

          this.player.play(resource);

          await new Promise((resolve, reject) => {
            let settled = false;

            const cleanup = () => {
              this.player.off("stateChange", onStateChange);
              clearTimeout(timeout);
            };

            const finishResolve = () => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve();
            };

            const finishReject = (error) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(error);
            };

            const onStateChange = (oldState, newState) => {
              if (newState.status === AudioPlayerStatus.Playing) {
                finishResolve();
                return;
              }

              if (newState.status === AudioPlayerStatus.Idle && (ytdlpFailed || processClosed)) {
                finishReject(
                  new Error(
                    ytdlpErrorText.trim() || "РСЃС‚РѕС‡РЅРёРє Р·Р°РєСЂС‹Р» РїРѕС‚РѕРє РґРѕ РЅР°С‡Р°Р»Р° РІРѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёСЏ"
                  )
                );
              }
            };

            const timeout = setTimeout(() => {
              if (this.player.state.status === AudioPlayerStatus.Playing) {
                finishResolve();
                return;
              }

              if (ytdlpFailed || processClosed) {
                finishReject(
                  new Error(
                    ytdlpErrorText.trim() || "РќРµ СѓРґР°Р»РѕСЃСЊ РґРѕР¶РґР°С‚СЊСЃСЏ СЃС‚Р°Р±РёР»СЊРЅРѕРіРѕ Р·Р°РїСѓСЃРєР° РїРѕС‚РѕРєР°"
                  )
                );
                return;
              }

              finishResolve();
            }, 4000);

            this.player.on("stateChange", onStateChange);
          });

          await new Promise((resolve) => setTimeout(resolve, 1200));
          if (this.player.state.status !== AudioPlayerStatus.Playing || ytdlpFailed || processClosed) {
            throw new Error(ytdlpErrorText.trim() || "Source stream closed before stable start");
          }

          await this.refreshPanel();
          await this.sendAction("", `[${safeLinkText(next.title)}](${next.url})`);
          this.startProgressUpdater();
          return;
        } catch (error) {
          console.error(`[Play Error] ${next.title}: ${error.message}`);
          this.currentTrack = null;

          if (Array.isArray(next.fallbackTracks) && next.fallbackTracks.length > 0) {
            const [fallbackTrack, ...restFallbacks] = next.fallbackTracks;
            fallbackTrack.fallbackTracks = restFallbacks;
            this.queue.unshift(fallbackTrack);

            await this.sendAction(
              "Источник недоступен",
              `**${safeLinkText(next.title)}** недоступен, пробую запасной вариант по запросу.`
            );
            continue;
          }

          const actionTitle = isSourceUnavailableError(error.message) ? "Трек недоступен" : "Трек пропущен";
          await this.sendAction(actionTitle, `**${safeLinkText(next.title)}**\n\`${error.message}\``);
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

    this.stopProgressUpdater();

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
      return { ok: false, message: "РЎРµР№С‡Р°СЃ РЅРµС‚ Р°РєС‚РёРІРЅРѕРіРѕ С‚СЂРµРєР°." };
    }

    if (this.isPaused()) {
      const resumed = this.player.unpause();
      await this.refreshPanel();
      return resumed
        ? { ok: true, message: "РџСЂРѕРґРѕР»Р¶Р°СЋ РІРѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ." }
        : { ok: false, message: "РќРµ СѓРґР°Р»РѕСЃСЊ РїСЂРѕРґРѕР»Р¶РёС‚СЊ." };
    }

    const paused = this.player.pause(true);
    await this.refreshPanel();
    return paused
      ? { ok: true, message: "РџРѕСЃС‚Р°РІР»РµРЅРѕ РЅР° РїР°СѓР·Сѓ." }
      : { ok: false, message: "РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕСЃС‚Р°РІРёС‚СЊ РЅР° РїР°СѓР·Сѓ." };
  }

  async pause() {
    if (!this.currentTrack) {
      return { ok: false, message: "РЎРµР№С‡Р°СЃ РЅРµС‚ Р°РєС‚РёРІРЅРѕРіРѕ С‚СЂРµРєР°." };
    }

    const paused = this.player.pause(true);
    await this.refreshPanel();
    return paused
      ? { ok: true, message: "РџР°СѓР·Р°." }
      : { ok: false, message: "РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕСЃС‚Р°РІРёС‚СЊ РЅР° РїР°СѓР·Сѓ." };
  }

  async resume() {
    const resumed = this.player.unpause();
    await this.refreshPanel();
    return resumed
      ? { ok: true, message: "РџСЂРѕРґРѕР»Р¶Р°СЋ." }
      : { ok: false, message: "РќРµ СѓРґР°Р»РѕСЃСЊ РїСЂРѕРґРѕР»Р¶РёС‚СЊ." };
  }

  async skip() {
    if (!this.currentTrack) {
      return { ok: false, message: "РЎРµР№С‡Р°СЃ РЅРµС‡РµРіРѕ СЃРєРёРїР°С‚СЊ." };
    }

    this.forceSkip = true;
    this.player.stop(true);
    return { ok: true, message: "РўСЂРµРє РїСЂРѕРїСѓС‰РµРЅ." };
  }

  async stop() {
    this.stopProgressUpdater();
    const hadTracks = Boolean(this.currentTrack) || this.queue.length > 0;

    this.clearAutoDisconnect();
    this.queue = [];
    this.currentTrack = null;
    this.forceSkip = true;
    this.player.stop(true);

    await this.disconnectFromVoice(false);
    await this.clearPanel();

    return hadTracks
      ? { ok: true, message: "РћС‡РµСЂРµРґСЊ РѕС‡РёС‰РµРЅР°, Р±РѕС‚ РѕС‚РєР»СЋС‡С‘РЅ." }
      : { ok: false, message: "РћС‡РµСЂРµРґСЊ СѓР¶Рµ РїСѓСЃС‚Р°." };
  }

  async shuffle() {
    if (this.queue.length < 2) {
      return { ok: false, message: "Р”Р»СЏ С€Р°С„Р»Р° РЅСѓР¶РЅРѕ РјРёРЅРёРјСѓРј 2 С‚СЂРµРєР° РІ РѕС‡РµСЂРµРґРё." };
    }

    for (let i = this.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }

    await this.refreshPanel();
    return { ok: true, message: "РћС‡РµСЂРµРґСЊ РїРµСЂРµРјРµС€Р°РЅР°." };
  }

  async cycleLoopMode() {
    if (this.loopMode === "off") this.loopMode = "track";
    else if (this.loopMode === "track") this.loopMode = "queue";
    else this.loopMode = "off";

    await this.refreshPanel();
    return this.loopMode;
  }

  async setLoopMode(mode) {
    if (!["off", "track", "queue"].includes(mode)) return false;
    this.loopMode = mode;
    await this.refreshPanel();
    return true;
  }

  async disconnectFromVoice(sendNotice = false, reason = "РћС‚РєР»СЋС‡Р°СЋСЃСЊ.") {
    if (sendNotice) {
      await this.sendAction("РЎС‚РѕРї", reason);
    }

    if (this.connection) {
      this.connection.destroy();
    }

    this.connection = null;
    this.boundConnection = null;
    this.voiceChannelId = null;
  }

  scheduleAutoDisconnect() {
    if (!this.connection || AUTO_DISCONNECT_MS <= 0 || this.autoDisconnectTimer) return;

    this.autoDisconnectTimer = setTimeout(async () => {
      this.autoDisconnectTimer = null;

      if (this.currentTrack || this.queue.length > 0 || !this.connection) return;

      await this.disconnectFromVoice(true, "РџСѓСЃС‚Р°СЏ РѕС‡РµСЂРµРґСЊ Р±РѕР»РµРµ 3 РјРёРЅСѓС‚.");
      await this.refreshPanel();
    }, AUTO_DISCONNECT_MS);
  }

  clearAutoDisconnect() {
    if (!this.autoDisconnectTimer) return;
    clearTimeout(this.autoDisconnectTimer);
    this.autoDisconnectTimer = null;
  }

  async getTextChannel() {
    if (!this.textChannelId) return null;

    const cached = this.client.channels.cache.get(this.textChannelId);
    if (cached?.isTextBased()) return cached;

    try {
      const fetched = await this.client.channels.fetch(this.textChannelId);
      return fetched?.isTextBased() ? fetched : null;
    } catch {
      return null;
    }
  }

  async refreshPanel() {
    const channel = await this.getTextChannel();
    if (!channel) return;

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

    try {
      const message = await channel.send(payload);
      this.panelMessageId = message.id;
    } catch (error) {
      console.error(`[Panel:${this.guild.id}] РќРµ СѓРґР°Р»РѕСЃСЊ РѕС‚РїСЂР°РІРёС‚СЊ РїР°РЅРµР»СЊ:`, error.message);
    }
  }

  async sendQueue() {
    const channel = await this.getTextChannel();
    if (!channel) return;
    await channel.send({ embeds: [buildQueueEmbed(this)] });
  }

  async sendAction(title, description) {
    const channel = await this.getTextChannel();
    if (!channel) return;
    await channel.send({ embeds: [buildActionEmbed(title, description)] });
  }

  startProgressUpdater() {
    this.stopProgressUpdater();
    if (!this.currentTrack) return;

    this.updateInterval = setInterval(async () => {
      if (this.currentTrack && this.player.state.status === AudioPlayerStatus.Playing) {
        await this.refreshPanel().catch(() => {});
      } else {
        this.stopProgressUpdater();
      }
    }, 5000);
  }

  stopProgressUpdater() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  async clearPanel() {
    if (!this.panelMessageId) return;

    const channel = await this.getTextChannel();
    if (!channel) {
      this.panelMessageId = null;
      return;
    }

    try {
      const message = await channel.messages.fetch(this.panelMessageId).catch(() => null);
      if (message) {
        await message.delete().catch(() => {});
      }
    } catch (err) {
      console.error(`[Panel:${this.guild.id}] Clear panel error:`, err.message);
    } finally {
      this.panelMessageId = null;
    }
  }
}

module.exports = {
  GuildMusicPlayer,
};

