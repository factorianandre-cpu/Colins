/**
 * سجل الموديلات — الأسماء التي يراها عميل MCP (canonical) مثبّتة كما هي في المواصفة،
 * وأسماء المزودين قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL, KIE_VIDEO_MODEL,
 * COMETAPI_IMAGE_MODEL, COMETAPI_VIDEO_MODEL).
 *
 * تنبيه مقاس من التوثيق الرسمي (docs.kie.ai): اسم موديل الفيديو لدى kie يُرسل بصيغة
 * «grok-imagine-video-1.5-preview» (بنقطة) بينما الاسم canonical الذي يراه العميل
 * بصيغة الشرطة — قِبل الاثنين عبر aliases ونوحّدها.
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب التسلسلي
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
// مقاس فعليًا: الاسم بالشرطة يُقبل لدى kie (createTask أعاد code:200) — والمواصفة تثبته للاثنين
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1.5-preview";

export const IMAGE_CANONICAL = "gpt-image-2-6/flare-text-to-image";
export const VIDEO_CANONICAL = "grok-imagine-video-1-5-preview";
export const MERGE_MODEL = "video-merger";

export const MODELS: ModelDef[] = [
  {
    canonical: IMAGE_CANONICAL,
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: VIDEO_CANONICAL,
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

/** توحيد الصيغ البديلة: النقاط تتحول لشرطات قبل المقارنة (gpt-image-2.6/… → gpt-image-2-6/…) */
export function normalizeModelName(name: string): string {
  return (name || "").trim().replace(/\./g, "-").toLowerCase();
}

/** يوحّد اسم الموديل عبر aliases — يُرجع تعريف الموديل أو null إن كان غير معروف */
export function resolveModel(name?: string): ModelDef | null {
  if (!name) return null;
  const n = normalizeModelName(name);
  for (const m of MODELS) {
    if (m.aliases.some((a) => normalizeModelName(a) === n)) return m;
  }
  return null;
}

export const DEFAULT_MODEL_BY_TYPE: Record<Exclude<MediaType, "merge">, string> = {
  image: IMAGE_CANONICAL,
  video: VIDEO_CANONICAL,
};
