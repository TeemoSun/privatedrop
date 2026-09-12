declare global {
  interface Navigator {
    userAgentData?: {
      brands: { brand: string; version: string }[];
      mobile: boolean;
      platform: string;
      getHighEntropyValues?: (hints: string[]) => Promise<{
        model?: string;
        platform?: string;
        platformVersion?: string;
        architecture?: string;
      }>;
    };
  }
}

import { t } from "./i18n";

export function parseUserAgent(ua: string): string {
  if (!ua) return t("device.unknown");

  // Check iPad (including newer iPadOS reporting as Macintosh with multi-touch)
  const isIPad =
    /iPad/i.test(ua) ||
    (/Macintosh/i.test(ua) && typeof navigator !== "undefined" && (navigator.maxTouchPoints || 0) > 1);
  if (isIPad) return t("device.ipad");

  if (/iPhone/i.test(ua)) return t("device.iphone");
  if (/iPod/i.test(ua)) return "iPod";

  // HarmonyOS / OpenHarmony
  if (/HarmonyOS/i.test(ua)) return t("device.harmony");
  if (/OpenHarmony/i.test(ua)) return t("device.openHarmony");

  // Android
  if (/Android/i.test(ua)) {
    // Try to extract Android model from UA e.g. "Android 13; SM-G991B Build/..."
    const match = ua.match(/Android\s+[\d.]+;\s*([^;)]+?)(?:\s+Build|[;)])/i);
    if (match && match[1]) {
      const rawModel = match[1].trim();
      // "K" is the standard UA-reduction placeholder in modern Chrome
      if (rawModel && rawModel !== "K" && rawModel !== "Mobile") {
        return `Android (${rawModel})`;
      }
    }
    return t("device.android");
  }

  // Windows
  if (/Windows/i.test(ua)) return t("device.windows");

  // macOS
  if (/Macintosh|Mac OS X/i.test(ua)) return t("device.mac");

  // Chrome OS
  if (/CrOS/i.test(ua)) return t("device.chromebook");

  // Linux (non-Android)
  if (/Linux/i.test(ua)) return t("device.linux");

  return t("device.unknown");
}

export function detectDeviceNameSync(): string {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return t("device.unknown");
  }

  const saved = localStorage.getItem("pd_device_name");
  if (saved) return saved;

  // Try navigator.userAgentData synchronous platform first
  if (navigator.userAgentData?.platform) {
    const platform = navigator.userAgentData.platform;
    const isMobile = navigator.userAgentData.mobile;
    if (platform === "Android") {
      return t("device.android");
    }
    if (platform === "Windows") {
      return t("device.windows");
    }
    if (platform === "macOS") {
      return t("device.mac");
    }
    if (platform === "Linux") {
      return isMobile ? t("device.android") : t("device.linux");
    }
    if (platform === "iOS") {
      return t("device.iphone");
    }
    if (platform === "Chrome OS") {
      return t("device.chromebook");
    }
  }

  return parseUserAgent(navigator.userAgent || "");
}

export async function resolveAndroidModelName(rawModel: string): Promise<string> {
  const model = rawModel.trim();
  if (!model || model === "K" || model === "Mobile") {
    return t("device.android");
  }
  try {
    const { default: modelMap } = await import("./android-models.json");
    const mapped = (modelMap as Record<string, string>)[model];
    if (mapped) {
      return mapped;
    }
  } catch {
    // Fallback if dynamic import fails
  }
  return `Android (${model})`;
}

export async function detectDeviceNameAsync(): Promise<string> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return t("device.unknown");
  }

  const saved = localStorage.getItem("pd_device_name");
  if (saved) return saved;

  // Use UA-CH (User-Agent Client Hints) if available
  if (navigator.userAgentData?.getHighEntropyValues) {
    try {
      const data = await navigator.userAgentData.getHighEntropyValues([
        "model",
        "platform",
      ]);
      const platform = data.platform || navigator.userAgentData.platform;
      const model = data.model?.trim();

      if (platform === "Android") {
        if (model && model !== "K" && model !== "Mobile") {
          return await resolveAndroidModelName(model);
        }
        return t("device.android");
      }
      if (platform === "Windows") {
        return t("device.windows");
      }
      if (platform === "macOS") {
        return t("device.mac");
      }
      if (platform === "Linux") {
        if (navigator.userAgentData.mobile) {
          if (model && model !== "K" && model !== "Mobile") {
            return await resolveAndroidModelName(model);
          }
          return t("device.android");
        }
        return t("device.linux");
      }
      if (platform === "Chrome OS") {
        return t("device.chromebook");
      }
    } catch {
      // Fallback to sync detection
    }
  }

  // Fallback: Check if UA string contains an Android model
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) {
    const match = ua.match(/Android\s+[\d.]+;\s*([^;)]+?)(?:\s+Build|[;)])/i);
    if (match && match[1]) {
      const rawModel = match[1].trim();
      if (rawModel && rawModel !== "K" && rawModel !== "Mobile") {
        return await resolveAndroidModelName(rawModel);
      }
    }
  }

  return detectDeviceNameSync();
}

