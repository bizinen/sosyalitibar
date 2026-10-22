import { z } from "zod";

export const triageLabels = {
  inceleme_gerekmiyor: "İnceleme gerekmiyor",
  insan_incelemesi_gerekli: "İnsan incelemesi gerekli",
  acil_inceleme: "Acil inceleme",
} as const;
export const triageLabelSchema = z.enum(["inceleme_gerekmiyor", "insan_incelemesi_gerekli", "acil_inceleme"]);
export type TriageLabel = z.infer<typeof triageLabelSchema>;

export const DEFAULT_TRIAGE_PROMPT = `Yorumları izlenen kişi ve kurumlar hakkında inceleme ihtiyacına göre değerlendir.
Her yorum için yalnız bir etiket seç:
- inceleme_gerekmiyor: bağlamı anlaşılmış, insan incelemesi gerektirmeyen destek, olağan soru veya olağan görüş ayrılığı.
- insan_incelemesi_gerekli: kişiye yönelik yalancılık/sahtekârlık/dolandırıcılık suçlaması, hakaret, karalama adayı, ciddi iddia, alay yoluyla kişisel saldırı veya anlam/hedef belirsizliği.
- acil_inceleme: açık veya makul biçimde şüphe uyandıran fiziksel tehdit, şiddet çağrısı, kişisel bilgileri ifşa ederek hedef gösterme ya da yakın tehlike.
Yorumun dilini, argoyu, ironiyi ve olumsuzlamayı değerlendir. İsmin geçmesi şart değildir; paylaşım ve üst yorumdan kime yöneldiğini anla. Başkasının iddiasını reddeden/alıntılayan kişiye bu iddiayı mal etme. Normal eleştiriyi hakaret veya tehdit sayma. İddianın doğruluğuna hükmetme. Hedef, dil veya bağlam belirsizse insan_incelemesi_gerekli seç. Yorumlar birbirinden bağımsızdır; bir yorumun kararını diğerine taşıma.`;
export const DEFAULT_TRANSLATION_PROMPT = "Metni Türkçeye sadık biçimde çevir. Hakaret, tehdit, iddia, belirsizlik ve ironiyi yumuşatma veya güçlendirme. Metin zaten Türkçeyse değiştirme. Yorum, hüküm veya açıklama ekleme.";
export const aiPolicySchema = z.object({
  triagePrompt: z.string().trim().min(20).max(16000),
  targetContext: z.string().trim().max(16000),
  sourceContext: z.string().trim().max(8000),
  translationPrompt: z.string().trim().min(10).max(8000),
  legacyPrompt: z.string().trim().max(24000),
  batchSize: z.number().int().min(1).max(50),
  batchWaitMs: z.number().int().min(0).max(5000),
  batchMaxChars: z.number().int().min(4000).max(60000),
}).strict();
export type AiPolicy = z.infer<typeof aiPolicySchema>;
export const defaultAiPolicy: AiPolicy = { triagePrompt: DEFAULT_TRIAGE_PROMPT, targetContext: "", sourceContext: "",
  translationPrompt: DEFAULT_TRANSLATION_PROMPT, legacyPrompt: "", batchSize: 20, batchWaitMs: 3000, batchMaxChars: 24000 };

export function parseTriageResults(content: string, ids: string[]) {
  const envelope = z.object({ results: z.array(z.object({ id: z.string().max(80), label: triageLabelSchema }).strict()).max(100) }).strict().parse(JSON.parse(content));
  const expected = new Set(ids);
  if (envelope.results.some((row) => !expected.has(row.id))) throw new Error("triage_unknown_id");
  const counts = new Map<string, number>();
  for (const row of envelope.results) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return new Map(envelope.results.filter((row) => counts.get(row.id) === 1).map((row) => [row.id, row.label]));
}
