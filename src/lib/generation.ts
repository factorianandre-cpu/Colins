/**
 * منسّق التوليد (runGeneration / refreshTask) — قلب سياسة «لا توقف أبدًا»:
 *
 * 1. المفاتيح تُجرَّب بترتيب تسلسلي صارم حسب الإضافة (getKeyPool: created_at ASC, id ASC).
 * 2. عند إنشاء المهمة تُسجَّل في Turso «قبل» أي نداء خارجي فتبقى قابلة للتتبع.
 * 3. كل محاولة (نجاح/فشل + الفئة) تُسجَّل في attempts_json وعدّادات المفتاح تتحدث دائمًا.
 * 4. فشل منتصف المهمة بسبب مفتاح/رصيد → إعادة إنشاء «نفس المهمة بنفس task_id» على المفتاح التالي
 *    — العميل يرى «قيد المعالجة» فقط ولا يعلم بأي تبديل.
 * 5. فشل الإنشاء على كل المفاتيح → المهمة تبقى processing برسالة داخلية
 *    «بانتظار توفر مفتاح صالح…» وتُعاد المحاولة مع كل get_task بعد تهدئة ~45 ثانية.
 * 6. الأخطاء التي تخرج للعميل (نموذج الذكاء الاصطناعي) لا تتضمن مطلقًا ذكر مفاتيح أو رصيد.
 */
import { randomUUID } from "node:crypto";
import {
  getKeyPool,
  getTask,
  insertTask,
  updateTask,
  bumpKeyCounters,
  updateKey,
  parseTaskUrls,
  type Attempt,
  type KeyRow,
  type TaskRow,
} from "@/lib/turso";
import { classifyProviderError, type ErrorClass } from "@/lib/classify";
import { scrubSecrets } from "@/lib/mask";
import { getAdapter, toProviderKey, ProviderError, type ProviderKey } from "@/lib/providers";
import { resolveModel, DEFAULT_MODEL_BY_TYPE, MERGE_MODEL, type ModelDef, type MediaType } from "@/lib/models";

/** نمط رسائل «فشل بسبب مفتاح/رصيد» التي يعلنها المزود في منتصف المهمة (قسم 4.3.2) */
const KEY_FAIL_RE = /insufficient|balance|credit|quota|充值|余额不足|\b402\b|\b401\b|unauthorized/i;

/** التهدئة بين محاولات إعادة الإنشاء عند بانتظار مفاتيح — حتى لا نضغط المزودين */
export const RETRY_COOLDOWN_MS = 45_000;

/** سقف نافذة الانتظار داخل نفس الطلب: على Vercel نقصّه لحماية مهلة دوال serverless (maxDuration=60)؛
 *  خارج Vercel نحترم wait_seconds كما هو حتى 240 — والمتابعة تبقى ممكنة دائمًا عبر get_task. */
const WAIT_CAP_SECONDS = process.env.VERCEL ? 40 : 240;

export interface ProgressMessage {
  progress: number;
  total: number;
  message: string;
}
// دائمًا Promise — يسمح باستدعاء .catch آمنًا في كل مواضع البث
export type ProgressCb = (p: ProgressMessage) => Promise<void>;

/** يجعل استدعاء بث التقدم آمنًا: لا يفشل أبدًا ولا يكسر المهمة */
function safeEmit(cb: ProgressCb | undefined, p: ProgressMessage): void {
  if (!cb) return;
  void Promise.resolve()
    .then(() => cb(p))
    .catch(() => {});
}

export interface GenerationArgs {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
}

export type Outcome =
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow }
  | { kind: "failed"; task: TaskRow; message: string } // فشل حقيقي (معطيات/سياسة) — يُسمح بعرضه
  | { kind: "no_keys"; model: string } // لا مفاتيح مطلقًا
  | { kind: "bad_model"; message: string }; // موديل غير معروف — خطأ معطيات فوري

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** استخراج صف المهمة من أي نتيجة منها — للمسارات التي قد تعيد no_keys/bad_model */
function taskOf(outcome: Outcome): TaskRow | null {
  return "task" in outcome ? outcome.task : null;
}

