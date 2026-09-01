import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "../../lib/utils";

interface ExpandableTextProps {
  text: string;
  maxLines?: number;
  className?: string;
  textClassName?: string;
}

export function ExpandableText({
  text,
  maxLines = 4,
  className,
  textClassName,
}: ExpandableTextProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;

    const checkOverflow = () => {
      if (!isExpanded) {
        // When collapsed with line-clamp-4
        setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
      } else {
        // When expanded, calculate whether content height exceeds maxLines * lineHeight
        const computed = window.getComputedStyle(el);
        const lineHeight =
          parseFloat(computed.lineHeight) ||
          parseFloat(computed.fontSize) * 1.5 ||
          20;
        const maxCollapsedHeight = lineHeight * (maxLines + 0.1);
        setIsOverflowing(el.scrollHeight > maxCollapsedHeight);
      }
    };

    checkOverflow();

    const ro = new ResizeObserver(() => {
      checkOverflow();
    });
    ro.observe(el);

    document.fonts?.ready?.then(() => {
      checkOverflow();
    });

    return () => {
      ro.disconnect();
    };
  }, [text, isExpanded, maxLines]);

  return (
    <div className={className}>
      <p
        ref={textRef}
        className={cn(
          "whitespace-pre-wrap break-words break-all text-sm leading-relaxed",
          !isExpanded && "line-clamp-4",
          textClassName,
        )}
      >
        {text}
      </p>
      {isOverflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded((prev) => !prev);
          }}
          className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline focus-visible:outline-none cursor-pointer select-none"
        >
          <span>{isExpanded ? "收起" : "展开"}</span>
          {isExpanded ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </div>
  );
}
