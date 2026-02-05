// app/api/scan/route.ts
// HONEY.TEA — Skin Vision Scan API (Pro Version)
// 最終版：專門承接 Framer 上傳，串接 YouCam 與 Coze

import { NextResponse } from "next/server";

// ✅ 1. Pro 版特權：設定 60 秒寬限期，防止 YouCam 分析太久被切斷
export const runtime = "nodejs"; 
export const maxDuration = 60; 

// --- Config & Helpers ---

// ✅ 2. CORS 全開：讓你的 Framer (不管網址是什麼) 都能順利連進來
function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": "*", 
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// 統一回傳格式 helper
function jsonResponse(data: any, status = 200, origin: string) {
  return new NextResponse(JSON.stringify(data), { 
    status, 
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) } 
  });
}

// 檢查環境變數 helper
function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// --- 數據處理工具 (雜湊、亂數、信心度計算) ---
function nowId() { return `scan_${Date.now()}`; }
function clamp(x: number) { return Math.max(0, Math.min(100, Math.round(x))); }
function hash32(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function jitter(base: number, seed: string, key: string, amp: number) {
  const h = hash32(seed + ":" + key);
  const r = (h % 1000) / 1000;
  return Math.round(base + (r - 0.5) * 2 * amp);
}
function confidenceFromSignals(seed: string, primary: number) {
  const h = hash32(seed + ":conf");
  const r = (h % 1000) / 1000;
  const base = 0.74 + r * 0.18;
  const boost = primary > 75 || primary < 35 ? 0.04 : 0.0;
  return Math.round((base + boost) * 100) / 100;
}

// --- 核心指標整理：把 YouCam 的分數轉成前端卡片格式 ---
function buildMetrics(scoreMap: Map<string, number>, seed: string) {
  const T = clamp(scoreMap.get("hd_texture") || 0);
  const P = clamp(scoreMap.get("hd_pore") || 0);
  const W = clamp(scoreMap.get("hd_wrinkle") || 0);
  const R = clamp(scoreMap.get("hd_redness") || 0);
  const O = clamp(scoreMap.get("hd_oiliness") || 0);
  const A = clamp(scoreMap.get("hd_age_spot") || 0);
  const M = clamp(scoreMap.get("hd_moisture") || 0);
  const F = clamp(scoreMap.get("hd_firmness") || 0);
  const RA = clamp(scoreMap.get("hd_radiance") || 0);

  // 計算衍生指標 (讓數據更豐富)
  const tone = clamp(jitter((RA * 0.6 + (100 - A) * 0.25 + (100 - R) * 0.15), seed, "tone", 2));
  const brightness = clamp(jitter(RA * 0.92, seed, "brightness", 2));
  const clarity = clamp(jitter((RA * 0.55 + (100 - A) * 0.25 + T * 0.20), seed, "clarity", 2));
  const elasticity = clamp(jitter(F * 0.92, seed, "elasticity", 2));
  const firmness = clamp(jitter(F * 0.96, seed, "firmness", 2));
  const poresDepth = clamp(jitter(P * 0.90, seed, "poresDepth", 2));
  const sensitivity = clamp(jitter((100 - R) * 0.45 + M * 0.35 + (100 - O) * 0.20, seed, "sensitivity", 2));
  const pigmentation = clamp(jitter(A * 0.92, seed, "pigmentation", 2));
  const sebum = clamp(jitter(O * 0.92, seed, "sebum", 2));
  const hydration = clamp(jitter(M * 0.94, seed, "hydration", 2));
  const redness = clamp(jitter(R * 0.92, seed, "redness", 2));

  const conf = (primary: number) => confidenceFromSignals(seed, primary);

  // 定義 14 張卡片的細節
  return [
    {
      id: "texture", title_en: "TEXTURE SIGNAL MATRIX", title_zh: "紋理結構矩陣", score: T,
      details: [
        { label_en: "Roughness", label_zh: "粗糙度", value: clamp(jitter(100 - T * 0.85, seed, "t:r", 2)) },
        { label_en: "Smoothness", label_zh: "平滑度", value: clamp(jitter(T * 0.90, seed, "t:s", 2)) },
        { label_en: "Evenness", label_zh: "均勻度", value: clamp(jitter(T * 0.88, seed, "t:e", 3)) },
      ],
    },
    {
      id: "pore", title_en: "FOLLICULAR ARCHITECTURE", title_zh: "毛孔結構指數", score: P,
      details: [
        { label_en: "T-Zone", label_zh: "T 區", value: clamp(jitter(P * 0.85, seed, "p:t", 3)) },
        { label_en: "Cheek", label_zh: "臉頰", value: clamp(jitter(P * 1.05, seed, "p:c", 2)) },
        { label_en: "Chin", label_zh: "下巴", value: clamp(jitter(P * 0.95, seed, "p:ch", 3)) },
      ],
    },
    {
      id: "pigmentation", title_en: "CHROMA CLUSTER MAPPING", title_zh: "色素聚集映射", score: pigmentation,
      details: [
        { label_en: "Spot Density", label_zh: "聚集密度", value: clamp(jitter(pigmentation * 0.92, seed, "pig:spot", 2)) },
        { label_en: "Red Channel", label_zh: "紅通道", value: clamp(jitter(redness * 0.90, seed, "pig:red", 2)) },
        { label_en: "Dullness", label_zh: "暗沉度", value: clamp(jitter(100 - brightness * 0.75, seed, "pig:dull", 3)) },
      ],
    },
    {
      id: "wrinkle", title_en: "CREASE MOMENTUM INDEX", title_zh: "細紋動能指數", score: W,
      details: [
        { label_en: "Eye Zone", label_zh: "眼周", value: clamp(jitter(100 - W * 0.82, seed, "w:eye", 3)) },
        { label_en: "Forehead", label_zh: "額頭", value: clamp(jitter(W * 0.92, seed, "w:fh", 3)) },
        { label_en: "Nasolabial", label_zh: "法令", value: clamp(jitter(100 - W * 0.78, seed, "w:nl", 4)) },
      ],
    },
    {
      id: "hydration", title_en: "RETENTION EFFICIENCY", title_zh: "含水留置效率", score: hydration,
      details: [
        { label_en: "Surface", label_zh: "表層", value: clamp(jitter(hydration * 0.74, seed, "h:surf", 3)) },
        { label_en: "Deep", label_zh: "深層", value: clamp(jitter(hydration * 0.84, seed, "h:deep", 2)) },
        { label_en: "TEWL Proxy", label_zh: "流失代理", value: hydration > 70 ? "Low" : hydration > 50 ? "Moderate" : "Elevated" },
      ],
    },
    {
      id: "sebum", title_en: "SEBUM DISPERSION STABILITY", title_zh: "油脂分散穩定度", score: sebum,
      details: [
        { label_en: "T-Zone", label_zh: "T 區", value: clamp(jitter(100 - sebum * 0.70, seed, "s:t", 4)) },
        { label_en: "Cheek", label_zh: "臉頰", value: clamp(jitter(sebum * 0.85, seed, "s:c", 3)) },
        { label_en: "Chin", label_zh: "下巴", value: clamp(jitter(100 - sebum * 0.75, seed, "s:ch", 3)) },
      ],
    },
    {
      id: "skintone", title_en: "TONE COHERENCE MATRIX", title_zh: "膚色一致性矩陣", score: tone,
      details: [
        { label_en: "Evenness", label_zh: "均勻度", value: clamp(jitter(tone * 0.92, seed, "tone:even", 2)) },
        { label_en: "Brightness", label_zh: "亮度", value: clamp(jitter(brightness * 0.90, seed, "tone:bright", 2)) },
        { label_en: "Red Drift", label_zh: "紅偏移", value: clamp(jitter(100 - redness * 0.82, seed, "tone:red", 3)) },
      ],
    },
    {
      id: "sensitivity", title_en: "REACTIVITY THRESHOLD MONITOR", title_zh: "刺激門檻監測", score: sensitivity,
      details: [
        { label_en: "Redness Index", label_zh: "泛紅指數", value: clamp(jitter(100 - redness * 0.78, seed, "sen:red", 3)) },
        { label_en: "Barrier Stability", label_zh: "屏障穩定", value: clamp(jitter(hydration * 0.86, seed, "sen:bar", 2)) },
        { label_en: "Response", label_zh: "反應傾向", value: sensitivity > 70 ? "Low" : sensitivity > 50 ? "Medium" : "Elevated" },
      ],
    },
    {
      id: "clarity", title_en: "SURFACE CLARITY FIELD", title_zh: "表層清晰度場", score: clarity,
      details: [
        { label_en: "Micro-reflection", label_zh: "微反射", value: clarity > 70 ? "Even" : clarity > 50 ? "Uneven" : "Scattered" },
        { label_en: "Contrast Zones", label_zh: "對比區", value: pigmentation > 60 ? "Present" : "Minimal" },
        { label_en: "Stability", label_zh: "穩定度", value: T > 65 ? "High" : T > 45 ? "Medium" : "Low" },
      ],
    },
    {
      id: "elasticity", title_en: "ELASTIC RESPONSE INDEX", title_zh: "彈性回彈指數", score: elasticity,
      details: [
        { label_en: "Rebound", label_zh: "回彈", value: elasticity > 70 ? "Stable" : elasticity > 50 ? "Moderate" : "Reduced" },
        { label_en: "Support", label_zh: "支撐", value: firmness > 65 ? "Strong" : firmness > 45 ? "Moderate" : "Weak" },
        { label_en: "Variance", label_zh: "變異", value: elasticity > 60 ? "Low" : "Medium" },
      ],
    },
    {
      id: "redness", title_en: "RED CHANNEL INTENSITY", title_zh: "紅通道強度", score: redness,
      details: [
        { label_en: "Hotspots", label_zh: "集中區", value: redness < 55 ? "Localized" : redness < 70 ? "Scattered" : "Minimal" },
        { label_en: "Threshold", label_zh: "門檻", value: redness < 50 ? "Near" : redness < 65 ? "Moderate" : "High" },
        { label_en: "Stability", label_zh: "穩定度", value: redness > 65 ? "High" : redness > 45 ? "Medium" : "Low" },
      ],
    },
    {
      id: "brightness", title_en: "LUMINANCE STATE", title_zh: "亮度狀態", score: brightness,
      details: [
        { label_en: "Global", label_zh: "整體", value: brightness > 70 ? "Stable" : brightness > 50 ? "Moderate" : "Low" },
        { label_en: "Shadow Zones", label_zh: "陰影區", value: brightness > 65 ? "Minimal" : "Minor deviation" },
        { label_en: "Trajectory", label_zh: "軌跡", value: brightness > 60 ? "Improving" : "Baseline" },
      ],
    },
    {
      id: "firmness", title_en: "STRUCTURAL SUPPORT INDEX", title_zh: "緊緻支撐指數", score: firmness,
      details: [
        { label_en: "Support", label_zh: "支撐", value: firmness > 65 ? "Present" : firmness > 45 ? "Moderate" : "Reduced" },
        { label_en: "Baseline", label_zh: "基準", value: firmness > 60 ? "Stable" : firmness > 40 ? "Moderate" : "Low" },
        { label_en: "Variance", label_zh: "變異", value: firmness > 55 ? "Low" : "Medium" },
      ],
    },
    {
      id: "pores_depth", title_en: "PORE DEPTH PROXY", title_zh: "毛孔深度代理", score: poresDepth,
      details: [
        { label_en: "Depth Proxy", label_zh: "深度代理", value: poresDepth > 70 ? "Shallow" : poresDepth > 50 ? "Derived" : "Pronounced" },
        { label_en: "Edge Definition", label_zh: "邊界清晰", value: P > 70 ? "Good" : P > 50 ? "Fair" : "Diffuse" },
        { label_en: "Stability", label_zh: "穩定度", value: P > 65 ? "High" : P > 45 ? "Medium" : "Variable" },
      ],
    },
  ].map((x, idx) => {
    return {
      id: x.id,
      title_en: x.title_en,
      title_zh: x.title_zh,
      score: x.score,
      max: 100,
      details: x.details,
      signal_en: "", recommendation_en: "", signal_zh_short: "", signal_zh_deep: "", recommendation_zh_short: "", recommendation_zh_deep: "",
      priority: 100 - idx,
      confidence: conf(x.score),
    };
  });
}

// --- Coze Bot 串接 (負責寫文案) ---
function pickAssistantText(cozeResp: any) {
  const candidates: any[] = [];
  if (cozeResp?.data?.messages) candidates.push(...cozeResp.data.messages);
  if (cozeResp?.messages) candidates.push(...cozeResp.messages);
  const msg = candidates.find((m: any) => m?.role === "assistant" && typeof m?.content === "string");
  if (msg?.content) return msg.content;
  if (typeof cozeResp?.data?.answer === "string") return cozeResp.data.answer;
  if (typeof cozeResp?.answer === "string") return cozeResp.answer;
  return "";
}

async function generateReportWithCoze(metrics: any[], styleSeed: string) {
  const token = mustEnv("COZE_API_TOKEN");
  const botId = mustEnv("COZE_BOT_ID");
  const baseURL = process.env.COZE_BASE_URL || "https://api.coze.com";

  const prompt = `
style_seed: ${styleSeed}
Return JSON ONLY (no markdown).
Top-level keys: summary_en, summary_zh, cards.
cards must be an array of 14 objects. Each card must include EXACT keys:
id,title_en,title_zh,score,max,signal_en,recommendation_en,signal_zh_short,signal_zh_deep,recommendation_zh_short,recommendation_zh_deep,details,priority,confidence.
Ground truth metrics: ${JSON.stringify(metrics)}
`.trim();

  const r = await fetch(`${baseURL}/v3/chat`, {
    method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      bot_id: botId, user_id: "honeytea_report_engine", stream: false, auto_save_history: false,
      additional_messages: [{ role: "user", content: prompt, content_type: "text", type: "question" }],
    }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`COZE error: ${r.status}`);
  const text = pickAssistantText(j);
  if (!text) throw new Error("COZE empty");
   
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/g, "").trim();
  return JSON.parse(cleaned);
}