/** بناء إدخال المزود من معطيات الأداة الموحدة + اسم الموديل الخاص بالمزود */
function buildProviderInput(
  type: MediaType,
  args: GenerationArgs,
  providerModel: string
): Record<string, unknown> {
  // __providerModel تُستهلك فقط في محوّل CometAPI المتزامن
  const input: Record<string, unknown> = { prompt: args.prompt, __providerModel: providerModel };
  if (args.aspect_ratio) input.aspect_ratio = args.aspect_ratio;
  if (type === "image") {
    if (args.resolution) input.resolution = args.resolution;
    if (args.background) input.background = args.background;
    if (args.output_format) input.output_format = args.output_format;
  } else {
    if (args.resolution) input.resolution = args.resolution;
    if (typeof args.duration === "number") input.duration = args.duration;
    if (args.image_url) input.image_url = args.image_url;
    // الصوت الأصلي مفعّل دائمًا لدى grok-imagine — نمرر المعطى إن جاء صريحًا
    if (typeof args.enable_audio === "boolean") input.enable_audio = args.enable_audio;
  }
  return input;
}

/** تسجيل محاولة في attempts_json وتحديث عدّادات المفتاح — تُستدعى في كل نداء خارجي */
async function logAttempt(
  taskId: string,
  key: ProviderKey | null,
  ok: boolean,
  errorClass: ErrorClass | undefined,
  error: string | undefined,
  knownKeys: string[]
): Promise<void> {
  const attempt: Attempt = {
    provider: key?.provider ?? "unknown",
    keyId: key?.id,
    keyLabel: key?.label || undefined,
    ok,
    errorClass,
    error: error ? scrubSecrets(String(error).slice(0, 300), knownKeys) : undefined,
    at: new Date().toISOString(),
  };
  await updateTask(taskId, {}, [attempt]);
  if (key) await bumpKeyCounters(key.id, ok, attempt.error);
}

/** تعليم المفتاح بعد التصنيف: disabled أو exhausted (يبقى في القاعدة وإن كان مستنزفًا) */
async function markKeyByClass(key: ProviderKey, cls: ErrorClass, error: string, knownKeys: string[]): Promise<void> {
  if (cls === "disabled") {
    await updateKey(key.id, { status: "disabled", last_error: scrubSecrets(error, knownKeys) });
  } else if (cls === "exhausted") {
    // exhausted يبقى في القاعدة ولا يُستبعد — الاستثناء الوحيد للتجربة التسلسلية هو disabled
    await updateKey(key.id, { status: "exhausted", last_error: scrubSecrets(error, knownKeys) });
  }
}

interface DriveContext {
  taskId: string;
  model: ModelDef;
  type: MediaType;
  args: GenerationArgs;
  pool: KeyRow[];
  startIndex: number;
  waitSeconds: number;
  deadlineAt: number; // طابع زمني مطلق لنهاية نافذة الانتظار (يدعم الاستئناف بنفس النافذة المتبقية)
  progressCb?: ProgressCb;
  knownKeys: string[];
}

/**
 * حلقة الإنشاء + المتابعة داخل نافذة الانتظار.
 * تُستدعى من runGeneration (نافذة كاملة) ومن refreshTask (بدون نافذة أو بنافذة متبقية).
 */
