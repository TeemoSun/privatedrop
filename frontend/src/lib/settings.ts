const KEY_SEND_ON_ENTER = "pd_send_on_enter";
const KEY_THEME = "pd_theme";

export type Theme = "light" | "dark" | "system";

export function getTheme(): Theme {
  try {
    const val = localStorage.getItem(KEY_THEME);
    if (val === "light" || val === "dark" || val === "system") {
      return val;
    }
    return "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (typeof document !== "undefined") {
    if (isDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }

    const metaThemeColor = document.querySelector("meta[name='theme-color']");
    if (metaThemeColor) {
      metaThemeColor.setAttribute("content", isDark ? "#020817" : "#ffffff");
    }
  }
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY_THEME, theme);
  } catch {}
  applyTheme(theme);
}

export function initTheme(): void {
  const theme = getTheme();
  applyTheme(theme);

  if (typeof window !== "undefined" && window.matchMedia) {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (getTheme() === "system") {
        applyTheme("system");
      }
    };

    try {
      mediaQuery.addEventListener("change", handleChange);
    } catch {
      mediaQuery.addListener(handleChange);
    }
  }
}

export function getSendOnEnter(): boolean {
  try {
    const val = localStorage.getItem(KEY_SEND_ON_ENTER);
    if (val === null) return true; // Default: true (使用回车发送)
    return val === "true";
  } catch {
    return true;
  }
}

export function setSendOnEnter(enabled: boolean): void {
  try {
    localStorage.setItem(KEY_SEND_ON_ENTER, String(enabled));
  } catch {}
}


