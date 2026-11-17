/**
 * مزود kie.ai — Jobs API الموحد (الأشكال أدناه مقاسة فعليًا وتؤكدها docs.kie.ai):
 *
 * POST {base}/api/v1/jobs/createTask  {"model": "...", "input": {...}}
 *   → HTTP 200 مع {"code":200,"msg":"success","data":{"taskId":"..."}}
 *   ⚠️ الأخطاء تُعاد بحالة HTTP 200 وكود داخل الجسم (مقاس فعليًا: {"code":401,"msg":"Unauthorized…"})
 *     لذلك نجتاز الجسم دائمًا ونتحقق من code !== 200.
 *
 * GET {base}/api/v1/jobs/recordInfo?taskId=...
 *   → data.state: waiting|queuing|generating|success|fail
 *     data.resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا → {"resultUrls":[...]}
 *     data.failMsg نص الفشل، و data.progress رقم 0..100 إن توفر.
 */
import {
  ProviderError,
  providerFetch,
  extractErrorMessage,
  type ProviderAdapter,
  type ProviderCheckResult,
  type ProviderKey,
} from "./types";

// العنوان قابل للتجاوز ببيئة الاختبار فقط — الإنتاج يستخدم الرسمي
const KIE_BASE = (process.env.KIE_API_BASE || "https://api.kie.ai").replace(/\/+$/, "");

/** خريطة تقدير التقدم من حالة kie عندما لا يتوفر حقل progress رقمي */
const STATE_PROGRESS: Record<string, number> = {
  waiting: 10,
  queuing: 30,
  generating: 60,
};

/** تحليل resultUrls من resultJson (نص JSON داخل JSON) دفاعيًا مع الالتزام بالشكل الرسمي */
function parseResultUrls(data: Record<string, unknown>): string[] {
  // الشكل الرسمي: resultJson نص → {"resultUrls": [...]}
  if (typeof data.resultJson === "string" && data.resultJson.trim()) {
    try {
      const inner = JSON.parse(data.resultJson) as Record<string, unknown>;
      const urls = inner.resultUrls;
      if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === "string" && !!u);
    } catch {
      // نتجاهل التحليل الفاشل ونكمل للفحوص الدفاعية أدناه
    }
  }
  // دفاعي: لو أجرى المزود تغييرًا لاحقًا ووضع المصفوفة مباشرة
  if (Array.isArray(data.resultUrls)) {
    return (data.resultUrls as unknown[]).filter((u): u is string => typeof u === "string" && !!u);
  }
  return [];
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: ProviderKey, model: string, input: Record<string, unknown>) {
    const res = await providerFetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input }),
    });

    // kie يعيد 200 غالبًا حتى مع الأخطاء — نقرأ الجسم أولًا
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ProviderError(res.ok ? undefined : res.status, extractErrorMessage(text));
    }

    const code = Number(body.code ?? (res.ok ? 200 : res.status));
    if (code !== 200 || !body.data) {
      // حالة التصنيف: كود الجسم إن وُجد وإلا حالة HTTP
      throw new ProviderError(Number.isFinite(code) ? code : res.status, String(body.msg ?? extractErrorMessage(text)));
    }
    const data = body.data as Record<string, unknown>;
    const taskId = data.taskId;
    if (typeof taskId !== "string" || !taskId) {
      throw new ProviderError(undefined, "استجابة createTask من kie.ai بدون taskId");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<ProviderCheckResult> {
    const res = await providerFetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key.api_key}` },
    });

    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ProviderError(res.ok ? undefined : res.status, extractErrorMessage(text));
    }
    const code = Number(body.code ?? (res.ok ? 200 : res.status));
    if (code !== 200 || !body.data) {
      throw new ProviderError(Number.isFinite(code) ? code : res.status, String(body.msg ?? extractErrorMessage(text)));
    }

    const data = body.data as Record<string, unknown>;
    const state = String(data.state ?? "waiting");
    const progress = typeof data.progress === "number" && data.progress > 0 ? data.progress : STATE_PROGRESS[state] ?? 10;

    if (state === "success") {
      const urls = parseResultUrls(data);
      if (!urls.length) {
        // نجاح بلا روابط — نعامله كفشل حقيقي بسبب واضح
        return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتيجة" };
      }
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      return { status: "failed", error: String(data.failMsg || "فشل المزود دون رسالة") };
    }
    return { status: "processing", progress: Math.min(99, Math.round(progress)) };
  },
};