async function driveTask(ctx: DriveContext): Promise<Outcome> {
  const { taskId, model, type, args, pool, knownKeys } = ctx;
  let idx = ctx.startIndex;

  // ---------- مرحلة الإنشاء: جرّب المرشحين بالترتيب حتى أول نجاح ----------
  let active: { key: ProviderKey; provider: string; pti: string } | null = null;
  const classesSeen: ErrorClass[] = [];

  while (idx < pool.length && !active) {
    const row = pool[idx];
    const key = toProviderKey(row);
    const adapter = getAdapter(key.provider);
    const providerModel = model.providerModel[key.provider as keyof typeof model.providerModel] ?? model.canonical;
    const input = buildProviderInput(type, args, providerModel);

    try {
      // صور متزامنة إن دعمها المزود (CometAPI تعيد الروابط فورًا)
      if (type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key, input);
        await logAttempt(taskId, key, true, undefined, undefined, knownKeys);
        const task = await updateTask(taskId, {
          provider: key.provider,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(urls),
          error_message: null,
        });
        return { kind: "completed", task: task! };
      }

      const { providerTaskId } = await adapter.createTask(key, providerModel, input);
      active = { key, provider: key.provider, pti: providerTaskId };
      await logAttempt(taskId, key, true, undefined, undefined, knownKeys);
      await updateTask(taskId, {
        provider: key.provider,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 5,
        error_message: null,
      });
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(undefined, e instanceof Error ? e.message : String(e));
      const cls = classifyProviderError(pe.status, pe.message);
      classesSeen.push(cls);
      await logAttempt(taskId, key, false, cls, pe.message, knownKeys);
      if (cls === "disabled" || cls === "exhausted") {
        await markKeyByClass(key, cls, pe.message, knownKeys);
      }
      if (cls === "params") {
        // توقف فوري — تبديل المفاتيح لن يحل خطأ معطيات (وهذا ليس خطأ مفتاح/رصيد فنعرضه)
        const msg = `معطيات غير مقبولة من المزود: ${scrubSecrets(pe.message, knownKeys)}`;
        const task = await updateTask(taskId, { status: "failed", error_message: msg, progress: 0 });
        return { kind: "failed", task: task!, message: msg };
      }
      // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي
      idx++;
    }
  }

  if (!active) {
    // ---------- فشل كل المرشحين ----------
    if (classesSeen.length > 0 && classesSeen.every((c) => c === "provider")) {
      // فشل حتمي: الموديل غير مدعوم لدى أي مزود متاح — إعادة المحاولة لن تغير شيئًا
      // (هذا ليس خطأ مفتاح/رصيد فنعرضه للعميل بصراحة)
      const msg = "الموديل غير مدعوم لدى المزودين المتاحين حاليًا";
      const task = await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", task: task!, message: msg };
    }
    // بانتظار توفر مفتاح صالح: تبقى processing (وليست failed) وتُعاد مع كل get_task بعد تهدئة
    const task = await updateTask(taskId, {
      provider: null,
      provider_task_id: null,
      key_id: null,
      status: "processing",
      progress: 0,
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    return { kind: "processing", task: task! };
  }

  // ---------- مرحلة المتابعة داخل نافذة الانتظار ----------
  const adapter = getAdapter(active.provider);
  const deadline = ctx.deadlineAt;
  const label = type === "image" ? "توليد الصورة" : "توليد الفيديو";

  // نبث تقدمًا أوليًا فورًا ثم كل ~3 ثوانٍ مع كل استعلام
  safeEmit(ctx.progressCb, { progress: 5, total: 100, message: `قيد ${label}… 5%` });

  while (Date.now() < deadline) {
    await sleep(3000);
    let check;
    try {
      await updateKey(active.key.id, { last_checked_at: new Date().toISOString() });
      check = await adapter.checkTask(active.key, active.pti);
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(undefined, e instanceof Error ? e.message : String(e));
      const cls = classifyProviderError(pe.status, pe.message);
      await logAttempt(taskId, active.key, false, cls, pe.message, knownKeys);
      if (cls === "disabled" || cls === "exhausted") {
        // المفتاح تعطّل/استنزف في منتصف المهمة → علّمه واستأنف «نفس المهمة بنفس task_id» على التالي
        await markKeyByClass(active.key, cls, pe.message, knownKeys);
        return driveTask({
          ...ctx,
          startIndex: idx + 1,
          waitSeconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
        });
      }
      if (cls === "params") {
        const msg = `معطيات غير مقبولة من المزود: ${scrubSecrets(pe.message, knownKeys)}`;
        const task = await updateTask(taskId, { status: "failed", error_message: msg });
        return { kind: "failed", task: task!, message: msg };
      }
      // temporary / provider أثناء المتابعة → نستمر بالاستعلام على نفس المهمة دون تبديل
      continue;
    }

    if (check.status === "completed") {
      const task = await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify(check.urls ?? []),
        error_message: null,
      });
      safeEmit(ctx.progressCb, { progress: 100, total: 100, message: `اكتمل ${label} — 100%` });
      return { kind: "completed", task: task! };
    }

    if (check.status === "failed") {
      const err = check.error ?? "فشل غير معروف";
      if (KEY_FAIL_RE.test(err)) {
        // المزود أعلن فشل المهمة بسبب مفتاح/رصيد → تصنيف، تعليم، وإعادة إنشاء بنفس task_id
        const cls = classifyProviderError(undefined, err);
        await logAttempt(taskId, active.key, false, cls, err, knownKeys);
        await markKeyByClass(active.key, cls, err, knownKeys);
        return driveTask({
          ...ctx,
          startIndex: idx + 1,
          waitSeconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
        });
      }
      // فشل حقيقي (انتهاك سياسة/معطيات من طرف المزود) — نعرضه دون أي ذكر مفاتيح
      const msg = scrubSecrets(err, knownKeys);
      const task = await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed", task: task!, message: msg };
    }

    // قيد المعالجة: نكتب التقدم في Turso فورًا ونبث الإشعار
    const p = Math.max(5, Math.min(99, Math.round(check.progress ?? 10)));
    await updateTask(taskId, { status: "processing", progress: p });
    safeEmit(ctx.progressCb, { progress: p, total: 100, message: `قيد ${label}… ${p}%` });
  }

  // انتهت النافذة والنتيجة لم تظهر → processing والعميل يتابع بـ get_task
  const task = await getTask(taskId);
  return { kind: "processing", task: task! };
}

