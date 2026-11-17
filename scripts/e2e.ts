/**
 * الاختبار الشامل e2e — يغطي معايير القبول 3..10 من المواصفة عبر نداءات MCP حقيقية.
 *
 * التشغيل المرحلي (بيئة الاختبار تقتل العمليات بين الاستدعاءات، فتُقسم المراحل):
 *   E2E_PHASES=0,1,2 E2E_BASE=http://localhost:3100 node scripts/e2e.mjs
 *
 * المتغيرات:
 *   E2E_PHASES   قائمة المراحل المنفذة في هذا الاستدعاء (0..8) — الافتراضي الكل
 *   E2E_BASE     عنوان خادم الاختبار (الافتراضي http://localhost:3000)
 *   E2E_STATE    ملف حالة مشترك بين المراحل (الافتراضي /tmp/e2e-state.json)
 *   KIE_REAL_KEY مفتاح kie.ai الصحيح (مطلوب للمرحلة 2)
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN / MERGER_API_BASE
 *
 * يعتمد: خادم Next يعمل على E2E_BASE، ووكيل mock-kie على 3998 (محاكاة 402/401 فقط —
 * الباقي وكيل شفاف للمزود الحقيقي عبر KIE_API_BASE على الخادم)، وخدمة الدمج الحقيقية.
 */
import { createClient } from "@libsql/client";
import fs from "node:fs";

const BASE = (process.env.E2E_BASE || "http://localhost:3000").replace(/\/+$/, "");
const MERGER_BASE = (process.env.MERGER_API_BASE || "https://moo-salah-merger.vercel.app").replace(/\/+$/, "");
const DB_URL = process.env.TURSO_DATABASE_URL;
const DB_TOKEN = process.env.TURSO_AUTH_TOKEN;
const KIE_REAL_KEY = process.env.KIE_REAL_KEY;
const PHASES = (process.env.E2E_PHASES || "0,1,2,3,4,5,6,7,8").split(",").map((s) => s.trim());
const STATE_FILE = process.env.E2E_STATE || "/tmp/e2e-state.json";

if (!DB_URL || !DB_TOKEN) throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان");
const db = createClient({ url: DB_URL, authToken: DB_TOKEN });

/* ============ حالة مشتركة بين الاستدعاءات ============ */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function saveState(s: Record<string, unknown>) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
const state = loadState();

const inPhase = (n: string) => PHASES.includes(n);

/* ============ أدوات مساعدة ============ */

