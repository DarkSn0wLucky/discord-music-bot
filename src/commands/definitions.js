const { SlashCommandBuilder } = require("discord.js");

const definitions = [
  new SlashCommandBuilder()
    .setName("voicepanel")
    .setDescription("\u041f\u0430\u043d\u0435\u043b\u044c \u0443\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u044f \u0433\u043e\u043b\u043e\u0441\u043e\u043c"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("\u041e\u0442\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u0431\u043e\u0442\u0430 \u043e\u0442 \u0433\u043e\u043b\u043e\u0441\u043e\u0432\u043e\u0433\u043e \u043a\u0430\u043d\u0430\u043b\u0430"),
];

const commandData = definitions.map((definition) => definition.toJSON());

module.exports = {
  commandData,
};
