// Supabase Edge Function: Discord Interactions endpoint for FGO 助戰資料庫
// Deploy as function name "discord" with Verify JWT = OFF.
import nacl from "npm:tweetnacl@1.0.3";

const PUBLIC_KEY = "22717faeb80b0f2d1896775d97d0d7f658f0f6737885d38c232b5fd08d5178be";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = "https://simon90041-cmyk.github.io/fgo-support/";

function hex2bytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

const SRV: Record<string, string> = { JP: "日服", NA: "美服", TW: "台服", CN: "國服" };

function sName(s: any): string {
  if (!s) return "?";
  const cn = s.tw || s.cn;
  if (cn) return s.en && s.en !== cn ? `${cn}（${s.en}）` : cn;
  return s.en || s.ja || "?";
}
function ceN(c: any): string {
  return c ? (c.tw || c.cn || c.en || c.ja || "") : "";
}
function ceLb(lb: number): string {
  return lb === 4 ? "（滿破）" : lb > 0 ? `（${lb}突）` : "";
}
function ago(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}分前`;
  if (d < 86400) return `${Math.floor(d / 3600)}小時前`;
  return `${Math.floor(d / 86400)}天前`;
}

/** 卡片標題：編號・伺服器・好友狀態・讚數・更新時間・註記 */
function headerOf(r: any): string {
  const status = r.is_full ? "🔴好友已滿" : "🟢徵求好友";
  const likes = r.like_count ? ` · 👍${r.like_count}` : "";
  const upd = r.updated_at ? ` · 🕒${ago(r.updated_at)}` : "";
  const note = r.note ? ` · 📝${r.note}` : "";
  return `👤 **${r.friend_code}**（${SRV[r.server] || r.server}）${status}${likes}${upd}${note}`;
}

/** 單一格位：冠位👑・稀有度★・NP/Lv/技能/AS・最多 3 張禮裝 */
function slotLine(sl: any): string {
  const stars = "★".repeat(sl.servant?.rarity || 0);
  const np = Number(sl.np) >= 5 ? "**NP5**" : `NP${sl.np}`;
  const lvNum = Number(sl.level) || 0;
  const lv = lvNum >= 100 ? `**Lv${lvNum}**` : `Lv${sl.level || "?"}`;
  const asArr = sl.as || [];
  const as = asArr.some((x: number) => x > 0) ? `·AS${asArr.join("/")}` : "";
  const crown = sl.grand ? "👑" : "";
  const ces: string[] = [];
  if (sl.ce) ces.push(`🎴${ceN(sl.ce)}${ceLb(sl.ce.lb)}`);
  if (sl.ceBond) ces.push(`🎴${ceN(sl.ceBond)}${sl.ceBond.mode === "np50" ? "[初始50NP]" : ""}`);
  if (sl.ceBonus) ces.push(`🎴${ceN(sl.ceBonus)}`);
  const head = `　${crown}${stars} ${sName(sl.servant)} ${np}·${lv}·技${(sl.skills || []).join("/")}${as}`;
  return ces.length ? `${head}\n　　${ces.join(" · ")}` : head;
}

function allSlots(r: any): any[] {
  const out: any[] = [];
  for (const bk of Object.keys(r.boards || {})) {
    for (const sk of Object.keys(r.boards[bk] || {})) out.push(r.boards[bk][sk]);
  }
  return out;
}

function fmtBoard(r: any, maxSlots = 18): string {
  const slots = allSlots(r);
  const lines = [headerOf(r), ...slots.slice(0, maxSlots).map(slotLine)];
  if (slots.length > maxSlots) lines.push(`　…還有 ${slots.length - maxSlots} 位，完整內容看網站：${SITE}`);
  return lines.join("\n");
}

/** 讀取登記：優先用 entries_view（含讚數），失敗退回 entries */
async function fetchRows(server: string): Promise<any[]> {
  const q = server ? `&server=eq.${server}` : "";
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/entries_view?select=*&order=like_count.desc,created_at.desc${q}`,
      { headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}` } },
    );
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j)) return j;
    }
  } catch { /* fall through */ }
  const r2 = await fetch(
    `${SB_URL}/rest/v1/entries?select=*&order=created_at.desc${q}`,
    { headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}` } },
  );
  const j2 = await r2.json();
  return Array.isArray(j2) ? j2 : [];
}

