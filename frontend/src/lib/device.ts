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

export function parseUserAgent(ua: string): string {
  if (!ua) return "未知设备";

  // Check iPad (including newer iPadOS reporting as Macintosh with multi-touch)
  const isIPad =
    /iPad/i.test(ua) ||
    (/Macintosh/i.test(ua) && typeof navigator !== "undefined" && (navigator.maxTouchPoints || 0) > 1);
  if (isIPad) return "iPad";

  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPod/i.test(ua)) return "iPod";

  // HarmonyOS / OpenHarmony
  if (/HarmonyOS/i.test(ua)) return "HarmonyOS 设备";
  if (/OpenHarmony/i.test(ua)) return "OpenHarmony 设备";

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
    return "Android 设备";
  }

  // Windows
  if (/Windows/i.test(ua)) return "Windows PC";

  // macOS
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";

  // Chrome OS
  if (/CrOS/i.test(ua)) return "Chromebook";

  // Linux (non-Android)
  if (/Linux/i.test(ua)) return "Linux PC";

  return "未知设备";
}

export function detectDeviceNameSync(): string {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "未知设备";
  }

  const saved = localStorage.getItem("pd_device_name");
  if (saved) return saved;

  // Try navigator.userAgentData synchronous platform first
  if (navigator.userAgentData?.platform) {
    const platform = navigator.userAgentData.platform;
    const isMobile = navigator.userAgentData.mobile;
    if (platform === "Android") {
      return "Android 设备";
    }
    if (platform === "Windows") {
      return "Windows PC";
    }
    if (platform === "macOS") {
      return "Mac";
    }
    if (platform === "Linux") {
      return isMobile ? "Android 设备" : "Linux PC";
    }
    if (platform === "iOS") {
      return "iPhone";
    }
    if (platform === "Chrome OS") {
      return "Chromebook";
    }
  }

  return parseUserAgent(navigator.userAgent || "");
}

export async function detectDeviceNameAsync(): Promise<string> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "未知设备";
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
          return `Android (${model})`;
        }
        return "Android 设备";
      }
      if (platform === "Windows") {
        return "Windows PC";
      }
      if (platform === "macOS") {
        return "Mac";
      }
      if (platform === "Linux") {
        if (navigator.userAgentData.mobile) {
          if (model && model !== "K") return `Android (${model})`;
          return "Android 设备";
        }
        return "Linux PC";
      }
      if (platform === "Chrome OS") {
        return "Chromebook";
      }
    } catch {
      // Fallback to sync detection
    }
  }

  return detectDeviceNameSync();
}

