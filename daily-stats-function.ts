// Supabase Edge Function: "daily-stats"
// 由 pg_cron 每天定時呼叫，把網站統計整理成 Discord 訊息推送。
// 部署設定：Verify JWT = OFF（改用 x-hook-secret 驗證）
//
// 使用的密鑰（沿用檢舉通知那兩個，不用另外設定）：
//   DISCORD_REPORT_WEBHOOK / REPORT_HOOK_SECRET

const HOOK = Deno.env.get("DISCORD_REPORT_WEBHOOK") || "";
const SECRET = Deno.env.get("REPORT_HOOK_SECRET") || "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = "https://simon90041-cmyk.github.io/fgo-support/";

const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-US");

Deno.serve(async (req) => {
  try {
    // fail-closed：密鑰沒設定就拒絕，避免變成任何人可打的公開端點
    if (!SECRET) return new Response("misconfigured", { status: 500 });
    if (req.headers.get("x-hook-secret") !== SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    if (!HOOK) return new Response("webhook not configured", { status: 200 });

    const res = await fetch(`${SB_URL}/rest/v1/rpc/daily_stats`, {
      method: "POST",
      headers: {
        apikey: SB_SERVICE,
        Authorization: `Bearer ${SB_SERVICE}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    // 查詢失敗時不要靜默送出一份全 0 報表，改發警示
    if (!res.ok) {
      const errTxt = (await res.text()).slice(0, 500);
      await fetch(HOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title: "⚠ 每日報表產生失敗",
            color: 0xd3453b,
            description: "```\n" + errTxt + "\n```",
            footer: { text: `daily_stats RPC 回應 ${res.status}` },
          }],
        }),
      }).catch(() => {});
      return new Response("stats rpc failed", { status: 200 });
    }
    const s = await res.json();

    // 各伺服器登記數：報表分服顯示，TW+JP 合計同時當同步管線金絲雀的基準
    const SRV: Record<string, string> = { TW: "台服", JP: "日服", NA: "美服", CN: "國服" };
    let srvLine = "";
    let autoTotal = 0; // TW+JP = worker 自動同步對象
    try {
      const er = await fetch(`${SB_URL}/rest/v1/entries?select=server`, {
        headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
      });
      const ej = await er.json();
      if (Array.isArray(ej) && ej.length) {
        const cnt: Record<string, number> = {};
        for (const e of ej) cnt[e.server] = (cnt[e.server] || 0) + 1;
        srvLine = Object.entries(cnt)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${SRV[k] || k} **${n(v)}**`)
          .join(" ・ ");
        autoTotal = (cnt.TW || 0) + (cnt.JP || 0);
      }
    } catch { /* 分服細分失敗不擋報表 */ }

    // ref/name 皆可被匿名寫入 → 去 markdown 特殊字元、截斷，避免破壞或偽造報表
    const mdSafe = (v: unknown, len: number) =>
      String(v ?? "").replace(/[`*_~|>@\\]/g, "").slice(0, len);
    const refs = (s.top_refs ?? []).length
      ? (s.top_refs as any[]).map((r) => `\`${n(r.n)}\` ${mdSafe(String(r.ref).replace(/^https?:\/\//, ""), 45)}`).join("\n")
      : "（昨日無訪客）";
    const svts = (s.top_servants ?? []).length
      ? (s.top_servants as any[]).map((x, i) => `${i + 1}. ${mdSafe(x.name, 40)}　\`${n(x.n)} 人\``).join("\n")
      : "（尚無資料）";

    const fields: any[] = [
      { name: "📈 過去 24 小時", value: `瀏覽 **${n(s.views_24h)}** ・ 訪客 **${n(s.visitors_24h)}**`, inline: false },
      { name: "👥 登記狀況", value: `玩家 **${n(s.players)}** ・ 登記 **${n(s.entries)}** ・ 助戰從者 **${n(s.servants)}**${srvLine ? `\n${srvLine}` : ""}`, inline: false },
      { name: "🆕 昨日異動", value: `新登記 **${n(s.new_24h)}** ・ 更新 **${n(s.updated_24h)}**`, inline: false },
      { name: "🔗 流量來源 Top5", value: refs, inline: false },
      { name: "🏆 最多人放的從者", value: svts, inline: false },
    ];
    // 一律顯示：這樣「0 件」和「通知壞掉但其實有 40 件」不會長得一樣
    const pending = Number(s.pending_reports ?? 0);
    fields.push({ name: "🚩 待處理檢舉", value: pending > 0 ? `**${n(pending)}** 件未處理` : "無", inline: false });

    // 金絲雀監控：把「會靜默出事」的東西變成看得見的警告
    const warnings: string[] = [];
    // (a) 接近 PostgREST 預設 1000 筆上限 → 超過會靜默截斷，資料在網站與 bot 都會消失
    const entries = Number(s.entries ?? 0);
    if (entries >= 950) warnings.push(`⚠ 登記數 **${n(entries)}**／1000，接近 PostgREST 靜默截斷上限 — 該改分頁或靜態快照了`);
    else if (entries >= 800) warnings.push(`⚠ 登記數 **${n(entries)}**，開始接近 1000 筆上限，可提前規劃`);
    // (b) bot_stats 太久沒更新 → 每6小時的 cron 可能死了（pg_net 失敗是靜默的）
    try {
      const br = await fetch(`${SB_URL}/rest/v1/bot_stats?id=eq.1&select=updated_at`, {
        headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
      });
      const bj = await br.json();
      const up = Array.isArray(bj) && bj[0]?.updated_at ? new Date(bj[0].updated_at).getTime() : 0;
      const ageH = up ? (Date.now() - up) / 3.6e6 : Infinity;
      if (ageH > 12) warnings.push(`⚠ 機器人統計已 **${Number.isFinite(ageH) ? Math.round(ageH) + " 小時" : "從未"}** 未更新 — bot-stats 排程可能已停`);
    } catch { /* 監控本身失敗不影響報表 */ }
    // (c) 同步管線：正常時 TW/JP 每天被整批更新數次 → updated_24h 應 ≥ 台日服登記數
    const upd = Number(s.updated_24h ?? 0);
    if (upd === 0) warnings.push("⚠ 過去 24 小時**沒有任何登記被更新** — 同步管線（模擬器 worker）可能已停");
    else if (autoTotal && upd < autoTotal) warnings.push(`⚠ 昨日更新 **${n(upd)}**／自動同步對象 **${n(autoTotal)}** — worker 可能漏跑部分編號`);
    if (warnings.length) fields.push({ name: "🛎️ 系統警示", value: warnings.join("\n"), inline: false });

    const hookRes = await fetch(HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "📊 FGO 助戰資料庫 · 每日報表",
          url: SITE,
          color: 0x5f97f6,
          fields,
          footer: { text: `近90天瀏覽 ${n(s.views_total)} ・ 訪客 ${n(s.visitors_total)}` },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    if (!hookRes.ok) console.error("discord webhook", hookRes.status, (await hookRes.text()).slice(0, 300));
    return new Response("ok");
  } catch (e) {
    console.error("daily-stats", e);
    return new Response("error logged", { status: 200 });
  }
});
