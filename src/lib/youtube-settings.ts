import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { youtubeSettings } from "@/db/schema";

export async function getYouTubeSettings() {
  const [row] = await db.select().from(youtubeSettings).where(eq(youtubeSettings.id, "primary"));
  return row ?? null;
}
