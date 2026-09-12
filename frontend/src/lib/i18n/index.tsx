import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";

import "dayjs/locale/zh-cn";
import "dayjs/locale/zh-tw";
import "dayjs/locale/en";
import "dayjs/locale/ja";
import "dayjs/locale/ko";
import "dayjs/locale/fr";
import "dayjs/locale/de";
import "dayjs/locale/es";
import "dayjs/locale/ru";
import "dayjs/locale/pt";
import "dayjs/locale/it";
import "dayjs/locale/nl";
import "dayjs/locale/pl";
import "dayjs/locale/tr";
import "dayjs/locale/vi";
import "dayjs/locale/id";
import "dayjs/locale/ar";

import { detectBrowserLanguage } from "./detector";
import { zhCN } from "./locales/zh-CN";
import { zhTW } from "./locales/zh-TW";
import { en } from "./locales/en";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { fr } from "./locales/fr";
import { de } from "./locales/de";
import { es } from "./locales/es";
import { ru } from "./locales/ru";
import { pt } from "./locales/pt";
import { it } from "./locales/it";
import { nl } from "./locales/nl";
import { pl } from "./locales/pl";
import { tr } from "./locales/tr";
import { vi } from "./locales/vi";
import { id } from "./locales/id";
import { ar } from "./locales/ar";
import {
  SUPPORTED_LANGUAGES,
  type LanguageChoice,
  type SupportedLanguage,
  type Translations,
} from "./types";

export * from "./types";
export { detectBrowserLanguage } from "./detector";

export const KEY_LANGUAGE = "pd_language";

const translations: Record<SupportedLanguage, Translations> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  ru,
  pt,
  it,
  nl,
  pl,
  tr,
  vi,
  id,
  ar,
};

export type TranslationKey =
  | `common.${keyof Translations["common"]}`
  | `nav.${keyof Translations["nav"]}`
  | `login.${keyof Translations["login"]}`
  | `board.${keyof Translations["board"]}`
  | `item.${keyof Translations["item"]}`
  | `manage.${keyof Translations["manage"]}`
  | `devices.${keyof Translations["devices"]}`
  | `trash.${keyof Translations["trash"]}`
  | `storage.${keyof Translations["storage"]}`
  | `device.${keyof Translations["device"]}`;

export function getSavedLanguageChoice(): LanguageChoice {
  try {
    const val = localStorage.getItem(KEY_LANGUAGE);
    if (!val || val === "auto") return "auto";
    if (val in translations) return val as SupportedLanguage;
    return "auto";
  } catch {
    return "auto";
  }
}

export function resolveLanguage(choice: LanguageChoice): SupportedLanguage {
  if (choice === "auto") {
    return detectBrowserLanguage();
  }
  if (choice in translations) {
    return choice as SupportedLanguage;
  }
  return detectBrowserLanguage();
}

let activeLanguage: SupportedLanguage = resolveLanguage(getSavedLanguageChoice());

export function applyLanguage(lang: SupportedLanguage): void {
  activeLanguage = lang;
  const info = SUPPORTED_LANGUAGES.find((l) => l.code === lang) || SUPPORTED_LANGUAGES[0];
  dayjs.locale(info.dayjsLocale);

  if (typeof document !== "undefined") {
    document.documentElement.lang = lang;
    document.documentElement.dir = info.dir || "ltr";
  }
}

export function getActiveLanguage(): SupportedLanguage {
  return activeLanguage;
}

export function translate(
  lang: SupportedLanguage,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const [section, field] = key.split(".") as [keyof Translations, string];
  const dict = translations[lang] || translations.en || translations["zh-CN"];
  const sectionObj = dict[section] as Record<string, string> | undefined;

  let str = sectionObj?.[field];

  if (!str) {
    // Fallback to English, then Simplified Chinese
    const fallbackDict = translations.en[section] as Record<string, string> | undefined;
    str = fallbackDict?.[field] || (translations["zh-CN"][section] as Record<string, string>)[field] || key;
  }

  if (params) {
    for (const [pKey, pVal] of Object.entries(params)) {
      str = str.replaceAll(`{${pKey}}`, String(pVal));
    }
  }

  return str;
}

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate(activeLanguage, key, params);
}

interface I18nContextValue {
  languageChoice: LanguageChoice;
  currentLanguage: SupportedLanguage;
  setLanguage: (choice: LanguageChoice) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  isRtl: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [languageChoice, setLanguageChoiceState] = useState<LanguageChoice>(() => getSavedLanguageChoice());
  const [currentLanguage, setCurrentLanguageState] = useState<SupportedLanguage>(() => resolveLanguage(languageChoice));

  useEffect(() => {
    const resolved = resolveLanguage(languageChoice);
    setCurrentLanguageState(resolved);
    applyLanguage(resolved);
  }, [languageChoice]);

  const setLanguage = (choice: LanguageChoice) => {
    try {
      if (choice === "auto") {
        localStorage.setItem(KEY_LANGUAGE, "auto");
      } else {
        localStorage.setItem(KEY_LANGUAGE, choice);
      }
    } catch {}
    setLanguageChoiceState(choice);
    const resolved = resolveLanguage(choice);
    setCurrentLanguageState(resolved);
    applyLanguage(resolved);
    window.dispatchEvent(new Event("pd:language-changed"));
  };

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === KEY_LANGUAGE) {
        setLanguageChoiceState(getSavedLanguageChoice());
      }
    };
    const handleCustomChange = () => {
      setLanguageChoiceState(getSavedLanguageChoice());
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("pd:language-changed", handleCustomChange);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("pd:language-changed", handleCustomChange);
    };
  }, []);

  const isRtl = useMemo(() => {
    const info = SUPPORTED_LANGUAGES.find((l) => l.code === currentLanguage);
    return info?.dir === "rtl";
  }, [currentLanguage]);

  const tFunc = useMemo(() => {
    return (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(currentLanguage, key, params);
  }, [currentLanguage]);

  const contextValue = useMemo<I18nContextValue>(
    () => ({
      languageChoice,
      currentLanguage,
      setLanguage,
      t: tFunc,
      isRtl,
    }),
    [languageChoice, currentLanguage, tFunc, isRtl],
  );

  return <I18nContext.Provider value={contextValue}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}
