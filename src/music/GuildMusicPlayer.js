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
const os = require("os");
const path = require("path");
const {
  DEFAULT_VOLUME,
  L2TP_SOURCE_IP,
  MAX_QUEUE_SIZE,
  YANDEX_COOKIES_PATH,
  VK_COOKIES_PATH,
  YTDLP_BIN,
  YTDLP_COOKIES_PATH,
  YTDLP_EXTRACTOR_ARGS,
} = require("../config");
const { buildActionEmbed, buildPanelComponents, buildPlayerEmbed, buildQueueEmbed } = require("../ui/panel");
const { resolveSearchCandidates } = require("./resolveTrack");
const { buildYtDlpEnv } = require("./ytdlpEnv");
const { safeLinkText } = require("../utils/format");

const COOKIES_PATH_CACHE_TTL_MS = 30_000;
const PLAY_START_TIMEOUT_MS = 20_000;
const MAX_SOURCE_RETRIES_PER_TRACK = 3;
const ACTION_DEDUPE_WINDOW_MS = 4_000;
const ENABLE_L2TP_BIND = ["1", "true", "yes", "on", "enabled"].includes(
  String(process.env.ENABLE_L2TP_BIND || "").trim().toLowerCase()
);
const cookiesPathCache = new Map();
let l2tpAddressChecked = false;
let l2tpAddressAvailable = false;

function hasLocalAddress(address) {
  const target = String(address || "").trim();
  if (!target) {
    return false;
  }

  for (const entries of Object.values(os.networkInterfaces())) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      if (String(entry?.address || "").trim() === target) {
        return true;
      }
    }
  }

  return false;
}

function canUseConfiguredL2tpAddress() {
  if (l2tpAddressChecked) {
    return l2tpAddressAvailable;
  }

  l2tpAddressChecked = true;
  l2tpAddressAvailable = hasLocalAddress(L2TP_SOURCE_IP);
  if (!l2tpAddressAvailable && String(L2TP_SOURCE_IP || "").trim()) {
    console.warn(
      `[Playback] L2TP_SOURCE_IP=${String(L2TP_SOURCE_IP).trim()} не найден на локальных интерфейсах; playback пойдет обычным маршрутом.`
    );
  }

  return l2tpAddressAvailable;
}

function isHomeL2tpPlaybackEnabled() {
  return ENABLE_L2TP_BIND && Boolean(String(L2TP_SOURCE_IP || "").trim()) && canUseConfiguredL2tpAddress();
}

function shouldUseHomeL2tpForPlaybackUrl(value) {
  if (!isHomeL2tpPlaybackEnabled()) {
    return false;
  }

  try {
    const parsed = new URL(String(value || "").trim());
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "music.yandex.ru" || host.startsWith("music.yandex.") || host === "vk.com" || host === "m.vk.com" || host.endsWith(".vk.com");
  } catch {
    return false;
  }
}

function resolveConfiguredCookiesPath(configuredPath) {
  const value = String(configuredPath || "").trim();
  if (!value) {
    return null;
  }

  const cached = cookiesPathCache.get(value);
  if (cached && Date.now() - cached.checkedAt <= COOKIES_PATH_CACHE_TTL_MS) {
    return cached.absolutePath;
  }

  const absolutePath = path.isAbsolute(value)
    ? value
    : path.resolve(process.cwd(), value);

  const resolvedPath = fs.existsSync(absolutePath) ? absolutePath : null;
  cookiesPathCache.set(value, { absolutePath: resolvedPath, checkedAt: Date.now() });
  return resolvedPath;
}

