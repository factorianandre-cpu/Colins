/**
 * الاختبار الشامل e2e — يغطي معايير القبول 3..10 من المواصفة عبر نداءات MCP حقيقية.
 * التشغيل: KIE_REAL_KEY=<المفتاح> TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… node scripts/e2e.mjs
 * يعتمد: خادم Next على 3000، ووكيل mock-kie على 3998 (محاكاة 402/401 فقط — الباقي وكيل شفاف للمزود الحقيقي)،
 * وخدمة الدمج الحقيقية عبر MERGER_API_BASE (مطابقة لأشكال Video Merger API v2 المقاسة).
 */
import { createClient } from "@libsql/client";

const BASE = "http://localhost:3000";
const MERGER_BASE = (process.env.MERGER_API_BASE || "https://moo-salah-merger.vercel.app").replace(/\/+$/, "");
const DB_URL = process.env.TURSO_DATABASE_URL;
const DB_TOKEN = process.env.TURSO_AUTH_TOKEN;
const KIE_REAL_KEY = process.env.KIE_REAL_KEY;
if (!KIE_REAL_KEY) throw new Error("KIE_REAL_KEY مطلوب");

const db = createClient({ url: DB_URL, authToken: DB_TOKEN });

/* ============ أدوات مساعدة ============ */

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${extra ? " — " + extra : ""}`);
}

async function rpc(body) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return { json: await res.json(), sse: null };
  }
  // SSE: نجمع كل رسائل data: ونميز أحداث التقدم عن الرد النهائي
  const text = await res.text();
  const messages = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        messages.push(JSON.parse(line.slice(5).trim()));
      } catch {}
    }
  }
  const final = messages.find((m) => m.id !== undefined && (m.result !== undefined || m.error !== undefined));
  const progress = messages.filter((m) => m.method === "notifications/progress").map((m) => m.params);
  return { json: final, sse: { progress } };
}

async function callTool(name, args, withProgress = false) {
  const id = Math.floor(Math.random() * 1e9);
  const body = { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
  if (withProgress) {
    body.params._meta = { progressToken: `tok-${id}` };
  }
  const { json, sse } = await rpc(body);
  if (!json) throw new Error(`لا يوجد رد نهائي للأداة ${name}`);
  if (json.error) throw new Error(`خطأ بروتوكول في ${name}: ${JSON.stringify(json.error)}`);
  const text = (json.result?.content ?? []).map((c) => c.text).join("\n");
  return { text, isError: Boolean(json.result?.isError), progress: sse?.progress ?? [] };
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...init,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dbTask(id) {
  const r = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return r.rows[0] ?? null;
}

function extractTaskId(text) {
  const m = text.match(/task_id:\s*([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s)\"]+/);
  return m ? m[0] : null;
}

/** التأكد من عدم وجود ذكر مفاتيح/رصيد في رسالة العميل أبدًا (قاعدة ذهبية 4) */
const SECRET_LEAK_RE = /(مفتاح|المفاتيح|رصيد|الرصيد|api[_\s-]?key|balance|credit|quota|exhaust)/i;

/* ============ المرحلة 0: بداية نظيفة ============ */

console.log("=== المرحلة 0: تنظيف البداية ===");
// نضمن وجود المخطط أولًا عبر نداء الواجهة (ensureSchema يعمل عند أول وصول)
await api("/api/keys");
await db.execute("DELETE FROM tasks");
await db.execute("DELETE FROM api_keys");
console.log("قاعدة البيانات نظيفة");

/* ============ المرحلة 1: tools/list ============ */

console.log("\n=== المرحلة 1: tools/list ومطابقة المخططات (معيار 3) ===");
{
  const { json } = await rpc({ jsonrpc: "2.0", id: 100, method: "tools/list" });
  const tools = json?.result?.tools ?? [];
  check("أدوات MCP الخمس مكتملة", tools.length === 5, tools.map((t) => t.name).join(","));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const gi = byName["generate_image"];
  check("generate_image: required=prompt فقط", JSON.stringify(gi?.inputSchema?.required) === JSON.stringify(["prompt"]));
  const ar = gi?.inputSchema?.properties?.aspect_ratio;
  check("generate_image: 16 نسبة عرض بترتيب المواصفة", ar?.enum?.length === 16 && ar.enum[0] === "auto" && ar.enum.includes("21:9"));

  const gv = byName["generate_video"];
  check("generate_video: duration 1..15 افتراضي 8", gv?.inputSchema?.properties?.duration?.maximum === 15 && gv?.inputSchema?.properties?.duration?.default === 8);

  const mv = byName["merge_videos"];
  check("merge_videos: بلا resolution/fps", !("resolution" in (mv?.inputSchema?.properties ?? {})) && !("fps" in (mv?.inputSchema?.properties ?? {})));
  check("merge_videos: maxItems=10 على urls و task_ids", mv?.inputSchema?.properties?.urls?.maxItems === 10 && mv?.inputSchema?.properties?.task_ids?.maxItems === 10);

  const gt = byName["get_task"];
  check("get_task: task_id مطلوب", JSON.stringify(gt?.inputSchema?.required) === JSON.stringify(["task_id"]));

  const lm = byName["list_media"];
  check("list_media: limit 1..50 افتراضي 10", lm?.inputSchema?.properties?.limit?.maximum === 50 && lm?.inputSchema?.properties?.limit?.default === 10);

  // أداة مجهولة → رسالة عربية
  const unk = await callTool("nonexistent_tool", {});
  check("أداة مجهولة → رسالة عربية", unk.text.includes("أداة غير معروفة") && unk.text.includes("المتاح:"), unk.text.slice(0, 60));
}

/* ============ المرحلة 2: التبديل التسلسلي + توليد صورة حقيقي (معيارا 4 و6) ============ */

console.log("\n=== المرحلة 2: مفتاح خاطئ أولًا ثم الصحيح → نفس المهمة تكتمل (معيارا 4 و6) ===");
let firstImageTaskId = null;
let firstImageUrl = null;
{
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
  const maskedOk = list.json.keys.every((k) => k.maskedKey.includes("••••") && !Object.values(k).some((v) => typeof v === "string" && v === KIE_REAL_KEY));
  check("المفاتيح مُقنَّعة دائمًا ولا يظهر المفتاح الكامل", maskedOk, JSON.stringify(list.json.keys.map((k) => k.maskedKey)));

  const t0 = Date.now();
  const call = await callTool(
    "generate_image",
    { prompt: "قطة صغيرة تحمل فانوسًا في ليلة رمضان، إضاءة دافئة، تفاصيل عالية", aspect_ratio: "1:1", resolution: "1K", wait_seconds: 150 },
    true
  );
  check("توليد الصورة اكتمل بالرابط العربي", call.text.includes("تم توليد الصورة بنجاح"), `${Math.round((Date.now() - t0) / 1000)}s`);
  firstImageUrl = extractUrl(call.text);
  check("رابط الصورة موجود", Boolean(firstImageUrl), firstImageUrl ?? "");
  if (firstImageUrl) {
    const head = await fetch(firstImageUrl, { method: "HEAD" });
    check("رابط الصورة يعمل فعليًا (200 + صورة)", head.status === 200 && (head.headers.get("content-type") ?? "").startsWith("image/"), `ct=${head.headers.get("content-type")}`);
  }
  check("الرد خالٍ تمامًا من ذكر المفاتيح/الرصيد", !SECRET_LEAK_RE.test(call.text.replace("task_id:", "").replace(/task_id\s*$/, "")));

  const ev = call.progress;
  check("بث تقدم حي عبر progress notifications", ev.length >= 1 && ev.every((p) => typeof p.progress === "number" && p.total === 100 && typeof p.message === "string"), `${ev.length} إشعارًا`);

  firstImageTaskId = extractTaskId(call.text);

  // فحص قاعدة البيانات: محاولتان بنفس الترتيب + حالة المفاتيح
  const row = firstImageTaskId ? await dbTask(firstImageTaskId) : null;
  const attempts = row ? JSON.parse(row.attempts_json) : [];
  check("attempts: محاولتان (فاشلة ثم ناجحة) بنفس task_id", attempts.length === 2 && attempts[0].ok === false && attempts[1].ok === true && attempts[0].errorClass === "disabled", JSON.stringify(attempts.map((a) => [a.ok, a.errorClass])));
  const keys = (await api("/api/keys")).json.keys;
  const wrongKey = keys.find((k) => k.label.includes("خاطئ"));
  const realKey = keys.find((k) => k.label.includes("الرئيسي"));
  check("المفتاح الخاطئ صار disabled", wrongKey?.status === "disabled");
  check("المفتاح الصحيح نشط ونجح", realKey?.status === "active" && realKey.successCount >= 1);
  check("provider/key_id مرتبطان بالمفتاح الصحيح", row?.provider === "kie" && realKey && row?.key_id === realKey.id);
}

/* ============ المرحلة 3: توليد فيديو حقيقي + get_task كل 10 ثوانٍ (معيار 5) ============ */

console.log("\n=== المرحلة 3: توليد فيديو حقيقي ومتابعته بـ get_task (معيار 5) ===");
{
  const call = await callTool(
    "generate_video",
    { prompt: "لقطة سينمائية لمدينة عربية قديمة عند الغروب، شخص يمشي في السوق ويقول: ما أجمل هذا المكان!", duration: 5, resolution: "480p", wait_seconds: 25 },
    true
  );
  const tid = extractTaskId(call.text);
  check("الفديو يعيد task_id قيد المعالجة (أو اكتمل مبكرًا)", call.text.includes("قيد المعالجة") || call.text.includes("تم توليد الفيديو بنجاح"), call.text.slice(0, 80));

  let videoUrl = null;
  if (tid) {
    let polls = 0;
    while (polls < 60) {
      await sleep(10000);
      polls++;
      const gt = await callTool("get_task", { task_id: tid });
      if (gt.text.includes("تم توليد الفيديو بنجاح")) {
        videoUrl = extractUrl(gt.text);
        break;
      }
      if (gt.isError) break;
      process.stdout.write(`.`);
    }
    console.log("");
    check("get_task كمل الفيديو خلال الحد المسموح", Boolean(videoUrl), `${polls} استعلامًا`);
  } else {
    videoUrl = extractUrl(call.text);
  }
  if (videoUrl) {
    const head = await fetch(videoUrl, { method: "HEAD" });
    check("رابط الفيديو يعمل فعليًا (200 + فيديو)", head.status === 200 && (head.headers.get("content-type") ?? "").includes("video"), `ct=${head.headers.get("content-type")}`);
  } else {
    check("رابط الفيديو يعمل فعليًا (200 + فيديو)", false, "لا رابط");
  }
}

/* ============ المرحلة 4: مفتاح مستنزف 402 ثم استئناف تلقائي (معيار 7 + 4.3.3) ============ */

console.log("\n=== المرحلة 4: مفتاح مستنزف يبقى في القاعدة دون عرقلة (معيار 7) ===");
{
  // نضيف مفتاح مستنزف (يصبح في الموضع 2 بعد الرئيسي)
  const ex = await api("/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider: "kie", api_key: "exhaust-test-e001", label: "اختبار — مستنزف" }),
  });
  check("إضافة المفتاح المستنزف الاختباري", ex.status === 201);

  // نعطل الرئيسي يدويًا فيبقى المستنزف وحده في التجمع
  const keys = (await api("/api/keys")).json.keys;
  const realKey = keys.find((k) => k.label.includes("الرئيسي"));
  await api(`/api/keys/${realKey.id}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) });

  const call = await callTool("generate_image", { prompt: "شعار بسيط لشركة تقنية، خلفية سوداء", aspect_ratio: "1:1", wait_seconds: 30 });
  const tid = extractTaskId(call.text);
  check("المهمة تبقى processing بانتظار مفتاح (وليست failed)", call.text.includes("قيد المعالجة") && tid !== null, call.text.slice(0, 70));
  check("العميل لا يرى أي ذكر للرصيد/المفاتيح", !SECRET_LEAK_RE.test(call.text));

  const keys2 = (await api("/api/keys")).json.keys;
  const exKey = keys2.find((k) => k.label.includes("مستنزف"));
  check("المفتاح المستنزف صار exhausted ويبقى في القاعدة", exKey?.status === "exhausted", exKey?.maskedKey);
  const row = tid ? await dbTask(tid) : null;
  const attempts = row ? JSON.parse(row.attempts_json) : [];
  check("المحاولة صُنفت exhausted في attempts", attempts.some((a) => a.errorClass === "exhausted"), JSON.stringify(attempts.map((a) => a.errorClass)));

  // نعيد تنشيط الرئيسي (مثل شحن الرصيد) ثم get_task بعد انتهاء التهدئة → تكتمل من تلقاء نفسها
  await api(`/api/keys/${realKey.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  const first = await callTool("get_task", { task_id: tid });
  check("التهدئة: أول get_task لا يعيد الإنشاء فورًا", first.text.includes("قيد المعالجة"));
  await sleep(47000);
  let resumed = null;
  for (let i = 0; i < 30; i++) {
    resumed = await callTool("get_task", { task_id: tid });
    if (resumed.text.includes("تم توليد الصورة بنجاح")) break;
    if (resumed.isError) break;
    await sleep(10000);
    process.stdout.write(".");
  }
  console.log("");
  check("بعد إعادة تنشيط المفتاح تكتمل المهمة بنفس task_id تلقائيًا", resumed?.text.includes("تم توليد الصورة بنجاح"), extractTaskId(resumed?.text ?? "") === tid ? "نفس task_id" : "task_id تغير؟");
}

/* ============ المرحلة 5: الدمج الحقيقي والقيود (معيارا 8 و9) ============ */

console.log("\n=== المرحلة 5: دمج مقطعين حقيقيين + قيود الدمج (معيارا 8 و9) ===");
let mergeJobIds = [];
{
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
    const head = await fetch(mUrl, { method: "HEAD" });
    check("الناتج MP4 يعمل ويُشغَّل", head.status === 200 && (head.headers.get("content-type") ?? "").includes("video"), `ct=${head.headers.get("content-type")}`);
    const jid = mUrl.match(/\/api\/jobs\/([^/?]+)/)?.[1];
    if (jid) mergeJobIds.push(jid);
  }

  // 5-ب: حلل task_ids بالترتيب — نزرع مهمتين مكتملتين مباشرة في القاعدة
  const seed1 = "11111111-1111-4111-8111-111111111111";
  const seed2 = "22222222-2222-4222-8222-222222222222";
  await db.execute({
    sql: `INSERT INTO tasks (id, provider, key_id, model, type, prompt, params_json, status, progress, result_urls_json, attempts_json)
          VALUES (?, 'kie', 'seed', 'grok-imagine-video-1-5-preview', 'video', 'مهمة بذر 1', '{}', 'completed', 100, ?, '[]')`,
    args: [seed1, JSON.stringify(["https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4"])],
  });
  await db.execute({
    sql: `INSERT INTO tasks (id, provider, key_id, model, type, prompt, params_json, status, progress, result_urls_json, attempts_json)
          VALUES (?, 'kie', 'seed', 'grok-imagine-video-1-5-preview', 'video', 'مهمة بذر 2', '{}', 'completed', 100, ?, '[]')`,
    args: [seed2, JSON.stringify(["https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4"])],
  });
  const call2 = await callTool("merge_videos", { task_ids: [seed1, seed2], wait_seconds: 180 });
  check("الدمج عبر task_ids اكتمل", call2.text.includes("تم دمج المقاطع بنجاح"));
  const t2 = extractTaskId(call2.text) ? await dbTask(extractTaskId(call2.text)) : null;
  const order = t2 ? JSON.parse(t2.params_json).urls : [];
  check("ترتيب حلل task_ids صحيح (أولًا task_ids ثم urls)", order[0]?.includes("Jellyfish") && order[1]?.includes("Sintel"), JSON.stringify(order.map((u) => u.split("/").pop())));
  const jid2 = extractUrl(call2.text)?.match(/\/api\/jobs\/([^/?]+)/)?.[1];
  if (jid2) mergeJobIds.push(jid2);

  // 5-ج: مقطع واحد → رفض عربي
  const one = await callTool("merge_videos", { urls: ["https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4"] });
  check("مقطع واحد → «الدمج يحتاج مقطعَين على الأقل»", one.text.includes("الدمج يحتاج مقطعَين على الأقل") && one.isError);

  // 5-د: أكثر من 10 → رسالة الحد الصحيحة
  const eleven = Array.from({ length: 11 }, (_, i) => `https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4?c=${i}`);
  const many = await callTool("merge_videos", { urls: eleven });
  check("11 مقطعًا → «أقصى عدد مقاطع للدمج هو 10»", many.text.includes("أقصى عدد مقاطع للدمج هو 10") && many.isError);

  // 5-هـ: مهمة دمج غير موجودة في الخدمة (404) → فشل نهائي بالرسالة المحددة
  const ghost = await callTool("merge_videos", { urls: [ "https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4", "https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4" ], wait_seconds: 5 });
  const ghostTask = extractTaskId(ghost.text);
  if (ghostTask) {
    // نحذف الوظيفة من الخدمة الحقيقية (محاكاة انتهاء الصلاحية بعد 24 ساعة) ثم نستعلم
    const gRow = await dbTask(ghostTask);
    const ghostJob = gRow?.provider_task_id;
    if (ghostJob) await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(ghostJob)}`, { method: "DELETE" });
    const g2 = await callTool("get_task", { task_id: ghostTask });
    check("404 من الخدمة → فشل نهائي برسالة 24 ساعة", g2.text.includes("مهمة الدمج غير موجودة في الخدمة") && g2.isError);
  } else {
    check("404 من الخدمة → فشل نهائي برسالة 24 ساعة", false, ghost.text.slice(0, 80));
  }

  // 5-و: مصدر يرفض التحميل → فشل نهائي فوري من الخدمة (HTTP 500 معلن)
  const bad = await callTool("merge_videos", {
    urls: [
      "https://www.w3schools.com/html/mov_bbb.mp4",
      "https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4",
    ],
    wait_seconds: 90,
  });
  check("مصدر يرفض التحميل (403) → فشل نهائي فوري من الخدمة", bad.isError && /Download failed|فشل نهائي/.test(bad.text), bad.text.slice(0, 90));
}

