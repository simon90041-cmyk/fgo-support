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
function ceLb(lb: number): string {
  return lb === 4 ? "（滿破）" : lb > 0 ? `（${lb}突）` : "";
}
function fmtBoard(r: any): string {
  const parts: string[] = [`👤 **${r.friend_code}**（${SRV[r.server] || r.server}）${r.note ? ` · 📝${r.note}` : ""}`];
  for (const bk of Object.keys(r.boards || {})) {
    for (const sk of Object.keys(r.boards[bk])) {
      const sl = r.boards[bk][sk];
      parts.push(`　${sName(sl.servant)} NP${sl.np}·Lv${sl.level || "?"}·技${(sl.skills || []).join("/")}${sl.ce ? `·${sl.ce.tw || sl.ce.cn || sl.ce.en || ""}${ceLb(sl.ce.lb)}` : ""}`);
    }
  }
  return parts.join("\n");
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
        ? myRows.map(fmtBoard).join("\n\n")
        : `你還沒有登記助戰板。\n到網站用 Discord 登入後登記：${SITE}`;
      const d: any = { content: content.slice(0, 1900) };
      if (priv) d.flags = 64;
      return Response.json({ type: 4, data: d });
    }

    // /fgo （搜尋）
    const q = String(opts.servant || "").trim().toLowerCase();
    const code = String(opts.code || "").replace(/\D/g, "");
    const server = String(opts.server || "");
    let url = `${SB_URL}/rest/v1/entries?select=server,friend_code,note,boards&order=created_at.desc`;
    if (server) url += `&server=eq.${server}`;
    const res = await fetch(url, { headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}` } });
    const rows: any[] = await res.json();

    if (code) {
      const hit = rows.find((rr) => String(rr.friend_code).replace(/\D/g, "") === code);
      content = hit ? fmtBoard(hit) : `找不到好友編號 ${opts.code}。`;
    } else if (q) {
      const matches: any[] = [];
      for (const rr of rows) {
        for (const bk of Object.keys(rr.boards || {})) {
          for (const sk of Object.keys(rr.boards[bk])) {
            const sl = rr.boards[bk][sk];
            const names = [sl.servant?.cn, sl.servant?.en, sl.servant?.ja, sl.servant?.tw, sl.servant?.className]
              .map((x: string) => (x || "").toLowerCase());
            if (names.some((n) => n.includes(q))) matches.push({ r: rr, sl });
          }
        }
      }
      content = matches.length
        ? `🔍 含「${opts.servant}」的助戰（${matches.length} 筆${matches.length > 10 ? "，顯示前 10" : ""}）\n\n` +
          matches.slice(0, 10).map((m) =>
            `**${m.r.friend_code}**（${SRV[m.r.server] || m.r.server}）— ${sName(m.sl.servant)} NP${m.sl.np}·Lv${m.sl.level || "?"}${m.r.note ? ` · 📝${m.r.note}` : ""}`
          ).join("\n")
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
