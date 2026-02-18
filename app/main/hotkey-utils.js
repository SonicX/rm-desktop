/* eslint-disable import/unambiguous */

const cyrillicToLatin = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "j",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "hard_sign",
  ы: "y",
  ь: "soft_sign",
  э: "e",
  ю: "yu",
  я: "ya",
};

function normalizeHotkeyString(key) {
  let normalized = String(key).toLowerCase().replace("command", "meta");
  for (const [cyr, lat] of Object.entries(cyrillicToLatin)) {
    normalized = normalized.replace(cyr, lat);
  }

  const normalizedParts = normalized
    .split("+")
    .map((part) => part.trim().replaceAll(/\s+/g, " "))
    .map((part) => {
      const alias = part
        .replaceAll("-", " ")
        .replaceAll("_", " ")
        .replaceAll(/\s+/g, " ")
        .trim();
      const compactAlias = alias.replaceAll(" ", "");

      if (
        alias === "browser back" ||
        compactAlias === "browserback" ||
        alias === "mouse4" ||
        alias === "mouse 4" ||
        compactAlias === "xbutton1" ||
        alias === "mouse x1"
      ) {
        return "mouse x1";
      }

      if (
        alias === "browser forward" ||
        compactAlias === "browserforward" ||
        alias === "mouse5" ||
        alias === "mouse 5" ||
        compactAlias === "xbutton2" ||
        alias === "mouse x2"
      ) {
        return "mouse x2";
      }

      if (alias === "mouse left" || alias === "lbutton") {
        return "mouse left";
      }

      if (alias === "mouse right" || alias === "rbutton") {
        return "mouse right";
      }

      if (alias === "mouse middle" || alias === "mbutton") {
        return "mouse middle";
      }

      if (
        alias.startsWith("mouse button ") &&
        !Number.isNaN(Number(alias.replace("mouse button ", "")))
      ) {
        return alias;
      }

      return part;
    });

  return normalizedParts.join("+");
}

function normalizeKeyNameForMatch(name) {
  const normalized = normalizeHotkeyString(name).replaceAll(/\s+/g, " ").trim();
  if (normalized === "browser back") return "mouse x1";
  if (normalized === "browser forward") return "mouse x2";
  return normalized;
}

function getPressedKeyNameFromEvent(event, platform, maps) {
  const eventName = event?.name?.toString?.().toUpperCase()?.trim?.();
  if (eventName) {
    return eventName;
  }

  if (platform === "darwin") {
    return maps?.mac?.[event.vKey] || "";
  }

  return maps?.win?.[event.vKey] || "";
}

module.exports = {
  getPressedKeyNameFromEvent,
  normalizeHotkeyString,
  normalizeKeyNameForMatch,
};
