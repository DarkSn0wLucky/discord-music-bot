const ffmpegPath = require("ffmpeg-static");
const path = require("path");
const { Client, GatewayIntentBits, MessageFlags, Partials } = require("discord.js");
const { assertEnv, DISCORD_TOKEN } = require("./config");
const { handleButton, handleChatInput, handleVoicePanelComponent } = require("./commands/handlers");
const { MusicManager } = require("./music/MusicManager");
const { initSourceAuth } = require("./music/sourceAuth");

if (ffmpegPath) {
  const ffmpegDir = path.dirname(ffmpegPath);
  process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH || ""}`;
}

const nodeMajor = Number(String(process.versions.node || "0").split(".")[0] || 0);
if (Number.isFinite(nodeMajor) && nodeMajor > 0 && nodeMajor < 22) {
  console.warn(`[Runtime] Node.js ${process.versions.node} detected. Recommended >= 22 for @discordjs/voice stability.`);
}

process.on("unhandledRejection", (reason) => {
  const message =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack || ""}`
      : typeof reason === "string"
        ? reason
        : JSON.stringify(reason);
  console.error("[UnhandledRejection]", message);
});

assertEnv(["DISCORD_TOKEN"]);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

const manager = new MusicManager(client);

client.once("clientReady", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  try {
    const sourceStatus = await initSourceAuth();
    console.log("[Bot] Source auth:", sourceStatus);
  } catch (error) {
    console.warn("[Bot] Source auth init failed:", error.message);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleChatInput(interaction, manager);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("music:")) {
      await handleButton(interaction, manager);
      return;
    }

    if (
      (interaction.isButton() ||
        interaction.isUserSelectMenu() ||
        interaction.isStringSelectMenu() ||
        interaction.isChannelSelectMenu()) &&
      interaction.customId.startsWith("voicepanel:")
    ) {
      await handleVoicePanelComponent(interaction);
    }
  } catch (error) {
    console.error("[Interaction error]", error);
    const payload = {
      content: `Ошибка: ${error.message || "неизвестная ошибка"}`,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

client.login(DISCORD_TOKEN);
