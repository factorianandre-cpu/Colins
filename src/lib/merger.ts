/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق).
 * العنوان من MERGER_API_BASE. المخرجات: MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18.
 * القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد،
 * وكل الملفات تُحذف تلقائيًا بعد 24 ساعة (expiresAt).
 *
 * قاعدة حتمية (قسم 7.3.5): أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري
 * بلا إعادة محاولة — لأن تكرار المحاولة يعطي النتيجة نفسها (مثل مصدر يرفض التحميل).
 * أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → نستمر بالاستعلام حتى انتهاء النافذة.
 *
 * لا ننزّل أي وسائط على سيرفرنا إطلاقًا — نرسل الروابط ونخزّن روابط النتائج فقط.
 */
import { randomUUID } from "node:crypto";
import {
  getTask,
  insertTask,
  updateTask,
  parseTaskUrls,
  type TaskRow,
} from "@/lib/turso";
import { scrubSecrets } from "@/lib/mask";
import type { ProgressCb } from "@/lib/generation";

/** بث آمن لإشعارات التقدم — لا يفشل ولا يكسر المهمة */
function safeEmit(cb: ProgressCb | undefined, p: { progress: number; total: number; message: string }): void {
  if (!cb) return;
  void Promise.resolve()
    .then(() => cb(p))
    .catch(() => {});
}

const MERGE_LIMIT_MAX = 10;
const PROCESS_REKICK_AFTER_MS = 30_000; // عادة يستغرق process ~10-15 ثانية؛ إن بقيت queued أبعد من ذلك نعيد الإطلاق

/** سقف نافذة الانتظار داخل نفس الطلب: على Vercel نقصّه لحماية مهلة دوال serverless (maxDuration=60)؛
 *  خارج Vercel نحترم wait_seconds كما هو حتى 240 — والمتابعة تبقى ممكنة دائمًا عبر get_task. */
const WAIT_CAP_SECONDS = process.env.VERCEL ? 40 : 240;

/** العنوان الافتراضي لخدمة الدمج المنشورة (Video Merger API v2) — قابل للتجاوز عبر MERGER_API_BASE */
const DEFAULT_MERGER_BASE = "https://moo-salah-merger.vercel.app";

export function mergerBase(): string {
  return (process.env.MERGER_API_BASE || DEFAULT_MERGER_BASE).replace(/\/+$/, "");
}

export function mergerConfigured(): boolean {
  return mergerBase().length > 0;
}

/** خطأ HTTP معلن من خدمة الدمج → نهائي. خطأ شبكتنا → مؤقت. */
export class MergerHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "MergerHttpError";
  }
}
export class MergerNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergerNetworkError";
  }
}

