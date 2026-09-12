import type { SupportedLanguage } from "./types";

export function detectBrowserLanguage(): SupportedLanguage {
  if (typeof navigator === "undefined") return "en";

  const languages: readonly string[] =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language || ""];

  for (const lang of languages) {
    if (!lang) continue;
    const lower = lang.toLowerCase().trim();

    // Traditional Chinese variants
    if (
      lower === "zh-tw" ||
      lower === "zh-hk" ||
      lower === "zh-mo" ||
      lower.startsWith("zh-hant")
    ) {
      return "zh-TW";
    }
    // Simplified Chinese variants
    if (
      lower === "zh-cn" ||
      lower === "zh-sg" ||
      lower.startsWith("zh-hans") ||
      lower === "zh"
    ) {
      return "zh-CN";
    }

    const prefix = lower.split("-")[0];
    if (prefix === "en") return "en";
    if (prefix === "ja") return "ja";
    if (prefix === "ko") return "ko";
    if (prefix === "fr") return "fr";
    if (prefix === "de") return "de";
    if (prefix === "es") return "es";
    if (prefix === "ru") return "ru";
    if (prefix === "pt") return "pt";
    if (prefix === "it") return "it";
    if (prefix === "nl") return "nl";
    if (prefix === "pl") return "pl";
    if (prefix === "tr") return "tr";
    if (prefix === "vi") return "vi";
    if (prefix === "id") return "id";
    if (prefix === "ar") return "ar";
  }

  return "en";
}
