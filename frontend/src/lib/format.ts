import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

function parseDate(iso: string | Date | null | undefined): dayjs.Dayjs {
  if (!iso) return dayjs();
  if (typeof iso === "string") {
    const trimmed = iso.trim();
    if (
      trimmed.includes("T") &&
      !trimmed.endsWith("Z") &&
      !trimmed.slice(10).includes("+") &&
      !trimmed.slice(10).includes("-")
    ) {
      return dayjs(trimmed + "Z");
    }
    return dayjs(trimmed);
  }
  return dayjs(iso);
}

/**
 * 列表时间格式化：
 * - 如果在当前用户浏览器时区的同一个自然日内（今天），显示“多久之前”（如：刚刚、5分钟前、2小时前）；
 * - 如果不是今天（跨越了自然日或更久），显示用户本地时区的实际年月日时分（如：2026-08-30 14:20）。
 */
export function formatItemTime(iso: string | Date): string {
  const d = parseDate(iso);
  const now = dayjs();
  if (d.isSame(now, "day")) {
    return d.fromNow();
  }
  return d.format("YYYY-MM-DD HH:mm");
}

export function fromNow(iso: string | Date): string {
  return formatItemTime(iso);
}

export function formatDateTime(iso: string | Date): string {
  return parseDate(iso).format("YYYY-MM-DD HH:mm");
}