async function mergerFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  const base = mergerBase();
  if (!base) throw new MergerNetworkError("MERGER_API_BASE غير مضبوط");
  try {
    return await fetch(`${base}${path}`, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new MergerNetworkError(e instanceof Error ? e.message : String(e));
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

/** تحليل حالة الدمج دفاعيًا (قسم 7.2): كلمات اكتمال/فشل متعددة، و progress كسر 0..1 */
const DONE_WORDS = ["done", "completed", "complete", "success", "succeeded", "finished"];
const FAIL_WORDS = ["error", "failed", "failure", "cancelled", "canceled"];

export interface MergeJobState {
  status: "queued" | "processing" | "done" | "failed";
  progress: number; // 0..100
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

export function parseMergeStatus(body: Record<string, unknown>): MergeJobState {
  const rawStatus = typeof body.status === "string" ? body.status.toLowerCase() : undefined;
  const hasError = typeof body.error === "string" && body.error.length > 0;

  // انتبه: قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
  let status: MergeJobState["status"];
  if (rawStatus && DONE_WORDS.includes(rawStatus)) status = "done";
  else if (rawStatus && FAIL_WORDS.includes(rawStatus)) status = "failed";
  else if (hasError && !rawStatus) status = "failed";
  else if (rawStatus && FAIL_WORDS.some((w) => rawStatus.includes(w))) status = "failed";
  else if (rawStatus && DONE_WORDS.some((w) => rawStatus.includes(w))) status = "done";
  else status = rawStatus === "processing" || rawStatus === "queued" ? "processing" : "processing";

  let progress = Number(body.progress ?? 0);
  if (!Number.isFinite(progress)) progress = 0;
  if (progress > 0 && progress <= 1) progress *= 100; // قد يأتي كسرًا 0..1
  progress = Math.round(Math.max(0, Math.min(100, progress)));
  if (status === "done") progress = 100;

  const videoUrl = typeof body.videoUrl === "string" && body.videoUrl ? body.videoUrl : undefined;
  const downloadUrl = typeof body.downloadUrl === "string" && body.downloadUrl ? body.downloadUrl : undefined;

  return {
    status,
    progress,
    videoUrl,
    downloadUrl,
    error: hasError ? String(body.error) : undefined,
  };
}

/** رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط مسار /video القياسي */
function resultUrl(state: MergeJobState, jobId: string): string {
  return state.videoUrl ?? state.downloadUrl ?? `${mergerBase()}/api/jobs/${jobId}/video`;
}

/** فحص جهوزية الخدمة: GET /api/config بمهلة 4 ثوانٍ */
export async function checkMergerHealth(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const res = await fetch(`${mergerBase()}/api/config`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** تحقق صارم من الروابط: كلها http/https مباشرة وعامة */
export function validatePublicVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0") return false;
    // نطاقات داخلية/خاصة
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h === "[::1]" || h === "::1") return false;
    return true;
  } catch {
    return false;
  }
}

/* =================== قفل تنفيذ process مرة واحدة في الذاكرة =================== */
// يحمي من تزامن process مع get_task داخل نفس نسخة العمل (على Vercel يُضاف حماية زمنية عبر processKickedAt)
const processInFlight = new Set<string>();

async function kickProcess(jobId: string): Promise<{ terminal?: string; network?: boolean }> {
  if (processInFlight.has(jobId)) return {};
  processInFlight.add(jobId);
  try {
    const res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, {
      method: "POST",
      timeoutMs: 120_000, // يستغرق ~10-15 ثانية عادة (blocking) — نسمح بهامش أوسع
    });
    const body = await readJson(res);
    if (!res.ok) {
      // خطأ HTTP معلن (مثل {"error":"Download failed (HTTP 403)"}) = فشل نهائي فوري — لا إعادة محاولة
      return { terminal: String(body.error ?? `خطأ خدمة الدمج ${res.status}`) };
    }
    // نجاح 200 → {"status":"done","videoUrl":...} — نجمع النتيجة للاستخدام الفوري
    const state = parseMergeStatus(body);
    if (state.status === "done") {
      await updateMergeTask(jobId, { status: "completed", urls: [resultUrl(state, jobId)] });
      return {};
    }
    return {};
  } catch (e) {
    // أخطاء شبكتنا نحن = مؤقتة → نستمر بالاستعلام حتى انتهاء النافذة
    if (e instanceof MergerNetworkError) return { network: true };
    if (e instanceof MergerHttpError) return { terminal: e.message };
    return { network: true };
  } finally {
    processInFlight.delete(jobId);
  }
}

interface MergeTaskPatch {
  status?: string;
  progress?: number;
  urls?: string[];
  error_message?: string | null;
  provider_task_id?: string | null;
}

async function updateMergeTask(taskId: string, patch: MergeTaskPatch): Promise<TaskRow | null> {
  return updateTask(taskId, {
    status: patch.status,
    progress: patch.progress,
    result_urls_json: patch.urls ? JSON.stringify(patch.urls) : undefined,
    error_message: patch.error_message,
    provider_task_id: patch.provider_task_id,
  });
}

export interface RunMergeInput {
  urls: string[];
  task_ids: string[];
  wait_seconds?: number;
  progressCb?: ProgressCb;
}

export type MergeOutcome =
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow }
  | { kind: "failed"; task: TaskRow; message: string }
  | { kind: "validation_failed"; message: string; details: string[] }
  | { kind: "service_unconfigured"; message: string; details: string[] };