Deno.serve(async (req) => {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts = req.headers.get("X-Signature-Timestamp");
  const body = await req.text();
  if (!sig || !ts) return new Response("missing signature", { status: 401 });
  const valid = nacl.sign.detached.verify(
    new TextEncoder().encode(ts + body),
    hex2bytes(sig),
    hex2bytes(PUBLIC_KEY),
  );
  if (!valid) return new Response("invalid signature", { status: 401 });

  const interaction = JSON.parse(body);
  if (interaction.type === 1) return Response.json({ type: 1 }); // PING

  if (interaction.type === 2) {
    const cmd = interaction.data.name;
    const opts: Record<string, any> = {};
    for (const o of interaction.data.options || []) opts[o.name] = o.value;
    const priv = opts.private === true;
    let content = "";

    if (cmd === "fgo_me") {
      const discordId = interaction.member?.user?.id || interaction.user?.id;
      const r = await fetch(`${SB_URL}/rest/v1/rpc/get_my_entries`, {
        method: "POST",
        headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_discord_id: discordId }),
      });
      const myRows: any[] = await r.json();
      content = Array.isArray(myRows) && myRows.length
        ? myRows.map((x) => fmtBoard(x)).join("\n\n")
        : `你還沒有登記助戰板。\n到網站用 Discord 登入後登記：${SITE}`;
      const d: any = { content: content.slice(0, 1900) };
      if (priv) d.flags = 64;
      return Response.json({ type: 4, data: d });
    }

    // /fgo （搜尋）
    const q = String(opts.servant || "").trim().toLowerCase();
    const code = String(opts.code || "").replace(/\D/g, "");
    const server = String(opts.server || "");
    const rows = await fetchRows(server);

    if (code) {
      const hit = rows.find((rr) => String(rr.friend_code).replace(/\D/g, "") === code);
      content = hit ? fmtBoard(hit, 30) : `找不到好友編號 ${opts.code}。`;
    } else if (q) {
      const matches: any[] = [];
      for (const rr of rows) {
        for (const sl of allSlots(rr)) {
          const names = [sl.servant?.cn, sl.servant?.en, sl.servant?.ja, sl.servant?.tw, sl.servant?.className]
            .map((x: string) => (x || "").toLowerCase());
          if (names.some((n) => n.includes(q))) matches.push({ r: rr, sl });
        }
      }
      content = matches.length
        ? `🔍 含「${opts.servant}」的助戰（${matches.length} 筆${matches.length > 10 ? "，依讚數顯示前 10" : ""}）\n\n` +
          matches.slice(0, 10).map((m) => {
            const st = m.r.is_full ? "🔴滿" : "🟢徵";
            const lk = m.r.like_count ? ` 👍${m.r.like_count}` : "";
            const up = m.r.updated_at ? ` 🕒${ago(m.r.updated_at)}` : "";
            return `${st} **${m.r.friend_code}**（${SRV[m.r.server] || m.r.server}）${lk}${up}\n` + slotLine(m.sl);
          }).join("\n")
        : `找不到含「${opts.servant}」的助戰。`;
    } else {
      content = "用法：/fgo servant:<從者名> 或 /fgo code:<好友編號>；查自己的用 /fgo_me。";
    }

    const data: any = { content: content.slice(0, 1900) };
    if (priv) data.flags = 64;
    return Response.json({ type: 4, data });
  }

  return Response.json({ type: 4, data: { content: "？" } });
});
