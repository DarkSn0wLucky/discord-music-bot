const { REST, Routes } = require("discord.js");
const { assertEnv, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, DISCORD_TOKEN } = require("../src/config");
const { commandData } = require("../src/commands/definitions");

assertEnv(["DISCORD_TOKEN", "DISCORD_CLIENT_ID"]);

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

async function deploy() {
  if (DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
      body: commandData,
    });
    console.log(`[Commands] Deployed to guild ${DISCORD_GUILD_ID}`);
    return;
  }

  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
    body: commandData,
  });
  console.log("[Commands] Deployed globally (up to ~1h propagation).");
}

deploy().catch((error) => {
  console.error("[Commands] Deploy failed", error);
  process.exitCode = 1;
});

