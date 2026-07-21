// Supabase Edge Function: Discord Interactions endpoint for FGO 助戰資料庫
// Deploy as function name "discord" with Verify JWT = OFF.
import nacl from "npm:tweetnacl@1.0.3";

const PUBLIC_KEY = "22717faeb80b0f2d1896775d97d0d7f658f0f6737885d38c232b5fd08d5178be";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = "https://simon90041-cmyk.github.io/fgo-support/";
// 一鍵腳本的存放位置（GitHub Pages 直接把 .sh 當純文字送出即可）。
// 換自訂網域時只改這裡；務必是可被玩家先下載檢視的靜態檔。
const SCRIPT_BASE = "https://simon90041-cmyk.github.io/fgo-support";

// /bind 用：6 碼驗證碼（排除易混淆字元）+ 不可猜 token，皆用密碼學安全亂數
function randPick(alphabet: string, n: number): string {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}
const genCode = () => randPick("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
function genToken(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
// service_role 呼叫 RPC
async function svcRpc(fn: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return r.ok ? r.json() : null;
}
const eph = (content: string) => Response.json({ type: 4, data: { content, flags: 64 } });

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

const BOARD_LABEL: Record<string, string> = {
  main: "主要", ex1: "額外Ⅰ", ex2: "額外Ⅱ", ev1: "活動Ⅰ", ev2: "活動Ⅱ", ev3: "活動Ⅲ",
};
const GREEN = 0x4caf50, RED = 0xd3453b;

// boards 是使用者可任意寫入的 JSON。名稱可能含 Discord markdown 或超長字串，
// 會破壞 embed（1024/欄・6000/則上限）或偽造 bot 輸出 → 一律去特殊字元 + 截斷
const clean = (v: unknown, n = 40) =>
  String(v ?? "").replace(/[`*_~|>@\\]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const safeNum = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const safeArr = (a: unknown, n = 10) =>
  (Array.isArray(a) ? a : []).slice(0, n).map((x) => safeNum(x)).join("/");

/** 一行從者：稀有度★・名稱・NP/Lv/技能/AS（全部欄位皆已清洗） */
function svtLine(sl: any): string {
  const stars = "★".repeat(Math.min(5, Math.max(0, safeNum(sl.servant?.rarity))));
  const npN = safeNum(sl.np);
  const np = npN >= 5 ? "**NP5**" : `NP${npN > 0 ? npN : "?"}`;
  const lvNum = safeNum(sl.level);
  const lv = lvNum >= 100 ? `**Lv${lvNum}**` : `Lv${lvNum > 0 ? lvNum : "?"}`;
  const asArr = (Array.isArray(sl.as) ? sl.as : []);
  const as = asArr.some((x: number) => safeNum(x) > 0) ? ` ｜ AS ${safeArr(asArr, 5)}` : "";
  const crown = sl.grand ? "👑 " : "";
  const ces: string[] = [];
  if (sl.ce) ces.push(`${clean(ceN(sl.ce))}${ceLb(sl.ce.lb)}`);
  if (sl.ceBond) ces.push(`${clean(ceN(sl.ceBond))}${sl.ceBond.mode === "np50" ? "「初始50NP」" : ""}`);
  if (sl.ceBonus) ces.push(`${clean(ceN(sl.ceBonus))}`);
  const ceLine = ces.length ? `\n┗ 🎴 ${ces.join(" ／ ")}` : "";
  return `${crown}\`${stars}\` **${clean(sName(sl.servant), 60)}**\n┣ ${np} ｜ ${lv} ｜ 技 ${safeArr(sl.skills, 3)}${as}${ceLine}`;
}

function allSlots(r: any): any[] {
  const out: any[] = [];
  for (const bk of Object.keys(r.boards || {})) {
    for (const sk of Object.keys(r.boards[bk] || {})) out.push({ ...r.boards[bk][sk], _b: bk });
  }
  return out;
}

function statusLine(r: any): string {
  const bits = [
    `\`${SRV[r.server] || r.server}\``,
    r.is_full ? "🔴 好友已滿" : "🟢 徵求好友",
  ];
  if (r.like_count) bits.push(`👍 ${r.like_count}`);
  if (r.updated_at) bits.push(`🕒 ${ago(r.updated_at)}`);
  let s = bits.join("　");
  if (r.note) s += `\n📝 ${r.note}`;
  return s;
}

/** 一筆登記 → 一個 embed，依「支援欄」分組成 field */
function entryEmbed(r: any) {
  const slots = allSlots(r);
  const groups: Record<string, any[]> = {};
  for (const sl of slots) (groups[sl._b] ||= []).push(sl);

  const fields: any[] = [];
  let shown = 0;
  for (const bk of Object.keys(BOARD_LABEL)) {
    const g = groups[bk];
    if (!g || !g.length) continue;
    const lines: string[] = [];
    for (const sl of g) {
      const line = svtLine(sl);
      if (lines.join("\n").length + line.length > 950) { lines.push("…"); break; }
      lines.push(line);
      shown++;
    }
    fields.push({ name: `▬ ${BOARD_LABEL[bk]}（${g.length}）`, value: (lines.join("\n") || "—").slice(0, 1024), inline: false });
    if (fields.length >= 6) break;
  }
  if (!fields.length) fields.push({ name: "　", value: "（尚未登記從者）", inline: false });

  return {
    title: `👤 ${safeCode(r.friend_code)}`,
    url: SITE,
    color: r.is_full ? RED : GREEN,
    description: statusLine(r),
    fields,
    footer: { text: shown < slots.length ? `顯示 ${shown}/${slots.length} 位・完整內容看網站` : `共 ${slots.length} 位` },
  };
}

// Discord 上限：欄位值 1024、欄名 256、整則所有 embed 相加 6000。超過整則被 400 退掉。
const clampVal = (s: string) => (s.length > 1024 ? s.slice(0, 1010) + "…" : s);

/** 搜尋結果 → 單一 embed，每筆一個 field（每欄截斷 + note 清洗） */
function searchEmbed(kw: string, matches: any[]) {
  const top = matches.slice(0, 8);
  return {
    title: `🔍 含「${clean(kw, 40)}」的助戰`,
    url: SITE,
    color: GREEN,
    description: `找到 **${matches.length}** 筆${matches.length > top.length ? `，依讚數顯示前 ${top.length}` : ""}`,
    fields: top.map((m) => ({
      name: clampName(`${m.r.is_full ? "🔴" : "🟢"} ${safeCode(m.r.friend_code)}　\`${SRV[m.r.server] || "?"}\`${m.r.like_count ? `　👍${safeNum(m.r.like_count)}` : ""}`),
      value: clampVal(svtLine(m.sl) + (m.r.note ? `\n📝 ${clean(m.r.note, 60)}` : "")),
      inline: false,
    })),
    footer: { text: "點標題到網站看完整助戰板" },
  };
}
const clampName = (s: string) => (s.length > 256 ? s.slice(0, 250) + "…" : s);
const safeCode = (c: unknown) => String(c ?? "").replace(/[^\d,]/g, "").slice(0, 20) || "?";

// 把多個 embed 塞進 6000 字總預算內，超過就丟掉尾端並附註
function fitEmbeds(embeds: any[], note = "…內容過長，其餘請看網站"): any[] {
  const out: any[] = [];
  let total = 0;
  for (const e of embeds) {
    const size = JSON.stringify(e).length;
    if (total + size > 5500) break;
    out.push(e);
    total += size;
  }
  if (!out.length && embeds.length) {           // 單一 embed 就爆 → 硬砍 fields
    const e = { ...embeds[0], fields: (embeds[0].fields || []).slice(0, 3) };
    e.footer = { text: note };
    out.push(e);
  }
  return out;
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

  let interaction: any;
  try { interaction = JSON.parse(body); }
  catch { return new Response("bad request", { status: 400 }); }
  if (interaction.type === 1) return Response.json({ type: 1 }); // PING

  try {
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
      const d: any = (Array.isArray(myRows) && myRows.length)
        ? { embeds: fitEmbeds(myRows.slice(0, 4).map(entryEmbed)) }
        : { content: `你還沒有登記助戰板。\n到網站用 Discord 登入後登記：${SITE}` };
      if (priv) d.flags = 64;
      return Response.json({ type: 4, data: d });
    }

    const discordId = interaction.member?.user?.id || interaction.user?.id;

    // /fgo_bind：直接登記好友編號（免驗證）。助戰由後端自動同步。
    if (cmd === "fgo_bind") {
      const bserver = String(opts.server || "").toUpperCase();
      const bcode = String(opts.code || "").replace(/\D/g, "");
      if (!SRV[bserver]) return eph("請選擇伺服器（JP／NA／TW／CN）。");
      if (bcode.length < 6) return eph("請輸入正確的好友編號（純數字）。");
      const res = await svcRpc("bot_register_code", {
        p_discord_id: discordId, p_server: bserver, p_friend_code: bcode,
      });
      if (!res?.ok) {
        if (res?.reason === "needs_login")
          return eph(`登記前請先用 **Discord 登入網站一次**（建立你的帳號）：\n${SITE}\n登入後再回來執行 /fgo_bind。`);
        if (res?.reason === "code_taken")
          return eph("這個好友編號已被登記於同伺服器。若是你的，請到網站檢舉處理。");
        return eph("登記失敗，請稍後再試 🙏");
      }
      return eph(
        `✅ **已登記 ${SRV[bserver]}｜${safeCode(bcode)}**\n` +
        "你的助戰會**自動同步**（通常隔天更新），不用再做任何事。\n" +
        `到網站查看：${SITE}\n有問題可在網站檢舉。`,
      );
    }

    // /fgo_update：現在全自動，不需玩家操作
    if (cmd === "fgo_update") {
      return eph(
        "🔄 **助戰是自動同步的**，你不用做任何事——登記後系統會定期自動更新你的助戰板。\n" +
        `查看：${SITE}`,
      );
    }

    // /fgo_profile：顯示綁定狀態與各伺服器登記
    if (cmd === "fgo_profile") {
      const p = await svcRpc("bot_profile", { p_discord_id: discordId });
      if (!p?.ok) return eph(p?.reason === "needs_login"
        ? `你還沒用 Discord 登入過網站。先到 ${SITE} 登入即完成綁定。`
        : "查詢失敗，請稍後再試 🙏");
      const entries: any[] = Array.isArray(p.entries) ? p.entries : [];
      if (!entries.length) return eph(`你已登入網站但尚未登記助戰板。到 ${SITE} 或用 /fgo_bind 登記。`);
      const lines = entries.map((e) =>
        `\`${SRV[e.server] || e.server}\`　${safeCode(e.friend_code)}　${e.is_full ? "🔴已滿" : "🟢徵求"}　${safeNum(e.slots)} 位　🕒${ago(e.updated_at)}`);
      const bound = Array.isArray(p.devices) && p.devices.length
        ? `\n📱 已綁定腳本：${p.devices.map((s: string) => SRV[s] || s).join("、")}` : "";
      return eph(`👤 **你的登記**\n${lines.join("\n")}${bound}`);
    }

    // /fgo_unbind：解除某伺服器的綁定 + 刪除該登記
    if (cmd === "fgo_unbind") {
      const userver = String(opts.server || "").toUpperCase();
      if (!SRV[userver]) return eph("請選擇要解除綁定的伺服器（JP／NA／TW／CN）。");
      const r = await svcRpc("bot_unbind", { p_discord_id: discordId, p_server: userver });
      if (!r?.ok) return eph(r?.reason === "needs_login"
        ? "查無你的帳號，可能未曾登入網站。" : "解除失敗，請稍後再試 🙏");
      return eph(r.deleted ? `已解除 ${SRV[userver]} 的綁定並刪除該登記。` : `${SRV[userver]} 沒有可解除的登記。`);
    }

    // /fgo （搜尋）
    const q = String(opts.servant || "").trim().toLowerCase();
    const code = String(opts.code || "").replace(/\D/g, "");
    const server = String(opts.server || "");
    const rows = await fetchRows(server);

    let data: any;
    if (code) {
      const hit = rows.find((rr) => String(rr.friend_code).replace(/\D/g, "") === code);
      data = hit ? { embeds: fitEmbeds([entryEmbed(hit)]) } : { content: `找不到好友編號 ${safeCode(opts.code)}。` };
    } else if (q) {
      const matches: any[] = [];
      for (const rr of rows) {
        for (const sl of allSlots(rr)) {
          const names = [sl.servant?.cn, sl.servant?.en, sl.servant?.ja, sl.servant?.tw, sl.servant?.className]
            .map((x: string) => (x || "").toLowerCase());
          if (names.some((n) => n.includes(q))) matches.push({ r: rr, sl });
        }
      }
      data = matches.length
        ? { embeds: fitEmbeds([searchEmbed(String(opts.servant), matches)]) }
        : { content: `找不到含「${clean(opts.servant, 40)}」的助戰。` };
    } else {
      content = "用法：`/fgo servant:<從者名>` 或 `/fgo code:<好友編號>`；查自己的用 `/fgo_me`。";
      data = { content };
    }

    if (priv) data.flags = 64;
    return Response.json({ type: 4, data });
  }

  return Response.json({ type: 4, data: { content: "？" } });
  } catch (e) {
    console.error("interaction error", e);
    return Response.json({ type: 4, data: { content: "查詢暫時失敗，請稍後再試 🙏", flags: 64 } });
  }
});
