"use client";

import { CheckIcon, LinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const actionClass =
  "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-gray-800 transition-colors hover:bg-gray-alpha-200 hover:text-gray-1000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 motion-reduce:transition-none";

interface BlogShareActionsProps {
  title: string;
  url: string;
}

export const BlogShareActions = ({ title, url }: BlogShareActionsProps) => {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const encodedTitle = encodeURIComponent(title);
  const encodedUrl = encodeURIComponent(url);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="-ml-2.5 flex flex-col gap-0.5">
      <button className={actionClass} onClick={copyUrl} type="button">
        {copied ? (
          <CheckIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <LinkIcon aria-hidden="true" className="size-3.5" />
        )}
        <span aria-live="polite">{copied ? "Copied" : "Copy URL"}</span>
      </button>
      <a
        className={actionClass}
        href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`}
        rel="noreferrer"
        target="_blank"
      >
        <svg aria-hidden="true" className="size-3.5" fill="currentColor" viewBox="0 0 16 16">
          <path d="M13.63 13.63h-2.37V9.92c0-.89-.02-2.03-1.24-2.03-1.24 0-1.43.97-1.43 1.96v3.78H6.22V6H8.5v1.04h.03a2.5 2.5 0 0 1 2.25-1.24c2.4 0 2.85 1.58 2.85 3.64zM3.54 4.96a1.38 1.38 0 1 1 0-2.75 1.38 1.38 0 0 1 0 2.75m1.19 8.67H2.35V6h2.38zM14.82.67H1.18C.53.67 0 1.18 0 1.82v13.7c0 .65.53 1.16 1.18 1.16h13.63c.65 0 1.19-.51 1.19-1.15V1.82c0-.64-.54-1.15-1.19-1.15z" />
        </svg>
        Share on LinkedIn
      </a>
      <a
        className={actionClass}
        href={`https://x.com/intent/post?text=${encodedTitle}&url=${encodedUrl}`}
        rel="noreferrer"
        target="_blank"
      >
        <span aria-hidden="true" className="flex size-3.5 items-center justify-center font-medium">
          𝕏
        </span>
        Share on X
      </a>
    </div>
  );
};
