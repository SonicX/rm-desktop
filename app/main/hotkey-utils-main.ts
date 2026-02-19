const cyrillicToLatin: Record<string, string> = {
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

const specialMouseAliases: Record<string, string> = {
  "browser back": "mouse x1",
  browserback: "mouse x1",
  mouse4: "mouse x1",
  "mouse 4": "mouse x1",
  xbutton1: "mouse x1",
  "mouse x1": "mouse x1",
  "browser forward": "mouse x2",
  browserforward: "mouse x2",
  mouse5: "mouse x2",
  "mouse 5": "mouse x2",
  xbutton2: "mouse x2",
  "mouse x2": "mouse x2",
  "mouse left": "mouse left",
  lbutton: "mouse left",
  "mouse right": "mouse right",
  rbutton: "mouse right",
  "mouse middle": "mouse middle",
  mbutton: "mouse middle",
};

const normalizeAliasPart = (part: string): string => {
  const alias = part
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  const compactAlias = alias.replaceAll(" ", "");

  const mappedAlias =
    specialMouseAliases[alias] ?? specialMouseAliases[compactAlias];
  if (mappedAlias) {
    return mappedAlias;
  }

  if (
    alias.startsWith("mouse button ") &&
    !Number.isNaN(Number(alias.replace("mouse button ", "")))
  ) {
    return alias;
  }

  return part;
};

export const normalizeHotkeyString = (key: string): string => {
  let normalized = String(key).toLowerCase().replace("command", "meta");
  for (const [cyr, lat] of Object.entries(cyrillicToLatin)) {
    normalized = normalized.replace(cyr, lat);
  }

  const normalizedParts = normalized
    .split("+")
    .map((part) => part.trim().replaceAll(/\s+/g, " "))
    .map((part) => normalizeAliasPart(part));

  return normalizedParts.join("+");
};

export const normalizeKeyNameForMatch = (name: string): string => {
  const normalized = normalizeHotkeyString(name).replaceAll(/\s+/g, " ").trim();
  if (normalized === "browser back") return "mouse x1";
  if (normalized === "browser forward") return "mouse x2";
  return normalized;
};

type KeyboardMaps = {
  mac?: Record<number, string>;
  win?: Record<number, string>;
};

type KeyEvent = {
  name?: unknown;
  vKey: number;
};

export const getPressedKeyNameFromEvent = (
  event: KeyEvent,
  platform: NodeJS.Platform,
  maps?: KeyboardMaps,
): string => {
  const eventName = event?.name?.toString?.().toUpperCase()?.trim?.();
  if (eventName) {
    return eventName;
  }

  if (platform === "darwin") {
    return maps?.mac?.[event.vKey] ?? "";
  }

  return maps?.win?.[event.vKey] ?? "";
};