export interface RunGenerationInput {
  type: Exclude<MediaType, "merge">;
  args: GenerationArgs;
  progressCb?: ProgressCb;
}

/** التدفق الكامل لأداة generate_image / generate_video (قسم 6 من المواصفة) */
export async function runGeneration(input: RunGenerationInput): Promise<Outcome> {
  const { type, args, progressCb } = input;

  // 1) توحيد اسم الموديل — غير معروف → خطأ معطيات فوري
  const model = resolveModel(args.model ?? DEFAULT_MODEL_BY_TYPE[type]);
  if (!model || model.type !== type) {
    const available = type === "image" ? DEFAULT_MODEL_BY_TYPE.image : DEFAULT_MODEL_BY_TYPE.video;
    return {
      kind: "bad_model",
      message: `❌ موديل غير معروف: ${args.model ?? "—"}. المتاح لهذا النوع: ${available}`,
    };
  }

  // 2) تجمع المفاتيح بالترتيب التسلسلي — فارغ → رد no_keys
  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) {
    return { kind: "no_keys", model: model.canonical };
  }

  // 3) سجل المهمة في Turso قبل أي نداء خارجي
  const taskId = randomUUID();
  const waitSeconds = Math.max(0, Math.min(WAIT_CAP_SECONDS, args.wait_seconds ?? (type === "image" ? 90 : 25)));
  await insertTask({
    id: taskId,
    model: model.canonical,
    type,
    prompt: args.prompt ?? "",
    params_json: JSON.stringify(args),
    status: "pending",
    progress: 0,
  });

  // 4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء ثم تابع داخل نافذة الانتظار
  return driveTask({
    taskId,
    model,
    type,
    args,
    pool,
    startIndex: 0,
    waitSeconds,
    deadlineAt: Date.now() + waitSeconds * 1000,
    progressCb,
    knownKeys: pool.map((k) => k.api_key),
  });
}

/**
 * إعادة إنشاء مهمة موجودة (نفس task_id) — تُستدعى من refreshTask:
 * إما أن المهمة بانتظار مفتاح، أو أن مفتاحها الحالي لم يعد في التجمع.
 * بدون نافذة انتظار (0 ثانية) — العميل يتابع بـ get_task.
 */
async function recreateTask(task: TaskRow, model: ModelDef, args: GenerationArgs, pool: KeyRow[]): Promise<Outcome> {
  return driveTask({
    taskId: task.id,
    model,
    type: task.type as Exclude<MediaType, "merge">,
    args,
    pool,
    startIndex: 0,
    waitSeconds: 0,
    deadlineAt: Date.now(), // لا نافذة — إنشاء فقط ثم فحص واحد في حالة الصور المتزامنة
    knownKeys: pool.map((k) => k.api_key),
  });
}

