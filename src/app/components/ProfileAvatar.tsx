"use client";

import { useEffect, useRef, useState } from "react";

export function ProfileAvatar({ name, src }: { name: string; src: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && src) { if (image.naturalWidth) setLoaded(src); else setFailed(src); }
  }, [src]);
  const initials = name.replace(/^[@\s]+/, "").trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0] ?? "").join("").toLocaleUpperCase("tr-TR") || "?";
  return <span className="profile-avatar" aria-hidden="true">
    {initials}
    {src && failed !== src
      // Remote provider images remain optional; a missing or expired image falls back to initials.
      // eslint-disable-next-line @next/next/no-img-element
      ? <img ref={imageRef} src={src} alt="" width={36} height={36} loading="lazy" referrerPolicy="no-referrer" style={{ opacity: loaded === src ? 1 : 0 }} onLoad={() => setLoaded(src)} onError={() => setFailed(src)} />
      : null}
  </span>;
}