interface ResolvedSources {
  urls: string[];
  details: string[];
}

/** حلل task_ids لروابطها من قاعدة البيانات بالترتيب — التفاصيل الفاشلة تُجمع للعرض */
async function resolveTaskIds(taskIds: string[]): Promise<ResolvedSources> {
  const urls: string[] = [];
  const details: string[] = [];
  for (const tid of taskIds) {
    const t = await getTask(tid.trim());
    if (!t) {
      details.push(`- ${tid}: المهمة غير موجودة في قاعدة البيانات`);
      continue;
    }
    if (t.status !== "completed") {
      details.push(`- ${tid}: المهمة ليست مكتملة بعد (حالتها: ${t.status})`);
      continue;
    }
    const u = parseTaskUrls(t);
    if (!u.length) {
      details.push(`- ${tid}: المهمة مكتملة لكن دون روابط نتيجة`);
      continue;
    }
    urls.push(u[0]);
  }
  return { urls, details };
}

/**
 * تدفق runMerge وقواعده (قسم 7.3):
 * 1. تحقق صارم: ≥2 رابط وكلها http/https مباشرة وعامة؛ >10 → رفض.
 * 2. سجل مهمة type=merge provider=merger model=video-merger في Turso أولًا.
 * 3. POST /api/jobs ثم أطلق /process خلفيًا وبمرة واحدة فقط (قفل الذاكرة + طابع زمني).
 * 4. استعلم GET /api/jobs/{id} كل 3 ثوانٍ مع بث تقدم وكتابة كل تحديث في Turso فورًا.
 * 5. خطأ HTTP معلن = فشل نهائي فوري؛ أخطاء شبكتنا = مؤقتة وتستمر حتى النافذة.
 */