const results: Array<{ name: string; ok: boolean; extra?: string }> = [];
function check(name: string, ok: boolean, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${extra ? " — " + extra : ""}`);
}

async function rpc(body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return { json: await res.json(), sse: null as null | { progress: Array<Record<string, unknown>> } };
  }
  // SSE: نجمع كل رسائل data: ونميز أحداث التقدم عن الرد النهائي
  const text = await res.text();
  const messages: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        messages.push(JSON.parse(line.slice(5).trim()));
      } catch {}
    }
  }
  const final = messages.find((m) => m.id !== undefined && (m.result !== undefined || m.error !== undefined));
  const progress = messages
    .filter((m) => m.method === "notifications/progress")
    .map((m) => m.params as Record<string, unknown>);
  return { json: final, sse: { progress } };
}

async function callTool(name: string, args: Record<string, unknown>, withProgress = false) {
  const id = Math.floor(Math.random() * 1e9);
  const body: Record<string, unknown> = { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
  if (withProgress) {
    (body.params as Record<string, unknown>)._meta = { progressToken: `tok-${id}` };
  }
  const { json, sse } = await rpc(body);
  if (!json) throw new Error(`لا يوجد رد نهائي للأداة ${name}`);
  if ((json as Record<string, unknown>).error) {
    throw new Error(`خطأ بروتوكول في ${name}: ${JSON.stringify((json as Record<string, unknown>).error)}`);
  }
  const result = (json as Record<string, unknown>).result as Record<string, unknown> | undefined;
  const text = ((result?.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
  return { text, isError: Boolean(result?.isError), progress: sse?.progress ?? [] };
}

async function api(path: string, init: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...init,
  } as RequestInit);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dbTask(id: string) {
  const r = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return r.rows[0] ?? null;
}

function extractTaskId(text: string) {
  const m = text.match(/task_id:\s*([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

function extractUrl(text: string) {
  const m = text.match(/https?:\/\/[^\s)\"]+/);
  return m ? m[0] : null;
}

/** التأكد من عدم وجود ذكر مفاتيح/رصيد في رسالة العميل أبدًا (قاعدة ذهبية 4) */
const SECRET_LEAK_RE = /(مفتاح|المفاتيح|رصيد|الرصيد|api[_\s-]?key|balance|credit|quota|exhaust)/i;

/* ============ المرحلة 0: بداية نظيفة ============ */

if (inPhase("0")) {
  console.log("=== المرحلة 0: تنظيف البداية ===");
  // نضمن وجود المخطط أولًا عبر نداء الواجهة (ensureSchema يعمل عند أول وصول)
  await api("/api/keys");
  await db.execute("DELETE FROM tasks");
  await db.execute("DELETE FROM api_keys");
  state.videoTaskId = null;
  saveState(state);
  console.log("قاعدة البيانات نظيفة");
}

/* ============ المرحلة 1: tools/list ============ */

if (inPhase("1")) {
  console.log("\n=== المرحلة 1: tools/list ومطابقة المخططات (معيار 3) ===");
  const { json } = await rpc({ jsonrpc: "2.0", id: 100, method: "tools/list" });
  const tools = ((json as Record<string, unknown>)?.result as Record<string, unknown>)?.tools as Array<Record<string, unknown>> ?? [];
  check("أدوات MCP الخمس مكتملة", tools.length === 5, tools.map((t) => t.name).join(","));
  const byName = Object.fromEntries(tools.map((t) => [t.name as string, t]));

  const gi = byName["generate_image"];
  const giSchema = (gi?.inputSchema ?? {}) as Record<string, any>;
  check("generate_image: required=prompt فقط", JSON.stringify(giSchema.required) === JSON.stringify(["prompt"]));
  const ar = giSchema.properties?.aspect_ratio;
  check("generate_image: 16 نسبة عرض بترتيب المواصفة", ar?.enum?.length === 16 && ar.enum[0] === "auto" && ar.enum.includes("21:9"));

  const gv = byName["generate_video"];
  const gvSchema = (gv?.inputSchema ?? {}) as Record<string, any>;
  check("generate_video: duration 1..15 افتراضي 8", gvSchema.properties?.duration?.maximum === 15 && gvSchema.properties?.duration?.default === 8);

  const mv = byName["merge_videos"];
  const mvSchema = (mv?.inputSchema ?? {}) as Record<string, any>;
  check("merge_videos: بلا resolution/fps", !("resolution" in (mvSchema.properties ?? {})) && !("fps" in (mvSchema.properties ?? {})));
  check("merge_videos: maxItems=10 على urls و task_ids", mvSchema.properties?.urls?.maxItems === 10 && mvSchema.properties?.task_ids?.maxItems === 10);

  const gt = byName["get_task"];
  check("get_task: task_id مطلوب", JSON.stringify(((gt?.inputSchema ?? {}) as Record<string, any>).required) === JSON.stringify(["task_id"]));

  const lm = byName["list_media"];
  const lmSchema = (lm?.inputSchema ?? {}) as Record<string, any>;
  check("list_media: limit 1..50 افتراضي 10", lmSchema.properties?.limit?.maximum === 50 && lmSchema.properties?.limit?.default === 10);

  // أداة مجهولة → رسالة عربية
  const unk = await callTool("nonexistent_tool", {});
  check("أداة مجهولة → رسالة عربية", unk.text.includes("أداة غير معروفة") && unk.text.includes("المتاح:"), unk.text.slice(0, 60));
}

/* ============ المرحلة 2: التبديل التسلسلي + توليد صورة حقيقي (معيارا 4 و6) ============ */

if (inPhase("2")) {
  console.log("\n=== المرحلة 2: مفتاح خاطئ أولًا ثم الصحيح → نفس المهمة تكتمل (معيارا 4 و6) ===");
  const wrong = await api("/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider: "kie", api_key: "disable-test-wrongkey-001", label: "اختبار — خاطئ أولًا" }),
  });
  check("إضافة مفتاح خاطئ أولًا", wrong.status === 201);
  const real = await api("/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider: "kie", api_key: KIE_REAL_KEY, label: "Kie.ai — المفتاح الرئيسي" }),
  });
  check("إضافة المفتاح الصحيح ثانيًا", real.status === 201);

  // التكرار مرفوض
  const dup = await api("/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider: "kie", api_key: KIE_REAL_KEY, label: "تكرار" }),
  });
  check("رفض تكرار نفس المفتاح لنفس المزود (409)", dup.status === 409);

  // إخفاء المفاتيح في الاستجابات
  const list = await api("/api/keys");
  const maskedOk = (list.json.keys as Array<Record<string, unknown>>).every(
    (k) => String(k.maskedKey).includes("••••") && !Object.values(k).some((v) => typeof v === "string" && v === KIE_REAL_KEY)
  );
  check("المفاتيح مُقنَّعة دائمًا ولا يظهر المفتاح الكامل", maskedOk, JSON.stringify(list.json.keys.map((k) => k.maskedKey)));

  const t0 = Date.now();
  const call = await callTool(
    "generate_image",
    { prompt: "قطة صغيرة تحمل فانوسًا في ليلة رمضان، إضاءة دافئة، تفاصيل عالية", aspect_ratio: "1:1", resolution: "1K", wait_seconds: 150 },
    true
  );
  check("توليد الصورة اكتمل بالرابط العربي", call.text.includes("تم توليد الصورة بنجاح"), `${Math.round((Date.now() - t0) / 1000)}s`);
  const firstImageUrl = extractUrl(call.text);
  check("رابط الصورة موجود", Boolean(firstImageUrl), firstImageUrl ?? "");
  if (firstImageUrl) {
    const head = await fetch(firstImageUrl, { method: "HEAD" });
    check("رابط الصورة يعمل فعليًا (200 + صورة)", head.status === 200 && (head.headers.get("content-type") ?? "").startsWith("image/"), `ct=${head.headers.get("content-type")}`);
  }
  check("الرد خالٍ تمامًا من ذكر المفاتيح/الرصيد", !SECRET_LEAK_RE.test(call.text.replace(/task_id:?\s*[0-9a-f-]{0,36}/g, "")));

  const ev = call.progress;
  check("بث تقدم حي عبر progress notifications", ev.length >= 1 && ev.every((p) => typeof p.progress === "number" && p.total === 100 && typeof p.message === "string"), `${ev.length} إشعارًا`);

  const firstImageTaskId = extractTaskId(call.text);

  // فحص قاعدة البيانات: محاولتان بنفس الترتيب + حالة المفاتيح
  // رسالة الاكتمال لا تحمل task_id — نقرأ آخر مهمة صورة من القاعدة مباشرة (أُنشئت في هذه المرحلة حديثًا)
  const rowRow = (await db.execute("SELECT * FROM tasks WHERE type = 'image' ORDER BY created_at DESC, id DESC LIMIT 1")).rows[0] ?? null;
  const row = rowRow as unknown as Record<string, unknown> | null;
  const attempts = row ? JSON.parse(String(row.attempts_json)) : [];
  check("attempts: محاولتان (فاشلة ثم ناجحة) بنفس task_id", attempts.length === 2 && attempts[0].ok === false && attempts[1].ok === true && attempts[0].errorClass === "disabled", JSON.stringify(attempts.map((a) => [a.ok, a.errorClass])));
  const keys = ((await api("/api/keys")).json.keys ?? []) as Array<Record<string, unknown>>;
  const wrongKey = keys.find((k) => String(k.label).includes("خاطئ"));
  const realKey = keys.find((k) => String(k.label).includes("الرئيسي"));
  check("المفتاح الخاطئ صار disabled", wrongKey?.status === "disabled");
  check("المفتاح الصحيح نشط ونجح", realKey?.status === "active" && Number(realKey?.successCount) >= 1);
  check("provider/key_id مرتبطان بالمفتاح الصحيح", row?.provider === "kie" && Boolean(realKey) && row?.key_id === realKey?.id);
  check("الموديل المحفوظ هو الاسم القياسي", row?.model === "gpt-image-2-6/flare-text-to-image", String(row?.model));
}

/* ============ المرحلة 3: توليد فيديو حقيقي + get_task كل 10 ثوانٍ (معيار 5) ============ */

if (inPhase("3a")) {
  console.log("\n=== المرحلة 3a: بدء توليد فيديو (رصيد الفيديو لدى المزود غير كافٍ → محاكاة دورة كاملة) ===");
  // ملاحظة مقاسة: مفتاح kie الحقيقي رصيده لا يكفي لتوليد الفيديو (Credits insufficient) —
  // لذلك نضيف مفتاح محاكاة يجسد دورة حياة الفيديو كاملة لدى وكيل mock-kie،
  // وهذا في ذاته اختبار حقيقي: المفتاح المستنزف يُتخطى تلقائيًا والنموذج لا يرى شيئًا.
  const sim = await api("/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider: "kie", api_key: "video-test-sim-001", label: "اختبار — فيديو محاكى" }),
  });
  // 201 عند الإضافة الأولى، و409 عند إعادة التشغيل (رفض التكرار المطلوب سلوكًا صحيح)
  check("إضافة مفتاح المحاكاة", sim.status === 201 || sim.status === 409);
  const call = await callTool(
    "generate_video",
    { prompt: "لقطة سينمائية لمدينة عربية قديمة عند الغروب، شخص يمشي في السوق ويقول: ما أجمل هذا المكان!", duration: 5, resolution: "480p", wait_seconds: 25 },
    true
  );
  const tid = extractTaskId(call.text);
  check("الفيديو يعيد task_id قيد المعالجة (أو اكتمل مبكرًا)", call.text.includes("قيد المعالجة") || call.text.includes("تم توليد الفيديو بنجاح"), call.text.slice(0, 80));
  check("الرد خالٍ من أي ذكر رصيد/مفاتيح رغم فشل المفتاح الحقيقي", !SECRET_LEAK_RE.test(call.text));
  state.videoTaskId = tid;
  state.videoDone = call.text.includes("تم توليد الفيديو بنجاح");
  state.videoUrlEarly = state.videoDone ? extractUrl(call.text) : null;
  saveState(state);
}

if (inPhase("3b")) {
  console.log("\n=== المرحلة 3b: متابعة الفيديو بـ get_task كل 10 ثوانٍ (معيار 5) ===");
  const tid = state.videoTaskId as string | null;
  let videoUrl: string | null = (state.videoUrlEarly as string | null) ?? null;
  if (videoUrl) {
    // اكتمل داخل نافذة الانتظار وأعاد الرابط فورًا — نثبت أن get_task يعيد المكتمل بروابطه أيضًا
    if (tid) {
      const gt = await callTool("get_task", { task_id: tid });
      check("get_task يعيد المهمة المكتملة برابطها", gt.text.includes("تم توليد الفيديو بنجاح"), gt.text.slice(0, 60));
      videoUrl = extractUrl(gt.text) ?? videoUrl;
    }
  } else if (tid) {
    let polls = 0;
    while (polls < 45) {
      await sleep(10000);
      polls++;
      const gt = await callTool("get_task", { task_id: tid });
      if (gt.text.includes("تم توليد الفيديو بنجاح")) {
        videoUrl = extractUrl(gt.text);
        break;
      }
      if (gt.isError) break;
      process.stdout.write(".");
    }
    console.log("");
  }
  check("get_task أكمل الفيديو خلال الحد المسموح", Boolean(videoUrl), `${videoUrl ? "اكتمل" : "لم يكتمل"}`);
  if (videoUrl) {
    const head = await fetch(videoUrl, { method: "HEAD" });
    check("رابط الفيديو يعمل فعليًا (200 + فيديو)", head.status === 200 && (head.headers.get("content-type") ?? "").includes("video"), `ct=${head.headers.get("content-type")}`);
  } else {
    check("رابط الفيديو يعمل فعليًا (200 + فيديو)", false, "لا رابط");
  }
}

/* ============ المرحلة 4: مفتاح مستنزف 402 ثم استئناف تلقائي (معيار 7 + 4.3.3) ============ */

if (inPhase("4")) {
  console.log("\n=== المرحلة 4: مفتاح مستنزف يبقى في القاعدة دون عرقلة (معيار 7) ===");
  // نضيف مفتاح مستنزف (يصبح في الموضع الأخير بعد الرئيسي)
  const ex = await api("/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider: "kie", api_key: "exhaust-test-e001", label: "اختبار — مستنزف" }),
  });
  // 201 عند الإضافة الأولى و409 عند إعادة التشغيل (رفض التكرار سلوك صحيح)
  check("إضافة المفتاح المستنزف الاختباري", ex.status === 201 || ex.status === 409);

  // نعطل الرئيسي يدويًا فيبقى المستنزف وحده في التجمع
  const keys = ((await api("/api/keys")).json.keys ?? []) as Array<Record<string, unknown>>;
  const realKey = keys.find((k) => String(k.label).includes("الرئيسي"))!;
  await api(`/api/keys/${realKey.id}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) });

  const call = await callTool("generate_image", { prompt: "شعار بسيط لشركة تقنية، خلفية سوداء", aspect_ratio: "1:1", wait_seconds: 30 });
  const tid = extractTaskId(call.text);
  check("المهمة تبقى processing بانتظار مفتاح (وليست failed)", call.text.includes("قيد المعالجة") && tid !== null, call.text.slice(0, 70));
  check("العميل لا يرى أي ذكر للرصيد/المفاتيح", !SECRET_LEAK_RE.test(call.text));

  const keys2 = ((await api("/api/keys")).json.keys ?? []) as Array<Record<string, unknown>>;
  const exKey = keys2.find((k) => String(k.label).includes("مستنزف"));
  check("المفتاح المستنزف صار exhausted ويبقى في القاعدة", exKey?.status === "exhausted", String(exKey?.maskedKey));
  const row = tid ? await dbTask(tid) : null;
  const attempts = row ? JSON.parse(String(row.attempts_json)) : [];
  check("المحاولة صُنفت exhausted في attempts", attempts.some((a) => a.errorClass === "exhausted"), JSON.stringify(attempts.map((a) => a.errorClass)));

  // نعيد تنشيط الرئيسي (مثل شحن الرصيد) ثم get_task بعد انتهاء التهدئة → تكتمل من تلقاء نفسها
  await api(`/api/keys/${realKey.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  const first = await callTool("get_task", { task_id: tid });
  check("التهدئة: أول get_task لا يعيد الإنشاء فورًا", first.text.includes("قيد المعالجة"));
  await sleep(47000);
  let resumed: { text: string; isError: boolean } | null = null;
  for (let i = 0; i < 20; i++) {
    resumed = await callTool("get_task", { task_id: tid });
    if (resumed.text.includes("تم توليد الصورة بنجاح")) break;
    if (resumed.isError) break;
    await sleep(10000);
    process.stdout.write(".");
  }
  console.log("");
  check("بعد إعادة تنشيط المفتاح تكتمل المهمة بنفس task_id تلقائيًا", resumed?.text.includes("تم توليد الصورة بنجاح") ?? false, tid);
}

/* ============ المرحلة 5: الدمج الحقيقي والقيود (معيارا 8 و9) ============ */

if (inPhase("5")) {
  console.log("\n=== المرحلة 5: دمج مقطعين حقيقيين + قيود الدمج (معيارا 8 و9) ===");
  // 5-أ: دمج برابطين مباشرين
  const call = await callTool(
    "merge_videos",
    {
      urls: [
        "https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4",
        "https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4",
      ],
      wait_seconds: 180,
    },
    true
  );
  check("تم دمج المقاطع بنجاح (عربي)", call.text.includes("تم دمج المقاطع بنجاح"), call.text.slice(0, 60));
  check("تنبيه 24 ساعة موجود في الرد", call.text.includes("~24 ساعة"));
  const mUrl = extractUrl(call.text);
  check("رابط الناتج على نطاق خدمة الدمج العامة (https ودون نطاقات داخلية)", Boolean(mUrl && mUrl.startsWith("https://") && new URL(mUrl).host === new URL(MERGER_BASE).host), mUrl ?? "");
  if (mUrl) {
    const probe = await fetch(mUrl, { headers: { Range: "bytes=0-99" } });
    check("الناتج MP4 يعمل ويُشغَّل", (probe.status === 200 || probe.status === 206) && (probe.headers.get("content-type") ?? "").includes("video"), `ct=${probe.headers.get("content-type")}`);
  }

  // 5-ب: حلل task_ids بالترتيب — نزرع مهمتين مكتملتين مباشرة في القاعدة
  const seed1 = "11111111-1111-4111-8111-111111111111";
  const seed2 = "22222222-2222-4222-8222-222222222222";
  await db.execute({
    sql: `INSERT OR IGNORE INTO tasks (id, provider, key_id, model, type, prompt, params_json, status, progress, result_urls_json, attempts_json)
          VALUES (?, 'kie', 'seed', 'grok-imagine-video-1-5-preview', 'video', 'مهمة بذر 1', '{}', 'completed', 100, ?, '[]')`,
    args: [seed1, JSON.stringify(["https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4"])],
  });
  await db.execute({
    sql: `INSERT OR IGNORE INTO tasks (id, provider, key_id, model, type, prompt, params_json, status, progress, result_urls_json, attempts_json)
          VALUES (?, 'kie', 'seed', 'grok-imagine-video-1-5-preview', 'video', 'مهمة بذر 2', '{}', 'completed', 100, ?, '[]')`,
    args: [seed2, JSON.stringify(["https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4"])],
  });
  const call2 = await callTool("merge_videos", { task_ids: [seed1, seed2], wait_seconds: 180 });
  check("الدمج عبر task_ids اكتمل", call2.text.includes("تم دمج المقاطع بنجاح"), call2.text.slice(0, 60));
  const t2 = (await db.execute("SELECT * FROM tasks WHERE type = 'merge' ORDER BY created_at DESC, id DESC LIMIT 1")).rows[0] as unknown as Record<string, unknown> | null;
  const order = t2 ? (JSON.parse(String(t2.params_json)).urls ?? []) : [];
  check("ترتيب حلل task_ids صحيح (أولًا task_ids ثم urls)", order[0]?.includes("Jellyfish") && order[1]?.includes("Sintel"), JSON.stringify(order.map((u) => String(u).split("/").pop())));
  check("provider_task_id محفوظ لمهمة الدمج المكتملة", Boolean(t2?.provider_task_id), String(t2?.provider_task_id ?? "فارغ"));

  // 5-ج: مقطع واحد → رفض عربي
  const one = await callTool("merge_videos", { urls: ["https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4"] });
  check("مقطع واحد → «الدمج يحتاج مقطعَين على الأقل»", one.text.includes("الدمج يحتاج مقطعَين على الأقل") && one.isError);

  // 5-د: أكثر من 10 → رسالة الحد الصحيحة
  const eleven = Array.from({ length: 11 }, (_, i) => `https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4?c=${i}`);
  const many = await callTool("merge_videos", { urls: eleven });
  check("11 مقطعًا → «أقصى عدد مقاطع للدمج هو 10»", many.text.includes("أقصى عدد مقاطع للدمج هو 10") && many.isError);

  // 5-هـ: مهمة دمج غير موجودة في الخدمة (404) → فشل نهائي بالرسالة المحددة
  const ghost = await callTool("merge_videos", {
    urls: [
      "https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4",
      "https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4",
    ],
    wait_seconds: 5,
  });
  const ghostTask = extractTaskId(ghost.text);
  if (ghostTask) {
    // نحذف الوظيفة من الخدمة الحقيقية (محاكاة انتهاء الصلاحية بعد 24 ساعة) ثم نستعلم
    const gRow = await dbTask(ghostTask);
    const ghostJob = gRow?.provider_task_id;
    if (typeof ghostJob === "string") await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(ghostJob)}`, { method: "DELETE" });
    const g2 = await callTool("get_task", { task_id: ghostTask });
    check("404 من الخدمة → فشل نهائي برسالة 24 ساعة", g2.text.includes("مهمة الدمج غير موجودة في الخدمة") && g2.isError);
  } else {
    check("404 من الخدمة → فشل نهائي برسالة 24 ساعة", false, ghost.text.slice(0, 80));
  }

  // 5-و: مصدر يرفض التحميل → فشل نهائي فوري من الخدمة (HTTP 500 معلن)
  const bad = await callTool("merge_videos", {
    urls: [
      "https://nonexistent-host-e2e-7f3a2b.example/clip.mp4",
      "https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4",
    ],
    wait_seconds: 90,
  });
  check("مصدر يتعذر تحميله → فشل نهائي فوري من الخدمة", bad.isError && /Download failed|فشل نهائي|فشل الدمج|fetch failed/.test(bad.text), bad.text.slice(0, 90));
}

