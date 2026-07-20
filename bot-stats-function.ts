// Supabase Edge Function: "bot-stats"
// 由 pg_cron 定時呼叫，用 Bot Token 向 Discord 查機器人所在的群組數與成員數，寫入 bot_stats 表。
// 前端只讀 bot_stats（不碰 token）。
// 部署設定：Verify JWT = OFF（改用 x-hook-secret 驗證）
//
// 需要的密鑰（Edge Functions → Secrets）：
//   DISCORD_BOT_TOKEN  = Discord Developer Portal → 你的 App → Bot → Reset Token 後複製那串
//   REPORT_HOOK_SECRET = 沿用檢舉/每日報表那把（cron 會帶在標頭裡）

const BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") || "";
const SECRET = Deno.env.get("REPORT_HOOK_SECRET") || "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  try {
    // fail-closed：密鑰沒設就拒絕，避免變成任何人可打的公開端點
    if (!SECRET) return new Response("misconfigured", { status: 500 });
    if (req.headers.get("x-hook-secret") !== SECRET) return new Response("forbidden", { status: 403 });
    if (!BOT_TOKEN) return new Response("bot token not configured", { status: 200 });

    // 一次拿到所有 guild + 概略成員數（with_counts=true）
    const r = await fetch("https://discord.com/api/v10/users/@me/guilds?with_counts=true", {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (!r.ok) {
      console.error("discord guilds", r.status, (await r.text()).slice(0, 300));
      return new Response("discord " + r.status, { status: 200 });
    }
    const guilds = await r.json();
    if (!Array.isArray(guilds)) return new Response("unexpected payload", { status: 200 });

    const guildCount = guilds.length;
    const memberCount = guilds.reduce(
      (a: number, g: any) => a + (Number(g.approximate_member_count) || 0), 0);

    const up = await fetch(`${SB_URL}/rest/v1/bot_stats?id=eq.1`, {
      method: "PATCH",
      headers: {
        apikey: SB_SERVICE,
        Authorization: `Bearer ${SB_SERVICE}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ guilds: guildCount, members: memberCount, updated_at: new Date().toISOString() }),
    });
    if (!up.ok) console.error("bot_stats upsert", up.status, (await up.text()).slice(0, 300));

    return Response.json({ guilds: guildCount, members: memberCount });
  } catch (e) {
    console.error("bot-stats", e);
    return new Response("error logged", { status: 200 });
  }
});