export async function runMerge(input: RunMergeInput): Promise<MergeOutcome> {
  const waitSeconds = Math.max(0, Math.min(WAIT_CAP_SECONDS, input.wait_seconds ?? 60));

  // 1) حلل المصادر: روابط task_ids أُولًا ثم urls المباشرة بنفس ترتيبها
  const { urls: fromTasks, details } = await resolveTaskIds(input.task_ids ?? []);
  const directUrls = (input.urls ?? []).map((u) => u.trim()).filter(Boolean);

  const allUrls: string[] = [];
  for (const u of [...fromTasks, ...directUrls]) {
    if (!validatePublicVideoUrl(u)) {
      details.push(`- ${u}: الرابط ليس رابط فيديو مباشرًا عامًا (http/https)`);
      continue;
    }
    allUrls.push(u);
  }

  if (allUrls.length < 2) {
    return {
      kind: "validation_failed",
      message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
      details,
    };
  }
  if (allUrls.length > MERGE_LIMIT_MAX) {
    return {
      kind: "validation_failed",
      message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
      details,
    };
  }

  if (!mergerConfigured()) {
    return {
      kind: "service_unconfigured",
      message: "❌ خدمة الدمج غير مضبوطة على السيرفر: يجب ضبط متغير البيئة MERGER_API_BASE بعنوان خدمة الدمج.",
      details,
    };
  }

  // 2) سجّل المهمة في Turso أولًا (قبل أي نداء خارجي)
  const taskId = randomUUID();
  const params = { urls: allUrls, task_ids: input.task_ids ?? [], wait_seconds: waitSeconds };
  await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${allUrls.length} مقاطع بالترتيب المحدد`,
    params_json: JSON.stringify(params),
    status: "pending",
    progress: 0,
  });

  // 3) POST /api/jobs — خطأ معلن = نهائي، خطأ شبكة = processing وتُعاد مع get_task
  let jobId: string;
  try {
    const res = await mergerFetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: allUrls }),
    });
    const body = await readJson(res);
    if (!res.ok) {
      const msg = `فشل إنشاء مهمة الدمج في الخدمة: ${String(body.error ?? body.raw ?? `HTTP ${res.status}`)}`;
      const task = await updateTask(taskId, { status: "failed", error_message: scrubSecrets(msg) });
      return { kind: "failed", task: task!, message: msg };
    }
    jobId = String(body.jobId ?? body.id ?? "");
    if (!jobId) {
      const msg = "استجابة /api/jobs من خدمة الدمج بدون jobId";
      const task = await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", task: task!, message: msg };
    }
  } catch (e) {
    // خطأ شبكتنا — تبقى processing وتُعاد المحاولة مع get_task بعد التهدئة
    const msg = e instanceof MergerNetworkError ? "تعذر الوصول لخدمة الدمج — ستُعاد المحاولة تلقائيًا مع get_task" : String(e);
    const task = await updateTask(taskId, { status: "processing", error_message: msg });
    return { kind: "processing", task: task! };
  }

  const task = await updateTask(taskId, {
    provider: "merger",
    provider_task_id: jobId,
    status: "processing",
    progress: 5,
    error_message: null,
    params_json: JSON.stringify({ ...params, processKickedAt: null }),
  });

  // إطلاق process خلفيًا وبمرة واحدة (خارج حلقة الاستعلام) — ننتظرها داخل الحلقة أدناه
  const processPromise = kickProcess(jobId).then((r) => {
    // نسجّل طابع الإطلاق في params_json للتنسيق عبر نسخ العمل المتعددة
    void updateTask(taskId, {
      params_json: JSON.stringify({ ...params, processKickedAt: new Date().toISOString() }),
    });
    return r;
  });

  // 4) نافذة الانتظار: استعلم كل 3 ثوانٍ مع بث التقدم
  const deadline = Date.now() + waitSeconds * 1000;
  let processResult: { terminal?: string; network?: boolean } | null = null;

  while (Date.now() < deadline) {
    const settled = await Promise.race([
      processPromise.then((r) => ({ r })),
      new Promise<{ r: null }>((resolve) => setTimeout(() => resolve({ r: null }), 3000)),
    ]);
    if (settled.r) {
      processResult = settled.r;
      if (processResult.terminal) {
        // خطأ HTTP معلن أثناء المعالجة = فشل نهائي فوري
        const msg = `فشل الدمج نهائيًا: ${scrubSecrets(processResult.terminal)}`;
        const t = await updateTask(taskId, { status: "failed", error_message: msg, progress: 0 });
        return { kind: "failed", task: t!, message: msg };
      }
    }

    try {
      const res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (res.status === 404) {
        const msg = "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
        const t = await updateTask(taskId, { status: "failed", error_message: msg });
        return { kind: "failed", task: t!, message: msg };
      }
      if (!res.ok) {
        const body = await readJson(res);
        // خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
        const msg = `فشل نهائي من خدمة الدمج (HTTP ${res.status}): ${String(body.error ?? body.raw ?? "")}`;
        const t = await updateTask(taskId, { status: "failed", error_message: scrubSecrets(msg) });
        return { kind: "failed", task: t!, message: msg };
      }
      const state = parseMergeStatus(await readJson(res));
      if (state.status === "done") {
        const url = resultUrl(state, jobId);
        const t = await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([url]), error_message: null });
        safeEmit(input.progressCb, { progress: 100, total: 100, message: "اكتمل دمج المقاطع — 100%" });
        return { kind: "completed", task: t! };
      }
      if (state.status === "failed") {
        const msg = `فشل الدمج نهائيًا: ${scrubSecrets(state.error ?? "خطأ من خدمة الدمج")}`;
        const t = await updateTask(taskId, { status: "failed", error_message: msg, progress: 0 });
        return { kind: "failed", task: t!, message: msg };
      }
      // queued/processing — اكتب الحالة في Turso فورًا كل مرة
      const p = Math.max(5, Math.min(99, state.progress || 10));
      await updateTask(taskId, { status: "processing", progress: p });
      safeEmit(input.progressCb, { progress: p, total: 100, message: `قيد دمج المقاطع… ${p}%` });
    } catch {
      // خطأ شبكتنا نحن = مؤقت → استمر بالاستعلام حتى انتهاء النافذة
    }
  }

  const finalTask = await getTask(taskId);
  return { kind: "processing", task: finalTask! };
}

/**
 * تحديث مهمة دمج من الخدمة — يُستدعى من get_task (قسم 7.3.6):
 * إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن؛ و404 → فشل نهائي بالرسالة المحددة.
 */
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  const params = safeParams(task.params_json);
  const jobId = task.provider_task_id;

  // حالة 1: لم يُنشأ job بعد (فشل شبكة عند الإنشاء) → أعد المحاولة مع تهدئة بسيطة
  if (!jobId) {
    const lastUpdate = Date.parse(task.updated_at.endsWith("Z") ? task.updated_at : `${task.updated_at}Z`).valueOf();
    if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < 45_000) return task;
    const urls = params.urls ?? [];
    if (urls.length < 2) return task;
    try {
      const res = await mergerFetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: urls }),
      });
      const body = await readJson(res);
      if (!res.ok) {
        const msg = `فشل نهائي من خدمة الدمج (HTTP ${res.status}): ${String(body.error ?? body.raw ?? "")}`;
        return (await updateTask(task.id, { status: "failed", error_message: scrubSecrets(msg) })) ?? task;
      }
      const newJobId = String(body.jobId ?? body.id ?? "");
      if (!newJobId) return task;
      await updateTask(task.id, { provider: "merger", provider_task_id: newJobId, status: "processing", progress: 5 });
      void kickProcess(newJobId);
      return (await getTask(task.id)) ?? task;
    } catch {
      return task; // شبكة — انتظر الاستدعاء التالي
    }
  }

  // حالة 2: لدينا jobId → استعلم الحالة
  try {
    const res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (res.status === 404) {
      const msg = "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
      return (await updateTask(task.id, { status: "failed", error_message: msg })) ?? task;
    }
    if (!res.ok) {
      const body = await readJson(res);
      const msg = `فشل نهائي من خدمة الدمج (HTTP ${res.status}): ${String(body.error ?? body.raw ?? "")}`;
      return (await updateTask(task.id, { status: "failed", error_message: scrubSecrets(msg) })) ?? task;
    }
    const state = parseMergeStatus(await readJson(res));

    if (state.status === "done") {
      return (
        (await updateTask(task.id, {
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify([resultUrl(state, jobId)]),
          error_message: null,
        })) ?? task
      );
    }
    if (state.status === "failed") {
      const msg = `فشل الدمج نهائيًا: ${scrubSecrets(state.error ?? "خطأ من خدمة الدمج")}`;
      return (await updateTask(task.id, { status: "failed", error_message: msg, progress: 0 })) ?? task;
    }

    // queued/processing: إن لم يُنفَّذ process بعد فنفّذه الآن (مع حماية التزامن)
    const kickedAt = params.processKickedAt ? Date.parse(params.processKickedAt) : 0;
    const needsKick = !kickedAt || (Date.now() - kickedAt > PROCESS_REKICK_AFTER_MS && state.progress < 5);
    if (needsKick && !processInFlight.has(jobId)) {
      await updateTask(task.id, {
        params_json: JSON.stringify({ ...params, processKickedAt: new Date().toISOString() }),
      });
      void kickProcess(jobId);
    }

    const p = Math.max(5, Math.min(99, state.progress || task.progress || 10));
    return (await updateTask(task.id, { status: "processing", progress: p })) ?? task;
  } catch {
    return task; // خطأ شبكتنا = مؤقت — نُبقي المهمة جارية ويُعاد الاستعلام
  }
}

function safeParams(json: string): { urls?: string[]; processKickedAt?: string } {
  try {
    const o = JSON.parse(json || "{}") as Record<string, unknown>;
    return {
      urls: Array.isArray(o.urls) ? (o.urls as string[]) : undefined,
      processKickedAt: typeof o.processKickedAt === "string" ? o.processKickedAt : undefined,
    };
  } catch {
    return {};
  }
}

/** حذف مهمة دمج من خدمة الدمج (تنظيف اختياري بعد الاختبار) */
export async function deleteMergeJob(jobId: string): Promise<boolean> {
  try {
    const res = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}
