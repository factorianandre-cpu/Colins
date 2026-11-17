/**
 * وكيل kie.ai المحلي (منفذ 3998) — أداة اختبار فقط، ليست جزءًا من التطبيق.
 * الغرض: اختبار سيناريوهات التبديل التسلسلي دون استهلاك رصيد حقيقي:
 *  - المفتاح TEST_EXHAUST_KEY → يعيد {"code":402,"msg":"Insufficient balance..."} (نمط مستنزف)
 *  - المفتاح TEST_DISABLE_KEY → يعيد {"code":401,"msg":"Unauthorized..."} (نمط مفتاح مرفوض)
 *  - أي مفتاح آخر → وكيل شفاف إلى https://api.kie.ai نفس المسار/الجسم
 */
import http from "node:http";

const REAL = "https://api.kie.ai";
const PORT = 3998;

// قيم مفاتيح الاختبار — يضيفها سكربت الاختبار عبر POST /api/keys لاحقًا
const EXHAUST_PREFIX = "exhaust-test-";
const DISABLE_PREFIX = "disable-test-";

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  const auth = req.headers.authorization ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  console.log(`[mock-kie] ${req.method} ${req.url} key=${key.slice(0, 8)}…`);

  if (key.startsWith(EXHAUST_PREFIX)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 402, msg: "Insufficient balance, please recharge (充充值 your account)" }));
    return;
  }
  if (key.startsWith(DISABLE_PREFIX)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 401, msg: "Unauthorized – Authentication failed. Please check that your Authorization header is correctly set." }));
    return;
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

server.listen(PORT, "127.0.0.1", () => console.log(`[mock-kie] يعمل على ${PORT}`));
