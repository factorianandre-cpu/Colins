/**
 * وكيل kie.ai المحلي (منفذ 3998) — أداة اختبار فقط، ليست جزءًا من التطبيق.
 * الغرض: اختبار سيناريوهات التبديل التسلسلي ودورة حياة الفيديو دون استهلاك رصيد حقيقي:
 *  - المفتاح البادئ بـ exhaust-test- → يعيد {"code":402,"msg":"Insufficient balance..."} (نمط مستنزف)
 *  - المفتاح البادئ بـ disable-test- → يعيد {"code":401,"msg":"Unauthorized..."} (نمط مفتاح مرفوض)
 *  - المفتاح البادئ بـ video-test- → يحاكي دورة حياة فيديو كاملة (createTask ثم generating ثم success برابط MP4 عام)
 *    — يثبت تدفق generate_video/get_task كاملًا عندما لا يكفي رصيد المفتاح الحقيقي للفيديو
 *  - أي مفتاح آخر → وكيل شفاف إلى https://api.kie.ai نفس المسار/الجسم
 */
import http from "node:http";

const REAL = "https://api.kie.ai";
const PORT = 3998;

// قيم مفاتيح الاختبار — يضيفها سكربت الاختبار عبر POST /api/keys لاحقًا
const EXHAUST_PREFIX = "exhaust-test-";
const DISABLE_PREFIX = "disable-test-";
const VIDEO_PREFIX = "video-test-";

// مهام الفيديو المحاكاة: taskId → وقت الإنشاء (تنتقل generating ثم success بعد ~20 ثانية)
const videoSims = new Map();
const VIDEO_SUCCESS_AFTER_MS = 20_000;
const VIDEO_RESULT_URL = "https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4";

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  const auth = req.headers.authorization ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  console.log(`MOCK-KIE] ${req.method} ${req.url} key=${key.slice(0, 8)}…`);

  if (key.startsWith(EXHAUST_PREFIX)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 402, msg: "Insufficient balance, please recharge (充值 your account)" }));
    return;
  }
  if (key.startsWith(DISABLE_PREFIX)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 401, msg: "Unauthorized – Authentication failed. Please check that your Authorization header is correctly set." }));
    return;
  }

  // محاكاة دورة حياة فيديو كاملة (بدون رصيد): createTask ثم recordInfo يتحول generating → success
  // ملاحظة: المفتاح المحاكى "مخصص للفيديو فقط" — نموذج الصور يُرفض 422 (provider class) كي يُتخطى
  if (key.startsWith(VIDEO_PREFIX) && req.url?.startsWith("/api/v1/jobs/")) {
    if (req.url.includes("/createTask")) {
      let model = "";
      try {
        model = String(JSON.parse(body || "{}").model ?? "");
      } catch {}
      if (!model.includes("video")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 422, msg: "The model name you specified is not supported. Please verify your input and use one of the supported models provided by KIE.", data: null }));
        return;
      }
      const tid = `vtsim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      videoSims.set(tid, Date.now());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 200, msg: "success", data: { taskId: tid } }));
      return;
    }
    if (req.url.includes("/recordInfo")) {
      const tid = new URL(req.url, "http://x").searchParams.get("taskId") ?? "";
      const started = videoSims.get(tid);
      const elapsed = started ? Date.now() - started : 0;
      const data = !started
        ? { state: "fail", failMsg: "unknown simulated task" }
        : elapsed < VIDEO_SUCCESS_AFTER_MS
          ? { state: "generating", progress: Math.min(90, 10 + Math.round((elapsed / VIDEO_SUCCESS_AFTER_MS) * 80)) }
          : { state: "success", resultJson: JSON.stringify({ resultUrls: [VIDEO_RESULT_URL] }) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 200, msg: "success", data }));
      return;
    }
  }

  // وكيل شفاف للمزود الحقيقي
  try {
    const upstream = await fetch(`${REAL}${req.url}`, {
      method: req.method,
      headers: {
        Authorization: auth,
        "Content-Type": req.headers["content-type"] ?? "application/json",
      },
      body: ["POST", "PUT", "PATCH"].includes(req.method ?? "") && body ? body : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const headers = {};
    upstream.headers.forEach((v, k) => {
      if (!["content-encoding", "transfer-encoding", "content-length"].includes(k)) headers[k] = v;
    });
    res.writeHead(upstream.status, headers);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 500, msg: `proxy network error: ${e.message}` }));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`MOCK-KIE] يعمل على ${PORT}`));
