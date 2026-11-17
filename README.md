# مولّد الوسائط — خادم MCP

خادم MCP (Model Context Protocol) لتوليد الوسائط يجمع ثلاث قدرات في أداة واحدة:

1. **توليد صور** من وصف نصي — الموديل: `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو** مع صوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل: `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة وبالترتيب المطلوب

تطبيق **Next.js واحد** فيه جزءان:

- **خادم MCP** على المسار `/mcp` (نقل Streamable HTTP — SDK الرسمي `@modelcontextprotocol/sdk`) يعرض **5 أدوات** لأي عميل: ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK.
- **واجهة ويب عربية RTL** لإدارة مفاتيح API، ومتابعة المهام حية، وعرض إعدادات الربط جاهزة للنسخ.

## القواعد الجوهرية

- **لا يُنزَّل أي ملف وسائط على السيرفر** — نرسل الروابط للمزودين ونخزّن روابط النتائج فقط (كل الحالة في Turso).
- **المفاتيح تُجرَّب بترتيب تسلسلي صارم** حسب ترتيب الإضافة (`created_at ASC, id ASC`) — ليس round-robin — مع **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة: تُستأنف المهمة بنفس `task_id` على المفتاح التالي، ونموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
- التوليد غير متزامن: الأداة تعيد `task_id` فورًا (مع نافذة انتظار قصيرة تبث تقدمًا حيًا عبر Progress notifications)، ويُتابع بأداة `get_task` كل ~10 ثوانٍ.
- المهمة التي تفشل على كل المفاتيح تبقى `processing` «بانتظار توفر مفتاح صالح…» وتُعاد محاولتها تلقائيًا مع كل `get_task` (تهدئة ~45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من تلقاء نفسها.
- ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة (مذكورة في وصف الأداة وفي SERVER_INSTRUCTIONS).

## الأدوات الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` مع تبديل تلقائي عبر كل المفاتيح |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت أصلي + image-to-video اختياري) |
| `merge_videos` | دمج حتى 10 مقاطع في فيديو واحد بالترتيب — عبر `urls` مباشرة أو `task_ids` لمهام مكتملة |
| `get_task` | متابعة أي مهمة (توليد أو دمج) وتحديثها حية من المزود/الخدمة |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

## البنية

```
src/
  app/
    layout.tsx              # RTL عربي + خط Cairo
    page.tsx                # لوحة التحكم
    mcp/route.ts            # خادم MCP (Streamable HTTP، وضع عديم الجلسة — مناسب لـ serverless)
    api/health/route.ts     # فحص Turso + خدمة الدمج
    api/keys/route.ts       # قائمة مفاتيح مُقنَّعة دائمًا + إضافة
    api/keys/[id]/route.ts  # تعطيل/تنشيط/حذف
    api/tasks/route.ts      # إحصائيات وأحدث المهام للواجهة
  lib/
    turso.ts                # عميل Turso عبر HTTP + المخطط + عمليات المهام والمفاتيح
    classify.ts             # تصنيف الأخطاء: disabled / exhausted / provider / params / temporary
    mask.ts                 # تقنيع المفاتيح وتنقية الأسرار من السجلات
    models.ts               # سجل الموديلات والأسماء البديلة (نقاط/شرطات)
    generation.ts           # منسّق التوليد + التبديل التسلسلي + refreshTask
    merger.ts               # عميل Video Merger API v2 + runMerge/refreshMergeTask
    mcp/server.ts           # تسجيل الأدوات الخمس والصياغة العربية للردود
    providers/              # محوّلان: kie.ts (Jobs API) و cometapi.ts (صور متزامنة + فيديو مهام)
scripts/
  e2e.mjs                   # اختبار شامل لمعايير القبول عبر نداءات MCP حقيقية
  mock-kie.mjs              # وكيل اختبار: 401/402 لمفاتيح وهمية وشفاف للمفتاح الحقيقي
  mock-merger.mjs           # خدمة دمج محلية بديلة (ffmpeg) عند الحاجة
```

## التشغيل المحلي

```bash
bun install          # أو npm install
cp .env.local.example .env.local   # ثم عبّئ القيم الحقيقية
bun run dev          # http://localhost:3000
```

## متغيرات البيئة (محليًا وعلى Vercel)

```bash
# إلزامية
TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
TURSO_AUTH_TOKEN=<Turso token بصلاحيات كتابة>
MERGER_API_BASE=<عنوان خدمة Video Merger API v2>

# اختيارية
MCP_ACCESS_TOKEN=            # إن ضُبط يُطلب Authorization: Bearer <token> على /mcp
KIE_IMAGE_MODEL=             # تجاوز اسم الموديل المرسل لكل مزود إن لزم
KIE_VIDEO_MODEL=
COMETAPI_IMAGE_MODEL=
COMETAPI_VIDEO_MODEL=
```

> **لا أسرار في Git إطلاقًا** — `.env*` مُستثنى في `.gitignore` منذ أول commit، والمفاتيح تُقنَّع (`maskKey`) في كل الاستجابات والسجلات.

## إنشاء قاعدة Turso مجانية

```bash
turso db create <name>
turso db show <name> --url          # → TURSO_DATABASE_URL
turso db tokens create <name>       # → TURSO_AUTH_TOKEN
```

المخطط يُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا حاجة لأي migrations ولا ملفات محلية.

## النشر على Vercel

1. اربط المستودع في Vercel (Framework: Next.js).
2. أضف متغيرات البيئة الثلاثة الإلزامية (+ `MCP_ACCESS_TOKEN` اختياريًا) في Settings → Environment Variables.
3. Deploy — كل شيء يعمل لأن libSQL يتصل عبر HTTP ومسار `/mcp` يدعم streaming (`runtime="nodejs"` + `maxDuration=60`).

نوافذ الانتظار داخل الطلب مقصوصة على 40 ثانية على Vercel لحماية مهلة الدوال؛ المتابعة تكمل دائمًا عبر `get_task` لأن حالة المهمة كلها في Turso لا في الذاكرة.

## الربط من عملاء MCP

استخدم الرابط `<origin>/mcp` (تعرضه الواجهة مع JSON جاهز للنسخ لكل عميل):

```json
{
  "mcpServers": {
    "media-generator": { "url": "https://<your-app>.vercel.app/mcp" }
  }
}
```

- **Claude Desktop**: نفس الصيغة مع `"type": "http"` داخل `claude_desktop_config.json`.
- **ChatGPT**: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
- **Cursor / Windsurf / Cline**: داخل `mcp.json` ثم أعد تحميل النافذة.

## الاختبارات

```bash
bun run typecheck      # tsc --noEmit
bun run lint
bun run build          # بناء إنتاجي

# اختبار شامل e2e (توليد حقيقي + تبديل تسلسلي + دمج + قيود):
KIE_REAL_KEY=<مفتاح kie صحيح> \
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... MERGER_API_BASE=... \
E2E_BASE=http://localhost:3100 bun run e2e
```

سيناريو الاختبار يضيف مفتاحًا خاطئًا أولًا ثم الصحيح فيتأكد أن نفس المهمة تكتمل على الثاني، وأن الخاطئ صار `disabled`، وأن رسائل العميل خالية تمامًا من أي ذكر للمفاتيح أو الرصيد.
