/**
 * صياغة الردود العربية لأدوات MCP (قسم 8 من المواصفة).
 * كل رسائل الأدوات بالعربية — المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية.
 * لا تخرج من هنا أبدًا رسالة تذكر مفاتيح أو رصيد (قاعدة ذهبية 4).
 */
import { parseTaskAttempts, parseTaskUrls, type TaskRow } from "@/lib/turso";

/** مكتملة صورة: ✅ + markdown للصورة + الرابط المباشر */
export function fmtImageCompleted(urls: string[]): string {
  const u = urls.join("\nالرابط المباشر: ");
  return `✅ تم توليد الصورة بنجاح\n\n![image](${urls[0]})\n\nالرابط المباشر: ${u}`;
}

/** مكتملة فيديو: ✅ + الروابط المباشرة */
export function fmtVideoCompleted(urls: string[]): string {
  return `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${urls.join("\nالرابط المباشر: ")}`;
}

/** مكتملة دمج: ✅ + الروابط + تنبيه الحذف بعد ~24 ساعة */
export function fmtMergeCompleted(urls: string[]): string {
  return (
    `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${urls.join("\nالرابط المباشر: ")}\n\n` +
    `⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`
  );
}

/** جارية: ⏳ + task_id + توجيه المتابعة */
export function fmtProcessing(task: TaskRow): string {
  const progress = task.progress > 0 ? `\n\nالتقدم الحالي: ${task.progress}%` : "";
  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.${progress}`;
}

/** فاشلة: ❌ + السبب (مع isError: true من المستدعي) */
export function fmtFailed(message: string): string {
  return `❌ فشلت المهمة: ${message}`;
}

/** تنسيق أي مهمة حسب حالتها ونوعها — الواجهة الموحدة لأدوات التوليد و get_task */
export function fmtTaskResult(task: TaskRow): { text: string; isError: boolean } {
  if (task.status === "completed") {
    const urls = parseTaskUrls(task);
    if (task.type === "image") return { text: fmtImageCompleted(urls), isError: false };
    if (task.type === "merge") return { text: fmtMergeCompleted(urls), isError: false };
    return { text: fmtVideoCompleted(urls), isError: false };
  }
  if (task.status === "failed") {
    return { text: fmtFailed(task.error_message ?? "سبب غير معروف"), isError: true };
  }
  return { text: fmtProcessing(task), isError: false };
}

/** أسماء أنواع المهام بالعربية للعرض في list_media */
const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "بانتظار البدء",
};

/** list_media: أحدث الوسائط المخزنة بروابطها من الأحدث */
export function fmtMediaList(tasks: TaskRow[]): string {
  if (!tasks.length) {
    return "لا توجد وسائط مخزنة بعد. استخدم generate_image أو generate_video لتوليد وسائط جديدة.";
  }
  const lines = tasks.map((t, i) => {
    const urls = parseTaskUrls(t);
    const status = STATUS_AR[t.status] ?? t.status;
    const head = `${i + 1}. [${TYPE_AR[t.type] ?? t.type}] ${t.model} — ${status}${t.status === "processing" && t.progress ? ` (${t.progress}%)` : ""}`;
    const links = urls.length ? `\n   الرابط: ${urls.join("\n   الرابط: ")}` : "";
    const err = t.status === "failed" && t.error_message ? `\n   الخطأ: ${t.error_message}` : "";
    return `${head}\n   task_id: ${t.id}\n   أُنشئت: ${t.created_at} UTC${links}${err}`;
  });
  return `📁 أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`;
}

/** عدد المحاولات لعرضه في الواجهة */
export function attemptsCount(task: TaskRow): number {
  return parseTaskAttempts(task).length;
}