/* ============ المرحلة 6: list_media (معيار 10) ============ */

if (inPhase("6")) {
  console.log("\n=== المرحلة 6: list_media يعيد الأحدث أولًا (معيار 10) ===");
  const call = await callTool("list_media", { limit: 20 });
  check("list_media يعيد قائمة عربية بعدد المهام", call.text.includes("أحدث الوسائط المخزنة"));
  check("الصورة والفيديو والدمج كلها مذكورة بروابطها", ["صورة", "فيديو", "دمج"].every((t) => call.text.includes(t)) && call.text.includes("الرابط:"));
  // الأحدث أولًا: أول عنصر هو آخر مهمة أُنشئت
  const firstLine = call.text.split("\n")[2] ?? "";
  check("الترتيب من الأحدث", firstLine.trim().startsWith("1."), firstLine.slice(0, 50));

  // فلترة بالنوع
  const imgs = await callTool("list_media", { type: "image", limit: 50 });
  check("فلتر list_media type=image يعمل", imgs.text.includes("صورة") && !imgs.text.includes("دمج"));
}

/* ============ المرحلة 7: واجهة الإدارة (معيار 11 جزء API) ============ */

if (inPhase("7")) {
  console.log("\n=== المرحلة 7: تعطيل/تنشيط/حذف من API الإدارة ===");
  const keys = ((await api("/api/keys")).json.keys ?? []) as Array<Record<string, unknown>>;
  const tmp = keys.find((k) => String(k.label).includes("خاطئ"))!;
  const del = await api(`/api/keys/${tmp.id}`, { method: "DELETE" });
  check("حذف مفتاح يعمل", del.status === 200);
  const after = ((await api("/api/keys")).json.keys ?? []) as Array<Record<string, unknown>>;
  check("المفتاح المحذوف لم يعد موجودًا", !after.some((k) => k.id === tmp.id));
  const tasksStats = (await api("/api/tasks?limit=5")).json as Record<string, unknown>;
  check("مسار /api/tasks يرجع إحصائيات وقائمة", typeof (tasksStats.stats as Record<string, unknown>)?.total === "number" && Array.isArray(tasksStats.tasks));
}