function isYouTubePlaybackUrl(value) {
  const text = String(value || "").trim();
  if (text.toLowerCase().startsWith("ytsearch")) {
    return true;
  }

  try {
    const parsed = new URL(text);
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "youtu.be" || host === "www.youtube.com" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function resolveYtDlpCookiesPath(track, playbackUrl = "") {
  if (isYouTubePlaybackUrl(playbackUrl)) {
    return resolveConfiguredCookiesPath(YTDLP_COOKIES_PATH);
  }

  const source = String(track?.source || "").toLowerCase();
  if (source.includes("yandex")) {
    return resolveConfiguredCookiesPath(YANDEX_COOKIES_PATH) || resolveConfiguredCookiesPath(YTDLP_COOKIES_PATH);
  }

  if (source.includes("vk")) {
    return resolveConfiguredCookiesPath(VK_COOKIES_PATH) || resolveConfiguredCookiesPath(YTDLP_COOKIES_PATH);
  }

  return resolveConfiguredCookiesPath(YTDLP_COOKIES_PATH);
}

function playbackUrlCatalogKind(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const host = String(parsed.hostname || "").toLowerCase();
    if (host === "music.yandex.ru" || host.startsWith("music.yandex.")) {
      return "yandex";
    }
    if (host === "vk.com" || host === "m.vk.com" || host.endsWith(".vk.com")) {
      return "vk";
    }
  } catch {
    return "";
  }

  return "";
}

function isSourceUnavailableError(message) {
  if (!message) {
    return false;
  }

  return /(not available|unavailable|private video|video is unavailable|copyright|deleted|blocked|403|410|no video formats found)/i.test(
    String(message)
  );
}

function isYouTubeAuthGateError(message) {
  if (!message) {
    return false;
  }

  return /(sign in to confirm you.?re not a bot|http error 403|forbidden|login required)/i.test(String(message));
}

function prettifyPlaybackError(message) {
  const value = String(message || "").trim();
  if (!value) {
    return "Не удалось запустить источник.";
  }

  if (/Source stream closed before playback start/i.test(value)) {
    return "Источник закрыл поток до начала воспроизведения.";
  }

  if (/Playback start timeout/i.test(value)) {
    return "Источник не успел запуститься вовремя.";
  }

  return value;
}

function uniqueTracksByUrl(tracks, excludedUrls = new Set(), limit = Infinity) {
  const sourceTracks = Array.isArray(tracks) ? tracks : [];
  const seenUrls = new Set(
    [...excludedUrls].map((url) => String(url || "").trim()).filter((url) => url.length > 0)
  );
  const unique = [];

  for (const track of sourceTracks) {
    const url = String(track?.url || "").trim();
    if (!url || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    unique.push(track);
    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

class GuildMusicPlayer {
  constructor({ guild, client, onDispose }) {
    this.guild = guild;
    this.client = client;
    this.onDispose = typeof onDispose === "function" ? onDispose : null;
    this.queue = [];
    this.currentTrack = null;
    this.loopMode = "off";
    this.forceSkip = false;
    this.suppressNextTrackAction = false;
    this.preservePanelOnNextTrack = false;
    this.transitionLock = false;
    this.textChannelId = null;
    this.panelMessageId = null;
    this.voiceChannelId = null;
    this.connection = null;
    this.boundConnection = null;
    this.autoDisconnectTimer = null;
    this.updateInterval = null;
    this.updateTimeout = null;
    this.activeStreamProcess = null;
    this.panelOperationQueue = Promise.resolve();
    this.lastActionSignature = "";
    this.lastActionAt = 0;

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
      this.cleanupActiveStreamProcess();
      this.player.stop(true);
    });
  }

  cleanupActiveStreamProcess(targetProcess = this.activeStreamProcess) {
    if (!targetProcess) {
      return;
    }

    if (targetProcess === this.activeStreamProcess) {
      this.activeStreamProcess = null;
    }

    if (targetProcess.killed) {
      return;
    }

    try {
      targetProcess.kill("SIGKILL");
    } catch {
      // ignore
    }
  }

  disposeIfIdle() {
    if (this.connection || this.currentTrack || this.queue.length > 0) {
      return;
    }

    if (this.onDispose) {
      this.onDispose(this.guild.id);
    }
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
    const available = Number.isFinite(MAX_QUEUE_SIZE)
      ? Math.max(0, MAX_QUEUE_SIZE - this.queue.length - (this.currentTrack ? 1 : 0))
      : tracks.length;
    const acceptedTracks = Number.isFinite(available) ? tracks.slice(0, available) : [...tracks];
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
      return false;
    }

    await this.playNext();
    return true;
  }

  async playNext(options = {}) {
    const { suppressTrackAction = false, preservePanelMessage = false } = options;
    if (this.transitionLock) return;

    this.transitionLock = true;
    this.clearAutoDisconnect();

    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        this.currentTrack = { ...next, startedAt: null };

        try {
          console.log(`[Play] Р—Р°РїСѓСЃРє С‚СЂРµРєР°: ${next.title} | ${next.url}`);

          const playbackUrl = String(next?.playbackUrl || next?.url || "").trim();
          if (!playbackUrl) {
            throw new Error("Пустой URL источника");
          }

          const catalogKind = playbackUrlCatalogKind(playbackUrl);
          let ytdlpFailed = false;
          let ytdlpErrorText = "";
          let processClosed = false;
          let processExitCode = null;
          let failedBeforePlaying = false;
          let hasStartedPlaying = false;
          let playingStartedAt = null;
          const cookiesPath = resolveYtDlpCookiesPath(next, playbackUrl);
          const isYouTubeLike =
            /(?:youtube\.com|youtu\.be)/i.test(playbackUrl) ||
            String(next.source || "").toLowerCase().includes("youtube");

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
            "--user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
          ];

          if (isYouTubeLike) {
            const extractorArgs = String(YTDLP_EXTRACTOR_ARGS || "").trim();
            if (extractorArgs) {
              ytDlpArgs.push("--extractor-args", extractorArgs);
            }
          }

          if (catalogKind === "vk" || String(next.source || "").toLowerCase().includes("vk")) {
            ytDlpArgs.push("--referer", "https://vk.com/");
          }

          if (catalogKind === "yandex") {
            ytDlpArgs.push("--referer", "https://music.yandex.ru/");
          }

          if (shouldUseHomeL2tpForPlaybackUrl(playbackUrl)) {
            ytDlpArgs.push("--source-address", String(L2TP_SOURCE_IP || "").trim());
          }

          if (cookiesPath) {
            ytDlpArgs.push("--cookies", cookiesPath);
            console.log(`[yt-dlp] РСЃРїРѕР»СЊР·СѓРµРј cookies: ${cookiesPath}`);
          }

          ytDlpArgs.push(playbackUrl);

          const ytDlpEnv = buildYtDlpEnv(process.env);

          const ytDlp = spawn(YTDLP_BIN, ytDlpArgs, {
            stdio: ["ignore", "pipe", "pipe"],
            env: ytDlpEnv,
          });
          this.activeStreamProcess = ytDlp;

          ytDlp.stderr.on("data", (data) => {
            const line = data.toString().trim();
            if (!line) return;

            console.error(`[yt-dlp stderr] ${line}`);
            ytdlpErrorText += `${line}\n`;

            if (/ERROR:/i.test(line) || /This video is not available/i.test(line)) {
              if (!hasStartedPlaying) {
                ytdlpFailed = true;
              }
            }
          });

          ytDlp.on("error", (err) => {
            ytdlpFailed = true;
            ytdlpErrorText += `${err.message}\n`;
            console.error(`[yt-dlp process error] ${err.message}`);
          });

          ytDlp.on("close", (code, signal) => {
            if (this.activeStreamProcess === ytDlp) {
              this.activeStreamProcess = null;
            }
            processClosed = true;
            processExitCode = code;
            console.log(`[yt-dlp exited] code=${code} signal=${signal} track=${next.title}`);

            if (code !== 0) {
              if (!hasStartedPlaying) {
                ytdlpFailed = true;
                failedBeforePlaying = true;
              }
            }
          });

          const resource = createAudioResource(ytDlp.stdout, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
          });

          if (resource.volume) {
            resource.volume.setVolume(DEFAULT_VOLUME);
          }

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
                hasStartedPlaying = true;
                if (!playingStartedAt) {
                  playingStartedAt = Date.now();
                }
                finishResolve();
                return;
              }

              if (newState.status === AudioPlayerStatus.Idle && !hasStartedPlaying) {
                finishReject(
                  new Error(
                    ytdlpErrorText.trim() || "Source stream closed before playback start"
                  )
                );
              }
            };

            const timeout = setTimeout(() => {
              if (this.player.state.status === AudioPlayerStatus.Playing || hasStartedPlaying) {
                finishResolve();
                return;
              }

              finishReject(new Error(ytdlpErrorText.trim() || "Playback start timeout"));
            }, PLAY_START_TIMEOUT_MS);

            this.player.on("stateChange", onStateChange);

            try {
              this.player.play(resource);
            } catch (playError) {
              finishReject(playError);
            }
          });

          if (!hasStartedPlaying && this.player.state.status === AudioPlayerStatus.Playing) {
            hasStartedPlaying = true;
            if (!playingStartedAt) {
              playingStartedAt = Date.now();
            }
          }

          if (failedBeforePlaying || (ytdlpFailed && !hasStartedPlaying) || !hasStartedPlaying) {
            throw new Error(
              ytdlpErrorText.trim() ||
                (processExitCode !== null && processExitCode !== 0
                  ? "Source exited with error (code=" + processExitCode + ")"
                  : "Source stream closed before playback start")
            );
          }

          if (this.currentTrack) {
            this.currentTrack.startedAt = playingStartedAt || Date.now();
          }

          if (!preservePanelMessage) {
            await this.clearPanel();
          }
          if (!suppressTrackAction) {
            const requestedBy = next.requestedById ? `<@${next.requestedById}>` : safeLinkText(next.requestedByTag || "unknown");
            await this.sendAction("", `[${safeLinkText(next.title)}](${next.url})\n\u0417\u0430\u043f\u0440\u043e\u0441\u0438\u043b ${requestedBy}`);
          }
          await this.refreshPanel();
          this.startProgressUpdater();
          return;
        } catch (error) {
          console.error(`[Play Error] ${next.title}: ${error.message}`);
          this.cleanupActiveStreamProcess();
          this.currentTrack = null;
          const retryAttempt = Number(next.retryAttempt || 0);
          const canRetry = Number.isFinite(retryAttempt) && retryAttempt < MAX_SOURCE_RETRIES_PER_TRACK;

          const triedUrls = new Set(
            [next.url, ...(Array.isArray(next.triedUrls) ? next.triedUrls : [])]
              .map((url) => String(url || "").trim())
              .filter((url) => url.length > 0)
          );
          const staticFallbackTracks = uniqueTracksByUrl(next.fallbackTracks, triedUrls, 5);
          if (canRetry && staticFallbackTracks.length > 0) {
            const [fallbackTrack, ...restFallbacks] = staticFallbackTracks;
            const retryTrack = {
              ...fallbackTrack,
              fallbackTracks: restFallbacks,
              searchQuery: fallbackTrack.searchQuery || next.searchQuery,
              requestedById: next.requestedById || fallbackTrack.requestedById,
              requestedByTag: next.requestedByTag || fallbackTrack.requestedByTag,
              triedUrls: [...triedUrls, fallbackTrack.url].filter(Boolean),
              dynamicFallbackTried: Boolean(next.dynamicFallbackTried),
              retryAttempt: retryAttempt + 1,
            };

            this.queue.unshift(retryTrack);
            await this.sendAction(
              "Источник недоступен",
              `**${safeLinkText(next.title)}** недоступен, пробую запасной вариант по запросу.`,
              { autoDeleteMs: 10_000 }
            );
            continue;
          }

          const isYouTubeLikeTrack =
            /(?:youtube\.com|youtu\.be)/i.test(String(next.url || "")) ||
            String(next.source || "").toLowerCase().includes("youtube");
          const fallbackQuery = String(next.searchQuery || next.title || "").trim();
          if (
            canRetry &&
            isYouTubeLikeTrack &&
            fallbackQuery &&
            isYouTubeAuthGateError(error.message) &&
            !next.dynamicFallbackTried
          ) {
            const requestedBy = {
              id: next.requestedById || this.client.user?.id || "system",
              tag: next.requestedByTag || "unknown",
              username: next.requestedByTag || "unknown",
            };
            const dynamicCandidates = await resolveSearchCandidates(fallbackQuery, requestedBy, { limit: 8 }).catch(() => []);
            const freshCandidates = uniqueTracksByUrl(dynamicCandidates, triedUrls, 5);

            if (freshCandidates.length > 0) {
              const [fallbackTrack, ...restFallbacks] = freshCandidates;
              const retryTrack = {
                ...fallbackTrack,
                fallbackTracks: restFallbacks,
                searchQuery: fallbackQuery,
                requestedById: next.requestedById || fallbackTrack.requestedById,
                requestedByTag: next.requestedByTag || fallbackTrack.requestedByTag,
                triedUrls: [...triedUrls, fallbackTrack.url].filter(Boolean),
                dynamicFallbackTried: true,
                retryAttempt: retryAttempt + 1,
              };

              this.queue.unshift(retryTrack);
              await this.sendAction(
                "Источник недоступен",
                `**${safeLinkText(next.title)}** недоступен, пробую другой вариант по запросу.`,
                { autoDeleteMs: 10_000 }
              );
              continue;
            }
          }

          const actionTitle = isSourceUnavailableError(error.message) ? "Трек недоступен" : "Трек пропущен";
          await this.sendAction(actionTitle, `**${safeLinkText(next.title)}**\n\`${prettifyPlaybackError(error.message)}\``);
        }
      }

      this.currentTrack = null;
      await this.refreshPanel({ moveToBottom: true });
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

    if (this.transitionLock && !this.currentTrack.startedAt) {
      return;
    }

    const finished = this.currentTrack;
    const skipped = this.forceSkip;
    const suppressTrackAction = this.suppressNextTrackAction;
    const preservePanelMessage = this.preservePanelOnNextTrack;
    this.forceSkip = false;
    this.suppressNextTrackAction = false;
    this.preservePanelOnNextTrack = false;

    this.stopProgressUpdater();
    this.cleanupActiveStreamProcess();

    if (!skipped) {
      if (this.loopMode === "track") {
        this.queue.unshift(finished);
      } else if (this.loopMode === "queue") {
        this.queue.push(finished);
      }
    }

    this.currentTrack = null;
    await this.playNext({
      suppressTrackAction,
      preservePanelMessage,
    });
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

    this.suppressNextTrackAction = true;
    this.preservePanelOnNextTrack = true;
    this.forceSkip = true;
    this.cleanupActiveStreamProcess();
    this.player.stop(true);
    return { ok: true, message: "РўСЂРµРє РїСЂРѕРїСѓС‰РµРЅ." };
  }

  async playQueueIndex(index) {
    const targetIndex = Number(index);
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= this.queue.length) {
      return { ok: false, message: "Трек в очереди не найден." };
    }

    const [selected] = this.queue.splice(targetIndex, 1);
    if (!selected) {
      return { ok: false, message: "Трек в очереди не найден." };
    }

    this.queue.unshift(selected);

    if (this.currentTrack) {
      this.suppressNextTrackAction = true;
      this.preservePanelOnNextTrack = true;
      this.forceSkip = true;
      this.cleanupActiveStreamProcess();
      this.player.stop(true);
      return { ok: true, message: `Переключаю на: ${safeLinkText(selected.title)}`, track: selected };
    }

    await this.playIfIdle();
    return { ok: true, message: `Запускаю: ${safeLinkText(selected.title)}`, track: selected };
  }

  async stop() {
    this.stopProgressUpdater();
    const hadTracks = Boolean(this.currentTrack) || this.queue.length > 0;

    this.clearAutoDisconnect();
    this.queue = [];
    this.currentTrack = null;
    this.forceSkip = true;
    this.suppressNextTrackAction = false;
    this.preservePanelOnNextTrack = false;
    this.cleanupActiveStreamProcess();
    this.player.stop(true);

    await this.refreshPanel({ moveToBottom: true });

    return hadTracks
      ? {
          ok: true,
          message:
            "\u041e\u0447\u0435\u0440\u0435\u0434\u044c \u043e\u0447\u0438\u0449\u0435\u043d\u0430.",
        }
      : {
          ok: false,
          message:
            "\u041e\u0447\u0435\u0440\u0435\u0434\u044c \u0443\u0436\u0435 \u043f\u0443\u0441\u0442\u0430.",
        };
  }

  async leave() {
    const hadConnection = Boolean(this.connection);
    const hadTracks = Boolean(this.currentTrack) || this.queue.length > 0;

    this.stopProgressUpdater();
    this.clearAutoDisconnect();
    this.queue = [];
    this.currentTrack = null;
    this.forceSkip = true;
    this.suppressNextTrackAction = false;
    this.preservePanelOnNextTrack = false;
    this.cleanupActiveStreamProcess();
    this.player.stop(true);

    await this.disconnectFromVoice(false);
    await this.refreshPanel({ moveToBottom: true });
    this.disposeIfIdle();

    if (!hadConnection) {
      return {
        ok: false,
        message:
          "\u0411\u043e\u0442 \u0443\u0436\u0435 \u043d\u0435 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d \u043a \u0433\u043e\u043b\u043e\u0441\u043e\u0432\u043e\u043c\u0443 \u043a\u0430\u043d\u0430\u043b\u0443.",
      };
    }

    return hadTracks
      ? {
          ok: true,
          message:
            "\u0411\u043e\u0442 \u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d \u043e\u0442 \u0433\u043e\u043b\u043e\u0441\u043e\u0432\u043e\u0433\u043e \u043a\u0430\u043d\u0430\u043b\u0430, \u043e\u0447\u0435\u0440\u0435\u0434\u044c \u043e\u0447\u0438\u0449\u0435\u043d\u0430.",
        }
      : {
          ok: true,
          message:
            "\u0411\u043e\u0442 \u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d \u043e\u0442 \u0433\u043e\u043b\u043e\u0441\u043e\u0432\u043e\u0433\u043e \u043a\u0430\u043d\u0430\u043b\u0430.",
        };
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

    this.cleanupActiveStreamProcess();
    this.connection = null;
    this.boundConnection = null;
    this.voiceChannelId = null;
    this.disposeIfIdle();
  }

  scheduleAutoDisconnect() {
    this.clearAutoDisconnect();
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

  runPanelOperation(operation) {
    const run = async () => operation();
    const next = this.panelOperationQueue.then(run, run);
    this.panelOperationQueue = next.catch(() => null);
    return next;
  }

  async findLatestPanelMessage(channel, limit = 40) {
    const messages = await channel.messages.fetch({ limit }).catch(() => null);
    if (!messages) {
      return null;
    }

    const panelMessages = [...messages.values()]
      .filter((message) => this.isMusicPanelMessage(message))
      .sort((left, right) => right.createdTimestamp - left.createdTimestamp);

    return panelMessages[0] || null;
  }

  async pruneDuplicatePanels(channel, keepMessageId = null) {
    const messages = await channel.messages.fetch({ limit: 40 }).catch(() => null);
    if (!messages) {
      return;
    }

    const panelMessages = [...messages.values()].filter((message) => this.isMusicPanelMessage(message));
    for (const panelMessage of panelMessages) {
      if (keepMessageId && panelMessage.id === keepMessageId) {
        continue;
      }
      await panelMessage.delete().catch(() => {});
    }
  }

  async refreshPanel(options = {}) {
    return this.runPanelOperation(async () => {
      const { moveToBottom = false } = options;
      const channel = await this.getTextChannel();
      if (!channel) return;

      const payload = {
        embeds: [buildPlayerEmbed(this)],
        components: buildPanelComponents(this),
      };

      if (this.panelMessageId && !moveToBottom) {
        try {
          const message = await channel.messages.fetch(this.panelMessageId);
          await message.edit(payload);
          return;
        } catch {
          this.panelMessageId = null;
        }
      }

      if (!this.panelMessageId && !moveToBottom) {
        const latestPanel = await this.findLatestPanelMessage(channel, 30);
        if (latestPanel) {
          this.panelMessageId = latestPanel.id;
          try {
            await latestPanel.edit(payload);
            await this.pruneDuplicatePanels(channel, latestPanel.id);
            return;
          } catch {
            this.panelMessageId = null;
          }
        }
      }

      if (moveToBottom) {
        if (this.panelMessageId) {
          try {
            const message = await channel.messages.fetch(this.panelMessageId).catch(() => null);
            if (message) {
              await message.delete().catch(() => {});
            }
          } finally {
            this.panelMessageId = null;
          }
        } else {
          await this.pruneDuplicatePanels(channel, null);
        }
      }

      try {
        const message = await channel.send(payload);
        this.panelMessageId = message.id;
        if (moveToBottom) {
          await this.pruneDuplicatePanels(channel, message.id);
        }
      } catch (error) {
        console.error(`[Panel:${this.guild.id}] Panel update failed:`, error.message);
      }
    });
  }

  async sendQueue() {
    const channel = await this.getTextChannel();
    if (!channel) return;
    await channel.send({ embeds: [buildQueueEmbed(this)] });
  }

  async sendAction(title, description, options = {}) {
    const channel = await this.getTextChannel();
    if (!channel) return;

    const dedupeWindowMs = Number(options.dedupeWindowMs);
    const effectiveDedupeMs =
      Number.isFinite(dedupeWindowMs) && dedupeWindowMs >= 0
        ? dedupeWindowMs
        : ACTION_DEDUPE_WINDOW_MS;
    const dedupeKey = String(options.dedupeKey || `${title || ""}|${description || ""}`)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    if (
      effectiveDedupeMs > 0 &&
      dedupeKey &&
      this.lastActionSignature === dedupeKey &&
      Date.now() - this.lastActionAt < effectiveDedupeMs
    ) {
      return;
    }

    const message = await channel.send({ embeds: [buildActionEmbed(title, description)] });
    if (dedupeKey) {
      this.lastActionSignature = dedupeKey;
      this.lastActionAt = Date.now();
    }

    const autoDeleteMs = Number(options.autoDeleteMs);
    if (Number.isFinite(autoDeleteMs) && autoDeleteMs > 0) {
      setTimeout(() => {
        message.delete().catch(() => {});
      }, autoDeleteMs);
    }
  }

  startProgressUpdater() {
    this.stopProgressUpdater();
    if (!this.currentTrack?.startedAt) return;

    const tick = async () => {
      if (this.currentTrack && this.player.state.status === AudioPlayerStatus.Playing) {
        await this.refreshPanel().catch(() => {});
      } else {
        this.stopProgressUpdater();
      }
    };

    const elapsed = Math.max(0, Date.now() - this.currentTrack.startedAt);
    const remainder = elapsed % 5000;
    const delay = remainder === 0 ? 5000 : 5000 - remainder;

    this.updateTimeout = setTimeout(() => {
      tick().catch(() => {});
      this.updateInterval = setInterval(() => {
        tick().catch(() => {});
      }, 5000);
    }, delay);
  }

  stopProgressUpdater() {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  async clearPanel() {
    return this.runPanelOperation(async () => {
      const channel = await this.getTextChannel();
      if (!channel) {
        this.panelMessageId = null;
        return;
      }

      try {
        if (this.panelMessageId) {
          const message = await channel.messages.fetch(this.panelMessageId).catch(() => null);
          if (message) {
            await message.delete().catch(() => {});
          }
        }
        await this.pruneDuplicatePanels(channel, null);
      } catch (err) {
        console.error(`[Panel:${this.guild.id}] Clear panel error:`, err.message);
      } finally {
        this.panelMessageId = null;
      }
    });
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
      row.components.some((component) => typeof component.customId === "string" && component.customId.startsWith("music:"))
    );
  }

  async clearRecentPanels() {
    return this.runPanelOperation(async () => {
      const channel = await this.getTextChannel();
      if (!channel) {
        return;
      }

      await this.pruneDuplicatePanels(channel, null);
      this.panelMessageId = null;
    });
  }
}

module.exports = {
  GuildMusicPlayer,
};

