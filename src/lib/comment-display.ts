function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password
      || [...url.searchParams.keys()].some((key) => /token|secret|authorization/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

export function commentDisplay(raw: unknown) {
  const data = object(raw);
  const detail = object(data.detail);
  const author = object(data.from ?? detail.from);
  const picture = object(object(author.picture).data);
  const post = object(data.source_post);
  return {
    author_avatar_url: publicUrl(data.author_avatar_url ?? picture.url ?? detail.profile_picture_url),
    source_channel: typeof data.source_channel === "string" ? data.source_channel : null,
    source_post: {
      id: typeof post.id === "string" ? post.id : null,
      text: typeof post.text === "string" ? post.text : null,
      permalink: publicUrl(post.permalink ?? post.permalink_url),
    },
    context_incomplete: data.context_incomplete === true,
  };
}
