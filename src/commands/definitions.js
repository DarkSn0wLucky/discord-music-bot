const { SlashCommandBuilder } = require("discord.js");

const definitions = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Добавить трек по ссылке или запросу")
    .addStringOption((option) =>
      option.setName("query").setDescription("Ссылка (YouTube/SC/Spotify/VK/Yandex) или текст запроса").setRequired(true)
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Пропустить текущий трек"),
  new SlashCommandBuilder().setName("pause").setDescription("Пауза"),
  new SlashCommandBuilder().setName("resume").setDescription("Продолжить воспроизведение"),
  new SlashCommandBuilder().setName("stop").setDescription("Остановить музыку и очистить очередь"),
  new SlashCommandBuilder().setName("queue").setDescription("Показать очередь"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Показать текущий трек"),
  new SlashCommandBuilder().setName("shuffle").setDescription("Перемешать очередь"),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Режим повтора")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("off / track / queue")
        .setRequired(true)
        .addChoices(
          { name: "off", value: "off" },
          { name: "track", value: "track" },
          { name: "queue", value: "queue" }
        )
    ),
];

const commandData = definitions.map((definition) => definition.toJSON());

module.exports = {
  commandData,
};
