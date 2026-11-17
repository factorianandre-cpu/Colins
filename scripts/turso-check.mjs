// فحص سريع لاتصال Turso قبل البناء — يقرأ البيانات من .env.local لاحقًا
import { createClient } from "@libsql/client";
const url = process.argv[2], token = process.argv[3];
const c = createClient({ url, authToken: token });
const t0 = Date.now();
const r = await c.execute("SELECT 1 AS one");
console.log("SELECT 1 ok:", JSON.stringify(r.rows), "in", Date.now()-t0, "ms");
const tables = await c.execute("SELECT name FROM sqlite_schema WHERE type='table'");
console.log("existing tables:", tables.rows.map(x=>x.name).join(", ") || "(none)");
