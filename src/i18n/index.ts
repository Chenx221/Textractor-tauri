import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import ja from "./locales/ja.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import es from "./locales/es.json";
import ru from "./locales/ru.json";
import it from "./locales/it.json";
import pt from "./locales/pt.json";
import ko from "./locales/ko.json";
import id from "./locales/id.json";
import vi from "./locales/vi.json";
import tr from "./locales/tr.json";
import th from "./locales/th.json";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "ja", label: "日本語" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ko", label: "한국어" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "tr", label: "Türkçe" },
  { code: "th", label: "ไทย" },
] as const;

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
    "zh-TW": { translation: zhTW },
    ja: { translation: ja },
    fr: { translation: fr },
    de: { translation: de },
    es: { translation: es },
    ru: { translation: ru },
    it: { translation: it },
    pt: { translation: pt },
    ko: { translation: ko },
    id: { translation: id },
    vi: { translation: vi },
    tr: { translation: tr },
    th: { translation: th },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
