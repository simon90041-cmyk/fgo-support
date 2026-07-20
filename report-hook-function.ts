// Supabase Edge Function: "report-hook"
// 由 Database Webhook 觸發（public.reports 的 INSERT），把檢舉轉發到 Discord 頻道。
// 部署設定：Verify JWT = OFF（改用自訂密鑰標頭驗證）
//
// 需要的密鑰（Edge Functions → Secrets）：
//   DISCORD_REPORT_WEBHOOK = https://discord.com/api/webhooks/...
//   REPORT_HOOK_SECRET     = 自訂一組隨機字串，Database Webhook 會帶在標頭裡

const HOOK = Deno.env.get("DISCORD_REPORT_WEBHOOK") || "";
const SECRET = Deno.env.get("REPORT_HOOK_SECRET") || "";
const SITE = "https://simon90041-cmyk.github.io/fgo-support/";
const SRV: Record<string, string> = { JP: "日服", NA: "美服", TW: "台服", CN: "國服" };

const cut = (v: unknown, n: number) => String(v ?? "-").slice(0, n) || "-";

Deno.serve(async (req) => {
  // pg_net 是 fire-and-forget、非 2xx 不會重試，所以密鑰錯誤/未設定時回 4xx/5xx 只是留紀錄，不會造成重送風暴
  try {
    // fail-closed：密鑰沒設定就拒絕，不要退化成任何人都能打的公開端點
    if (!SECRET) return new Response("misconfigured", { status: 500 });
    if (req.headers.get("x-hook-secret") !== SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    if (!HOOK) return new Response("webhook not configured", { status: 200 });

    const body = await req.json();
    const r = body.record ?? body.new ?? body ?? {};
    const digits = String(r.code ?? "").replace(/\D/g, "");

    const fields: any[] = [
      { name: "被檢舉編號", value: `${cut(r.code, 40)}（${SRV[r.server] ?? r.server ?? "?"}）`, inline: true },
      { name: "檢舉者", value: r.reporter ? `已登入（${String(r.reporter).slice(0, 8)}…）` : "未登入", inline: true },
      { name: "原因", value: cut(r.reason, 300), inline: false },
      { name: "說明", value: cut(r.detail, 1000), inline: false },
    ];
    if (r.contact) fields.push({ name: "聯絡方式", value: cut(r.contact, 300), inline: false });

    await fetch(HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "🚩 新的檢舉",
          url: digits ? `${SITE}?code=${digits}` : SITE,
          color: 0xd3453b,
          fields,
          footer: { text: `report id ${r.id ?? "?"}・處理後請在 Supabase 標記 handled` },
          timestamp: r.ts ?? new Date().toISOString(),
        }],
      }),
    });
    return new Response("ok");
  } catch (e) {
    console.error("report-hook", e);
    return new Response("error logged", { status: 200 });
  }
});
