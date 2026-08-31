const KEY_SEND_ON_ENTER = "pd_send_on_enter";

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

