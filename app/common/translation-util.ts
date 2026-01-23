import path from "node:path";

import i18n from "i18n";

import {publicPath} from "./paths.js";

i18n.configure({
  directory: path.join(publicPath, "translations/"),
  updateFiles: false,
});

/* Язык всегда русский */
i18n.setLocale("ru");

export {__} from "i18n";
