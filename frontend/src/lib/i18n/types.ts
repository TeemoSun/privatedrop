export type SupportedLanguage =
  | "zh-CN"
  | "zh-TW"
  | "en"
  | "ja"
  | "ko"
  | "fr"
  | "de"
  | "es"
  | "ru"
  | "pt"
  | "it"
  | "nl"
  | "pl"
  | "tr"
  | "vi"
  | "id"
  | "ar";

export type LanguageChoice = "auto" | SupportedLanguage;

export interface LanguageInfo {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
  dir?: "ltr" | "rtl";
  dayjsLocale: string;
}

export interface Translations {
  common: {
    confirm: string;
    cancel: string;
    save: string;
    delete: string;
    clear: string;
    loading: string;
    close: string;
    copy: string;
    copied: string;
    expand: string;
    collapse: string;
    back: string;
    networkError: string;
    cancelled: string;
    unknownDevice: string;
  };
  nav: {
    ephemeral: string;
    timeline: string;
    secret: string;
    manage: string;
    logout: string;
  };
  login: {
    title: string;
    subtitle: string;
    deviceName: string;
    password: string;
    submit: string;
    invalidPassword: string;
    loginFailed: string;
  };
  board: {
    dragTitle: string;
    dragDesc: string;
    secretBanner: string;
    secretBannerDesc: string;
    loadOlder: string;
    loadingOlder: string;
    emptySecretTitle: string;
    emptySecretHint: string;
    emptyEphemeralTitle: string;
    emptyEphemeralHint: string;
    emptyTimelineTitle: string;
    emptyTimelineHint: string;
    pendingFiles: string;
    clearAll: string;
    fileReady: string;
    fileFailed: string;
    remove: string;
    fileOversized: string;
    uploadHttpError: string;
    partialUploadError: string;
    sendFailed: string;
    wsConnecting: string;
    wsDisconnected: string;
    reconnectNow: string;
    inputPlaceholderEnter: string;
    inputPlaceholderNoEnter: string;
    send: string;
    connecting: string;
    connectingSend: string;
    disconnectedReconnect: string;
    disconnectedSend: string;
    addFile: string;
  };
  item: {
    copyText: string;
    copied: string;
    delete: string;
    moreActions: string;
    ephemeralBadge: string;
    expiresAt: string;
    expiresIn24h: string;
    expiringSoon: string;
    remainingHours: string;
    remainingMinutes: string;
  };
  manage: {
    title: string;
    subtitle: string;
    generalSection: string;
    devicesTitle: string;
    devicesDesc: string;
    trashTitle: string;
    trashDesc: string;
    storageTitle: string;
    storageDesc: string;
    storageIssuesFound: string;
    prefSection: string;
    themeTitle: string;
    themeDesc: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    enterTitle: string;
    enterDesc: string;
    languageTitle: string;
    languageDesc: string;
    langAuto: string;
    accountSection: string;
    currentDeviceName: string;
    rename: string;
    renameDialogTitle: string;
    renameDialogPlaceholder: string;
    logoutTitle: string;
    logoutDesc: string;
  };
  devices: {
    back: string;
    title: string;
    subtitle: string;
    empty: string;
    currentBadge: string;
    lastSeen: string;
    registeredAt: string;
    unbindTitle: string;
    unbindCurrentDesc: string;
    unbindOtherDesc: string;
    delete: string;
  };
  trash: {
    back: string;
    title: string;
    subtitle: string;
    emptyTitle: string;
    emptyHint: string;
    emptyAll: string;
    emptyConfirmTitle: string;
    emptyConfirmDesc: string;
    purgeConfirmTitle: string;
    purgeConfirmDesc: string;
    purgeBtn: string;
    restoreBtn: string;
    deletedAt: string;
    ephemeralBadge: string;
    retaining: string;
    expiringSoon: string;
    hoursRemaining: string;
    minutesRemaining: string;
    daysRemaining: string;
  };
  storage: {
    back: string;
    title: string;
    subtitle: string;
    recheck: string;
    quickFix: string;
    fixConfirmTitle: string;
    fixConfirmDesc: string;
    fixSuccess: string;
    statusConsistency: string;
    statusAbnormal: string;
    statusNormal: string;
    issuesDetail: string;
    consistentDetail: string;
    dbRecords: string;
    dbFilesCount: string;
    dbItemsCount: string;
    diskStorage: string;
    diskFilesCount: string;
    healthyTitle: string;
    healthyDesc: string;
    missingTitle: string;
    missingDesc: string;
    orphanTitle: string;
    orphanTotalSize: string;
    orphanDesc: string;
    notePrefix: string;
    inTrash: string;
    createdAt: string;
  };
  device: {
    unknown: string;
    android: string;
    windows: string;
    mac: string;
    chromebook: string;
    linux: string;
    ipad: string;
    iphone: string;
    harmony: string;
    openHarmony: string;
  };
}

export const SUPPORTED_LANGUAGES: LanguageInfo[] = [
  { code: "zh-CN", name: "Simplified Chinese", nativeName: "简体中文", dayjsLocale: "zh-cn" },
  { code: "zh-TW", name: "Traditional Chinese", nativeName: "繁體中文", dayjsLocale: "zh-tw" },
  { code: "en", name: "English", nativeName: "English", dayjsLocale: "en" },
  { code: "ja", name: "Japanese", nativeName: "日本語", dayjsLocale: "ja" },
  { code: "ko", name: "Korean", nativeName: "한국어", dayjsLocale: "ko" },
  { code: "fr", name: "French", nativeName: "Français", dayjsLocale: "fr" },
  { code: "de", name: "German", nativeName: "Deutsch", dayjsLocale: "de" },
  { code: "es", name: "Spanish", nativeName: "Español", dayjsLocale: "es" },
  { code: "ru", name: "Russian", nativeName: "Русский", dayjsLocale: "ru" },
  { code: "pt", name: "Portuguese", nativeName: "Português", dayjsLocale: "pt" },
  { code: "it", name: "Italian", nativeName: "Italiano", dayjsLocale: "it" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", dayjsLocale: "nl" },
  { code: "pl", name: "Polish", nativeName: "Polski", dayjsLocale: "pl" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe", dayjsLocale: "tr" },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", dayjsLocale: "vi" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", dayjsLocale: "id" },
  { code: "ar", name: "Arabic", nativeName: "العربية", dir: "rtl", dayjsLocale: "ar" },
];