/**
 * تحديث مهمة حية من المزود — يُستدعى من أداة get_task مع كل استدعاء (قسم 6):
 * نفس منطق التصنيف/التبديل أعلاه، مع تهدئة 45 ثانية للمهام البانتظار.
 */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (task.type === "merge") {
    // مهام الدمج تُدار في merger.ts — استدعاء ديناميكي لتفادي دورة استيراد
    const { refreshMergeTask } = await import("@/lib/merger");
    return refreshMergeTask(task);
  }

  const model = resolveModel(task.model) ?? ({
    canonical: task.model,
    aliases: [task.model],
    type: task.type as MediaType,
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_IMAGE_MODEL || process.env.KIE_VIDEO_MODEL || task.model,
      cometapi: process.env.COMETAPI_IMAGE_MODEL || process.env.COMETAPI_VIDEO_MODEL || task.model,
    },
  } as ModelDef);

  const args = safeParseArgs(task.params_json);
  const pool = await getKeyPool(model.providers);
  const knownKeys = pool.map((k) => k.api_key);
  const adapter = task.provider ? getAdapter(task.provider) : null;

  // حالة 1: مهمة جارية مرتبطة بمزود ومفتاح
  if (adapter && task.provider_task_id && task.key_id) {
    const keyRow = pool.find((k) => k.id === task.key_id);
    if (keyRow) {
      const key = toProviderKey(keyRow);
      try {
        await updateKey(key.id, { last_checked_at: new Date().toISOString() });
        const check = await adapter.checkTask(key, task.provider_task_id);

        if (check.status === "completed") {
          return await updateTask(task.id, {
            status: "completed",
            progress: 100,
            result_urls_json: JSON.stringify(check.urls ?? []),
            error_message: null,
          });
        }
        if (check.status === "failed") {
          const err = check.error ?? "فشل غير معروف";
          if (KEY_FAIL_RE.test(err)) {
            // فشل بسبب مفتاح/رصيد → علّم وأعد الإنشاء بنفس task_id على المفتاح التالي
            const cls = classifyProviderError(undefined, err);
            await updateTask(task.id, {}, [
              { provider: key.provider, keyId: key.id, ok: false, errorClass: cls, error: scrubSecrets(err, knownKeys), at: new Date().toISOString() },
            ]);
            await markKeyByClass(key, cls, err, knownKeys);
            await bumpKeyCounters(key.id, false, err);
            return (await taskOf(await recreateTask(task, model, args, pool))) ?? task;
          }
          const msg = scrubSecrets(err, knownKeys);
          return await updateTask(task.id, { status: "failed", error_message: msg });
        }
        // processing — حدّث التقدم حيًا
        const p = Math.max(5, Math.min(99, Math.round(check.progress ?? task.progress)));
        return await updateTask(task.id, { status: "processing", progress: p });
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError(undefined, e instanceof Error ? e.message : String(e));
        const cls = classifyProviderError(pe.status, pe.message);
        if (cls === "disabled" || cls === "exhausted") {
          await markKeyByClass(key, cls, pe.message, knownKeys);
          await bumpKeyCounters(key.id, false, pe.message);
          await updateTask(task.id, {}, [
            { provider: key.provider, keyId: key.id, ok: false, errorClass: cls, error: scrubSecrets(pe.message, knownKeys), at: new Date().toISOString() },
          ]);
          // استئناف نفس المهمة على المفتاح التالي — العميل لا يرى شيئًا
          return (await taskOf(await recreateTask(task, model, args, pool))) ?? task;
        }
        // temporary — نُبقي المهمة كما هي ويُعاد الاستعلام لاحقًا
        return task;
      }
    }
    // المفتاح المخزّن لم يعد في التجمع (عُطّل يدويًا مثلاً) → أعد الإنشاء
    return (await taskOf(await recreateTask(task, model, args, pool))) ?? task;
  }

  // حالة 2: بانتظار مفتاح صالح (فشل الإنشاء على كل المفاتيح سابقًا)
  // التهدئة ~45 ثانية منذ آخر كتابة على المهمة حتى لا نضغط المزودين
  const lastUpdate = Date.parse(task.updated_at.endsWith("Z") ? task.updated_at : `${task.updated_at}Z`).valueOf();
  if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < RETRY_COOLDOWN_MS) {
    return task;
  }
  // تُعاد المحاولة تلقائيًا: لو شحن المستخدم رصيد أي مفتاح تكتمل المهمة من تلقاء نفسها
  const outcome = await recreateTask(task, model, args, pool);
  const updated = taskOf(outcome);
  if (outcome.kind === "processing" && updated?.error_message === "بانتظار توفر مفتاح صالح…") {
    // ما زلنا بانتظار مفاتيح — نحدّث طابع آخر محاولة عبر كتابة attempt خفيفة
    await updateTask(task.id, {}, [
      { provider: "none", ok: false, errorClass: "temporary", error: "لا مفاتيح متاحة — أُعيدت المحاولة", at: new Date().toISOString() },
    ]);
    return (await getTask(task.id)) ?? updated ?? task;
  }
  return updated ?? task;
}

function safeParseArgs(json: string): GenerationArgs {
  try {
    const o = JSON.parse(json || "{}") as Record<string, unknown>;
    return {
      prompt: String(o.prompt ?? ""),
      model: o.model ? String(o.model) : undefined,
      aspect_ratio: o.aspect_ratio ? String(o.aspect_ratio) : undefined,
      resolution: o.resolution ? String(o.resolution) : undefined,
      background: o.background ? String(o.background) : undefined,
      output_format: o.output_format ? String(o.output_format) : undefined,
      image_url: o.image_url ? String(o.image_url) : undefined,
      enable_audio: typeof o.enable_audio === "boolean" ? o.enable_audio : undefined,
      duration: typeof o.duration === "number" ? o.duration : undefined,
      wait_seconds: typeof o.wait_seconds === "number" ? o.wait_seconds : undefined,
    };
  } catch {
    return { prompt: "" };
  }
}

/** موضع آمن للمرجع الدائري: أداة الدمج تستورد من هنا أحيانًا */
export { MERGE_MODEL };
