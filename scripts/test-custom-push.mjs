#!/usr/bin/env node
/**
 * Prueba POST /api/push/send (handleSendCustomNotification).
 *
 * Uso:
 *   npm run dev   # en otra terminal
 *   node scripts/test-custom-push.mjs
 *
 * Opcional:
 *   BASE_URL=https://tu-dominio.com node scripts/test-custom-push.mjs
 *   TOKEN=ExponentPushToken[xxx] node scripts/test-custom-push.mjs
 */

const base = process.env.BASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:3000";
const singleToken = process.env.TOKEN?.trim();

const body = {
  title: "Test push",
  body: `Script test-custom-push ${new Date().toISOString()}`,
  data: { source: "scripts/test-custom-push.mjs" },
  ...(singleToken ? { tokens: [singleToken] } : {}),
};

const res = await fetch(`${base}/api/push/send`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  console.error("Not JSON:", text);
  process.exit(1);
}

console.log("Status:", res.status);
console.log(JSON.stringify(json, null, 2));

if (!res.ok) process.exit(1);
if (json.ok === false) process.exit(1);
if (json.sent === 0 && !json.message?.includes("no tokens")) {
  console.warn("(0 enviados; registra un device con POST /api/push/register desde la app.)");
}
