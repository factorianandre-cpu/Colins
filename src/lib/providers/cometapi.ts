/**
 * مزود CometAPI — api.cometapi.com (المزود الثاني).
 *
 * الصور: نقطة متوافقة مع OpenAI تُعيد النتيجة فورًا (متزامنة):
 *   POST {base}/v1/images/generations {"model","prompt","size","response_format":"url"}
 *   → {"data":[{"url": "..."}]} وقد تعيد b64_json عندئذ نبنيها كرابط data URI
 *     (لا ننزّل أي وسائط على السيرفر — القاعدة الذهبية 1).
 *
 * الفيديو: مهام غير متزامنة وفق توثيق apidoc.cometapi.com الحالي:
 *   POST {base}/v1/videos {"model","prompt","seconds","size"?}
 *   → {"id"/"task_id","status":"queued","progress":0}
 *   GET  {base}/v1/videos/{id}
 *   → status: queued | in_progress | completed | failed | error، ورابط الفيديو في أحد
 *     المواضع الشائعة (video_url/url/metadata.url/…) — نحللها دفاعيًا بترتيب ثابت.
 *
 * ملاحظة: لا يوجد مفتاح CometAPI في بيئة الاختبار الحالية، لذلك هذه المسارات مكتوبة
 * وفق التوثيق المنشور مع تحليل دفاعي، وتُصحّح بسهولة إن تغيّر الشكل.
 */
import {
  ProviderError,
  providerFetch,
  extractErrorMessage,
  type ProviderAdapter,
  type ProviderCheckResult,
  type ProviderKey,
} from "./types";

const COMET_BASE = (process.env.COMETAPI_API_BASE || "https://api.cometapi.com").replace(/\/+$/, "");

function authHeaders(key: ProviderKey): Record<string, string> {
  return { Authorization: `Bearer ${key.api_key}`, "Content-Type": "application/json" };
}

/** رفع أخطاء OpenAI-ستايل: {"error":{"message":...}} أو نص خام */
async function throwCometError(res: Response): Promise<never> {
  const text = await res.text();
  let status = res.status;
  let msg = extractErrorMessage(text);
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    // بعض بوابات OpenAI توضع الكود داخل error.code أو الحالة داخل الحقول
    if (j.error && typeof j.error === "object") {
      const err = j.error as Record<string, unknown>;
      msg = String(err.message ?? err.code ?? msg);
    }
  } catch {
    /* نص خام — نستخدم ما استخرجناه */
  }
  throw new ProviderError(status, msg);
}

/** استخراج رابط الفيديو من استجابة مكتملة بترتيب مواضع معروفة لدى البوابات المتوافقة */
function extractVideoUrl(body: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    body.video_url,
    body.url,
    body.output,
    (body.metadata as Record<string, unknown> | undefined)?.url,
    (body.result as Record<string, unknown> | undefined)?.url,
    (body.data as unknown[] | undefined)?.[0],
    (body.videos as unknown[] | undefined)?.[0],
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const u = o.url ?? o.video_url;
      if (typeof u === "string" && u.startsWith("http")) return u;
    }
  }
  return null;
}

/** خريطة تقدم تقديري لحالات CometAPI عندما يغيب progress */
const STATUS_PROGRESS: Record<string, number> = { queued: 15, in_progress: 55 };

export const cometapiAdapter: ProviderAdapter = {
  /** صور متزامنة — تعيد الروابط فورًا */
  async createImageSync(key: ProviderKey, input: Record<string, unknown>) {
    // تحويل aspect_ratio/resolution إلى size بصيغة OpenAI التقريبية
    const ratio = String(input.aspect_ratio ?? "auto");
    const resolution = String(input.resolution ?? "1K");
    const px = resolution === "4K" ? "4096x4096" : resolution === "2K" ? "2048x2048" : "1024x1024";
    let size = "auto";
    if (ratio !== "auto") {
      const wide = ["3:2", "16:9", "5:4", "2:1", "21:9", "3:1", "4:3"];
      const tall = ["2:3", "9:16", "4:5", "1:2", "9:21", "1:3", "3:4"];
      const [w, h] = px.split("x").map(Number);
      if (wide.includes(ratio)) size = `${w}x${Math.round((h * 2) / 3)}`;
      else if (tall.includes(ratio)) size = `${Math.round((w * 2) / 3)}x${h}`;
      else size = `${w}x${h}`; // 1:1
    }

    const res = await providerFetch(`${COMET_BASE}/v1/images/generations`, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({
        model: input.__providerModel,
        prompt: input.prompt,
        n: 1,
        size,
        response_format: "url",
      }),
      timeoutMs: 120_000, // الصور المتزامنة قد تأخذ عشرات الثواني
    });
    if (!res.ok) await throwCometError(res);

    const body = (await res.json()) as Record<string, unknown>;
    const arr = body.data as Array<Record<string, unknown>> | undefined;
    const urls: string[] = [];
    for (const item of arr ?? []) {
      if (typeof item.url === "string" && item.url) urls.push(item.url);
      else if (typeof item.b64_json === "string" && item.b64_json) {
        // b64_json: نبنيها رابط بيانات مباشرًا — لا تنزيل على السيرفر ولا تخزين ملفات
        urls.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
    if (!urls.length) throw new ProviderError(undefined, "استجابة images/generations من CometAPI دون روابط");
    return { urls };
  },

  async createTask(key: ProviderKey, model: string, input: Record<string, unknown>) {
    const payload: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      seconds: input.duration, // حقل المدة لدى CometAPI باسم seconds
    };
    if (typeof input.image_url === "string" && input.image_url) {
      payload.input_reference = [input.image_url];
    }
    const res = await providerFetch(`${COMET_BASE}/v1/videos`, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify(payload),
      timeoutMs: 60_000,
    });
    if (!res.ok) await throwCometError(res);

    const body = (await res.json()) as Record<string, unknown>;
    const taskId = (body.task_id ?? body.id) as string | undefined;
    if (!taskId) throw new ProviderError(undefined, "استجابة /v1/videos من CometAPI بدون معرّف مهمة");
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<ProviderCheckResult> {
    const res = await providerFetch(`${COMET_BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: authHeaders(key),
    });
    if (!res.ok) await throwCometError(res);

    const body = (await res.json()) as Record<string, unknown>;
    const status = String(body.status ?? "").toLowerCase();
    const rawProgress = Number(body.progress ?? 0);
    const progress = rawProgress > 0 && rawProgress <= 1 ? rawProgress * 100 : rawProgress; // كسر 0..1 يُضرب في 100

    if (status === "completed" || status === "succeeded") {
      const url = extractVideoUrl(body);
      if (!url) return { status: "failed", error: "اكتملت المهمة لدى CometAPI دون رابط فيديو" };
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (status === "failed" || status === "error") {
      const err = body.error;
      const msg =
        typeof err === "string" ? err : String((err as Record<string, unknown> | undefined)?.message ?? "فشل المزود دون رسالة");
      return { status: "failed", error: msg };
    }
    return {
      status: "processing",
      progress: Math.min(99, Math.round(progress || STATUS_PROGRESS[status] || 20)),
    };
  },
};