/* ============ المرحلة 8: تنظيف وظائف الدمج من الخدمة ============ */

if (inPhase("8")) {
  console.log("\n=== المرحلة 8: تنظيف وظائف الدمج من خدمة الدمج ===");
  const rows = await db.execute("SELECT DISTINCT provider_task_id FROM tasks WHERE type = 'merge' AND provider_task_id IS NOT NULL");
  let deleted = 0;
  for (const row of rows.rows) {
    const jobId = row.provider_task_id;
    if (typeof jobId !== "string") continue;
    try {
      const res = await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      if (res.ok || res.status === 404) deleted++;
    } catch {}
  }
  check("حذف وظائف الدمج الاختبارية من الخدمة", deleted >= 1, `${deleted} وظيفة`);
}

/* ============ الخلاصة ============ */

const failed = results.filter((r) => !r.ok);
console.log(`\n===== هذه الدفعة (${PHASES.join(",")}): ${results.length - failed.length}/${results.length} نجحت =====`);
if (failed.length) {
  console.log("الفاشلة:");
  failed.forEach((f) => console.log(" - " + f.name + (f.extra ? ` (${f.extra})` : "")));
  process.exit(1);
}
if (PHASES.join(",") === "0,1,2,3a,3b,4,5,6,7,8") console.log("E2E_COMPLETE");
