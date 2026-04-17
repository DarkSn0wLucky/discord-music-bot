const ffmpegPath = require("ffmpeg-static");
const path = require("path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { assertEnv, DISCORD_TOKEN } = require("./config");
const { handleButton, handleChatInput } = require("./commands/handlers");
const { MusicManager } = require("./music/MusicManager");
const { initSourceAuth } = require("./music/sourceAuth");

if (ffmpegPath) {
  const ffmpegDir = path.dirname(ffmpegPath);
  process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH || ""}`;
}

assertEnv(["DISCORD_TOKEN"]);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

const manager = new MusicManager(client);

client.once("ready", async () => {
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
    }
  } catch (error) {
    console.error("[Interaction error]", error);
    const payload = {
      content: `Ошибка: ${error.message || "неизвестная ошибка"}`,
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

client.login(DISCORD_TOKEN);