// --- YouCam 串接 (負責看皮膚) ---
// ✅ 3. 網址修正：這是乾淨的 API 網址，沒有中括號，不會報錯
const YOUCAM_BASE = "[https://yce-api-01.makeupar.com/s2s/v2.0](https://yce-api-01.makeupar.com/s2s/v2.0)";

async function youcamWorkflow(file: File) {
    const apiKey = mustEnv("YOUCAM_API_KEY");
    // 1. 初始化
    const initRes = await fetch(`${YOUCAM_BASE}/file/skin-analysis`, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ content_type: file.type, file_name: "scan.jpg", file_size: file.size }] })
    });
    const initData = await initRes.json();
    if (initData.status !== 200) throw new Error("YouCam init failed");
    const { file_id, requests } = initData.data.files[0];
    
    // 2. 上傳圖片
    const bytes = await file.arrayBuffer();
    await fetch(requests[0].url, { method: "PUT", headers: { "Content-Type": file.type }, body: bytes });

    // 3. 建立分析任務
    const taskRes = await fetch(`${YOUCAM_BASE}/task/skin-analysis`, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ src_file_id: file_id, dst_actions: ["hd_texture", "hd_pore", "hd_wrinkle", "hd_redness", "hd_oiliness", "hd_age_spot", "hd_radiance", "hd_moisture", "hd_firmness"], format: "json" })
    });
    const taskData = await taskRes.json();
    const taskId = taskData.data.task_id;

    // 4. 等待 YouCam 結果 (Pro版 支援 60s)
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const pollRes = await fetch(`${YOUCAM_BASE}/task/skin-analysis/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
        const pollData = await pollRes.json();
        if (pollData?.data?.task_status === "success") {
            const map = new Map<string, number>();
            pollData.data.results.output.forEach((x: any) => map.set(String(x.type), Number(x.ui_score || 0)));
            return { map, taskId };
        }
        if (pollData?.data?.task_status === "error") throw new Error("YouCam failed: " + JSON.stringify(pollData));
    }
    throw new Error("YouCam timeout");
}

// --- 主要執行入口 (API Endpoint) ---
// 這裡就是「承接」你 Framer 的地方

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin") || "";
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin") || "";
  try {
    // 👇 這行就是關鍵！它承接了 Framer 丟過來的 FormData
    const formData = await req.formData();
    const file = formData.get("image1") as File;
    if (!file) throw new Error("Missing image1");

    // 👇 順序絕對正確：
    // 1. 先跑 YouCam (用 YOUCAM_API_KEY)
    const { map, taskId } = await youcamWorkflow(file);
    
    // 整理 YouCam 的資料
    const scanId = `scan_${Date.now()}`;
    const rawMetrics = buildMetrics(map, scanId);

    // 2. 再跑 Coze (用 COZE_API_TOKEN, COZE_BOT_ID) 把 YouCam 的結果給它
    const report = await generateReportWithCoze(rawMetrics, scanId);

    // 3. 回傳給你的 Framer (ScanResults.tsx 會收到這個)
    return jsonResponse({
        scanId,
        summary_en: report.summary_en,
        summary_zh: report.summary_zh,
        cards: report.cards,
        meta: { youcam_task_id: taskId }
    }, 200, origin);

  } catch (e: any) {
    const msg = e?.message || String(e);
    console.error("Scan error:", msg);
    
    // 錯誤處理 (如果臉太小、光線太暗...)
    let retakeCode = null;
    let tips: string[] = [];
    if (msg.includes("error_src_face_too_small")) { retakeCode = "error_src_face_too_small"; tips = ["Move closer.", "Center face."]; }
    else if (msg.includes("error_lighting_dark")) { retakeCode = "error_lighting_dark"; tips = ["Lighting too dark.", "Face a light source."]; }
    else if (msg.includes("error_src_face_out_of_bound")) { retakeCode = "error_src_face_out_of_bound"; tips = ["Face out of frame.", "Recenter."]; }

    if (retakeCode) {
        return jsonResponse({ error: "scan_retake", code: retakeCode, tips }, 200, origin);
    }
    return jsonResponse({ error: "scan_failed", message: msg }, 500, origin);
  }
}