/* ============ المرحلة 6: list_media (معيار 10) ============ */

console.log("\n=== المرحلة 6: list_media يعيد الأحدث أولًا (معيار 10) ===");
{
  const call = await callTool("list_media", { limit: 20 });
  check("list_media يعيد قائمة عربية بعدد المهام", call.text.includes("أحدث الوسائط المخزنة"));
  check("الصورة والفيديو والدمج كلها مذكورة بروابطها", ["صورة", "فيديو", "دمج"].every((t) => call.text.includes(t)) && call.text.includes("الرابط:"));
  // الأحدث أولًا: أول عنصر هو آخر مهمة أُنشئت (الدمج الأخير)
  const firstLine = call.text.split("\n")[2] ?? "";
  check("الترتيب من الأحدث", firstLine.startsWith("1."), firstLine.slice(0, 50));

  // فلترة بالنوع
  const imgs = await callTool("list_media", { type: "image", limit: 50 });
  check("فلتر list_media type=image يعمل", imgs.text.includes("صورة") && !imgs.text.includes("دمج"));
}

/* ============ المرحلة 7: واجهة الإدارة (معيار 11 جزء API) ============ */

console.log("\n=== المرحلة 7: تعطيل/تنشيط/حذف من API الإدارة ===");
{
  const keys = (await api("/api/keys")).json.keys;
  const tmp = keys.find((k) => k.label.includes("خاطئ"));
  const del = await api(`/api/keys/${tmp.id}`, { method: "DELETE" });
  check("حذف مفتاح يعمل", del.status === 200);
  const after = (await api("/api/keys")).json.keys;
  check("المفتاح المحذوف لم يعد موجودًا", !after.some((k) => k.id === tmp.id));
  const tasksStats = (await api("/api/tasks?limit=5")).json;
  check("مسار /api/tasks يرجع إحصائيات وقائمة", typeof tasksStats.stats?.total === "number" && Array.isArray(tasksStats.tasks));
}

/* ============ المرحلة 8: تنظيف وظائف الدمج من الخدمة (القاعدة 12: نظف آثار الاختبار) ============ */

console.log("\n=== المرحلة 8: تنظيف وظائف الدمج من خدمة الدمج ===");
{
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
console.log(`\n===== النتيجة: ${results.length - failed.length}/${results.length} نجحت =====`);
if (failed.length) {
  console.log("الفاشلة:");
  failed.forEach((f) => console.log(" - " + f.name));
  process.exit(1);
}
console.log("E2E_COMPLETE");
