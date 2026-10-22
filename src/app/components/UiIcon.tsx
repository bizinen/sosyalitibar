type IconName = "comments" | "accounts" | "spark" | "bell" | "target" | "settings" | "plus" | "arrow" | "check" | "logout" | "shield" | "more" | "external" | "pause" | "play" | "trash" | "refresh" | "search" | "sort" | "filter";

const paths: Record<IconName, string> = {
  comments: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5ZM8 10h8M8 14h5",
  accounts: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  target: "M21 12a9 9 0 1 1-9-9M16 12a4 4 0 1 1-4-4M12 12l9-9M16 3h5v5",
  settings: "M4 7h16M4 17h16M9 4v6M16 14v6",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  check: "m5 12 4 4L19 6",
  logout: "M9 4H4v16h5M10 12h11m-4-4 4 4-4 4",
  shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6",
  more: "M12 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM12 18a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
  external: "M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5",
  pause: "M8 5v14M16 5v14",
  play: "m8 4 12 8-12 8V4Z",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  refresh: "M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  sort: "M7 3v18m-4-4 4 4 4-4M15 5h6M15 10h4M15 15h2",
  filter: "M3 4h18l-7 8v7l-4 2v-9L3 4Z",
};

export function UiIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><UiIcon name="shield" size={23} /></span>;
}
