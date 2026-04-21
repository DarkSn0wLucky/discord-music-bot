function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

const ASSOCIATIONS = [
  {
    keys: ["libertovich"],
    fullName: "Архан Мехдиев Вугар Оглы",
    nicknames: ["вугарыч", "патрик", "темщик", "арбузный", "айфоновский"],
    traits: ["любит движ и темы"],
  },
  {
    keys: ["hobiknoob"],
    fullName: "Роман Соронин",
    nicknames: ["тонкий", "длинный", "тощий", "жидкий лев"],
    traits: ["часто фигурирует в локальных рофлах"],
  },
  {
    keys: ["darksnowlucky"],
    fullName: "Семён",
    nicknames: [],
    traits: [],
  },
  {
    keys: ["v1nn11"],
    fullName: "Николай",
    nicknames: [],
    traits: [],
  },
  {
    keys: ["andr3i9259"],
    fullName: "Андрюха",
    nicknames: [],
    traits: ["по нему собирали майндсет персонажа бота"],
  },
  {
    keys: ["mentory007"],
    fullName: "Кирилл Палий",
    nicknames: [],
    traits: ["в чате часто становится объектом шуток"],
  },
  {
    keys: ["koko1n."],
    fullName: "Тамирлан Джавадов",
    nicknames: ["мага", "магомед", "лысый", "главный хинкал Тюменской области"],
    traits: ["любит воздуханить", "мутный тип по мемам компании"],
  },
  {
    keys: ["ducge"],
    fullName: "Павел",
    nicknames: [],
    traits: ["интересуется политикой", "редко заходит в войс"],
  },
];

const byKey = new Map();
for (const item of ASSOCIATIONS) {
  for (const key of item.keys) {
    byKey.set(normalize(key), item);
  }
}

function findAssociation({ userId, username, displayName, globalName }) {
  const candidates = [userId, username, displayName, globalName].map(normalize).filter(Boolean);
  for (const candidate of candidates) {
    const direct = byKey.get(candidate);
    if (direct) {
      return direct;
    }
  }
  return null;
}

function buildAssociationPrompt(entries) {
  const seen = new Set();
  const lines = [];

  for (const entry of entries) {
    const association = findAssociation(entry);
    if (!association) {
      continue;
    }

    const key = association.keys[0];
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const chunks = [];
    if (association.fullName) {
      chunks.push(`зовут ${association.fullName}`);
    }
    if (association.nicknames.length > 0) {
      chunks.push(`клички: ${association.nicknames.join(", ")}`);
    }
    if (association.traits.length > 0) {
      chunks.push(`вайб: ${association.traits.join("; ")}`);
    }

    lines.push(`- ${entry.author}: ${chunks.join("; ")}`);
  }

  if (lines.length === 0) {
    return "";
  }

  return ["Локальные ассоциации участников (используй для шуток в стиле чата):", ...lines].join("\n");
}

module.exports = {
  findAssociation,
  buildAssociationPrompt,
};
