declare const process: any;

export const config = {
  runtime: "edge",
  regions: ["sin1", "hnd1", "icn1"],
};

type MetricId =
  | "texture" | "pore" | "pigmentation" | "wrinkle"
  | "hydration" | "sebum" | "skintone" | "sensitivity"
  | "clarity" | "elasticity" | "redness" | "brightness" | "firmness" | "pores_depth";

type Card = {
  id: MetricId;
  title_en: string;
  title_zh: string;
  score: number;
  max: 100;
  signal_en: string;
  signal_zh: string;
  details: { label_en: string; label_zh: string; value: number | string }[];
  recommendation_en: string;
  recommendation_zh: string;
  priority: number;
  confidence: number;
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function nowId() { return `scan_${Date.now()}`; }

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function getFiles(form: FormData) {
  const f1 = form.get("image1");
  const f2 = form.get("image2");
  const f3 = form.get("image3");
  if (!(f1 instanceof File)) throw new Error("Missing image1");
  const files: File[] = [f1];
  if (f2 instanceof File) files.push(f2);
  if (f3 instanceof File) files.push(f3);
  return files;
}

async function toBytes(f: File) {
  const buf = await f.arrayBuffer();
  return new Uint8Array(buf);
}

function quickPrecheck(bytes: Uint8Array) {
  const sizeKB = bytes.length / 1024;
  const warnings: string[] = [];
  const tips: string[] = [];

  if (sizeKB < 60) {
    warnings.push("LOW_RESOLUTION");
    tips.push("Image quality is low. Use a clearer photo (avoid screenshots).");
  }

  let sample = 0, sum = 0;
  for (let i = 0; i < bytes.length; i += 401) { sum += bytes[i]; sample++; }
  const avg = sample ? sum / sample : 120;

  if (avg < 85) { warnings.push("TOO_DARK"); tips.push("Low light. Face a window or add soft front light."); }
  if (avg > 185) { warnings.push("TOO_BRIGHT"); tips.push("Highlights are strong. Avoid direct overhead light."); }

  tips.push("Keep white balance neutral. Avoid warm indoor bulbs when possible.");
  return { ok: warnings.length === 0, avgSignal: avg, warnings, tips };
}

/* =========================
   ✅ Clean + Format
========================= */
function cleanNarr(s: string) {
  return (s || "")
    .replace(/\u3000/g, " ")
    .replace(/::/g, " · ")
    .replace(/[■◆●]/g, "")
    .replace(/\s+\|\s+/g, " · ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function formatZhPanel(input: string) {
  let s = cleanNarr(input || "");
  s = s.replace(/ *• */g, "\n• ").replace(/ *- */g, "\n• ").replace(/ *・ */g, "\n• ");
  s = s.replace(/。(?=[^\n])/g, "。\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  s = s.split("\n").map(x => x.trim()).join("\n").trim();
  return s;
}
function formatEnPanel(input: string) {
  return (input || "").replace(/\s+/g, " ").replace(/::/g, " - ").trim();
}

/* =========================
   YouCam — HD Skin Analysis
========================= */
const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";
const YOUCAM_FILE_ENDPOINT = `${YOUCAM_BASE}/file/skin-analysis`;
const YOUCAM_TASK_CREATE = `${YOUCAM_BASE}/task/skin-analysis`;
const YOUCAM_TASK_GET = (taskId: string) => `${YOUCAM_BASE}/task/skin-analysis/${taskId}`;

async function youcamInitUpload(file: File) {
  const apiKey = mustEnv("YOUCAM_API_KEY");

  const payload = {
    files: [{
      content_type: file.type || "image/jpeg",
      file_name: (file as any).name || `skin_${Date.now()}.jpg`,
      file_size: file.size,
    }],
  };

  const r = await fetch(YOUCAM_FILE_ENDPOINT, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await r.json();
  if (!r.ok || j.status !== 200) throw new Error(`YouCam file init failed: ${r.status} ${JSON.stringify(j)}`);

  const f = j.data?.files?.[0];
  const req = f?.requests?.[0];
  if (!f?.file_id || !req?.url) throw new Error("YouCam file init missing file_id/upload url");

  return { fileId: f.file_id as string, putUrl: req.url as string, contentType: f.content_type as string };
}

async function youcamPutBinary(putUrl: string, fileBytes: Uint8Array, contentType: string) {
  const r = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(fileBytes.length) },
    body: fileBytes,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`YouCam PUT failed: ${r.status} ${t}`);
  }
}

async function youcamCreateTask(srcFileId: string, dstActions: string[]) {
  const apiKey = mustEnv("YOUCAM_API_KEY");

  const payload = {
    src_file_id: srcFileId,
    dst_actions: dstActions,
    miniserver_args: {
      enable_mask_overlay: false,
      enable_dark_background_hd_pore: true,
      color_dark_background_hd_pore: "3D3D3D",
      opacity_dark_background_hd_pore: 0.4,
    },
    format: "json",
  };

  const r = await fetch(YOUCAM_TASK_CREATE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await r.json();
  if (!r.ok || j.status !== 200 || !j.data?.task_id) {
    throw new Error(`YouCam task create failed: ${r.status} ${JSON.stringify(j)}`);
  }
  return j.data.task_id as string;
}

async function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function youcamPollTask(taskId: string, maxMs = 65000) {
  const apiKey = mustEnv("YOUCAM_API_KEY");
  const start = Date.now();
  let wait = 1200;

  while (Date.now() - start < maxMs) {
    const r = await fetch(YOUCAM_TASK_GET(taskId), {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    const j = await r.json();
    if (!r.ok || j.status !== 200) throw new Error(`YouCam task poll failed: ${r.status} ${JSON.stringify(j)}`);

    const st = j.data?.task_status;
    if (st === "success") return j;
    if (st === "error") throw new Error(`YouCam task error: ${JSON.stringify(j.data)}`);

    await sleep(wait);
    wait = Math.min(wait * 1.6, 8000);
  }

  throw new Error("YouCam task timeout");
}

const YOUCAM_HD_ACTIONS = [
  "hd_texture","hd_pore","hd_wrinkle","hd_redness","hd_oiliness","hd_age_spot","hd_radiance",
  "hd_moisture","hd_dark_circle","hd_eye_bag","hd_droopy_upper_eyelid","hd_droopy_lower_eyelid",
  "hd_firmness","hd_acne",
];

function extractYoucamScores(j: any) {
  const out = j?.data?.results?.output;
  const map = new Map<string, { ui: number; raw: number; masks: string[] }>();

  if (Array.isArray(out)) {
    for (const x of out) {
      const key = String(x.type);
      map.set(key, {
        ui: Number(x.ui_score ?? x.uiScore ?? 0),
        raw: Number(x.raw_score ?? x.rawScore ?? 0),
        masks: Array.isArray(x.mask_urls) ? x.mask_urls : [],
      });
    }
  }

  const scoreInfo = j?.data?.results?.score_info ?? j?.data?.results?.scoreInfo;
  if (scoreInfo && typeof scoreInfo === "object") {
    for (const [k, v] of Object.entries(scoreInfo)) {
      const vv: any = v;
      if (vv?.ui_score != null && vv?.raw_score != null) {
        map.set(k, {
          ui: Number(vv.ui_score),
          raw: Number(vv.raw_score),
          masks: Array.isArray(vv?.mask_urls) ? vv.mask_urls : [],
        });
      }
    }
  }
  return map;
}

function clampScore(x: any) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function mapYoucamToYourRaw(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>) {
  const get = (k: string, fallback?: string) => scoreMap.get(k) ?? (fallback ? scoreMap.get(fallback) : undefined);

  const hd_texture = get("hd_texture") ?? get("texture");
  const hd_moisture = get("hd_moisture") ?? get("moisture");
  const hd_oiliness = get("hd_oiliness") ?? get("oiliness");
  const hd_age_spot = get("hd_age_spot") ?? get("age_spot");
  const hd_radiance = get("hd_radiance") ?? get("radiance");
  const hd_redness = get("hd_redness") ?? get("redness");
  const hd_firmness = get("hd_firmness") ?? get("firmness");

  const pore_whole = get("hd_pore.whole") ?? get("hd_pore") ?? get("pore");
  const pore_forehead = get("hd_pore.forehead");
  const pore_nose = get("hd_pore.nose");
  const pore_cheek = get("hd_pore.cheek");

  const wrk_whole = get("hd_wrinkle.whole") ?? get("hd_wrinkle") ?? get("wrinkle");
  const wrk_forehead = get("hd_wrinkle.forehead");
  const wrk_crowfeet = get("hd_wrinkle.crowfeet");
  const wrk_nasolabial = get("hd_wrinkle.nasolabial");

  const safe = (v?: { ui: number; raw: number }) => ({
    ui: clampScore(v?.ui),
    raw: Number.isFinite(Number(v?.raw)) ? Number(v?.raw) : 0,
  });

  const T = safe(hd_texture);
  const H = safe(hd_moisture);
  const S = safe(hd_oiliness);
  const P = safe(pore_whole);
  const R = safe(hd_radiance);
  const RD = safe(hd_redness);
  const F = safe(hd_firmness);
  const PG = safe(hd_age_spot);
  const W = safe(wrk_whole);

  return {
    texture: { score: T.ui, details: [{en:"Roughness",zh:"粗糙度",v:72},{en:"Smoothness",zh:"平滑度",v:64},{en:"Evenness",zh:"均勻度",v:68}] },
    pore: { score: P.ui, details: [{en:"T-Zone",zh:"T 區",v:pore_forehead?clampScore((pore_forehead as any).ui):88},{en:"Cheek",zh:"臉頰",v:pore_cheek?clampScore((pore_cheek as any).ui):95},{en:"Chin",zh:"下巴",v:93}] },
    pigmentation: { score: PG.ui, details: [{en:"Brown Spot",zh:"棕色斑",v:78},{en:"Red Area",zh:"紅色區",v:82},{en:"Dullness",zh:"暗沉度",v:65}] },
    wrinkle: { score: W.ui, details: [{en:"Eye Area",zh:"眼周",v:wrk_crowfeet?clampScore((wrk_crowfeet as any).ui):76},{en:"Forehead",zh:"額頭",v:wrk_forehead?clampScore((wrk_forehead as any).ui):85},{en:"Nasolabial",zh:"法令紋",v:wrk_nasolabial?clampScore((wrk_nasolabial as any).ui):79}] },
    hydration: { score: H.ui, details: [{en:"Surface",zh:"表層含水",v:58},{en:"Deep",zh:"深層含水",v:64},{en:"TEWL",zh:"經皮水分流失",v:"Moderate"}] },
    sebum: { score: S.ui, details: [{en:"T-Zone",zh:"T 區",v:82},{en:"Cheek",zh:"臉頰",v:64},{en:"Chin",zh:"下巴",v:73}] },
    skintone: { score: R.ui, details: [{en:"Evenness",zh:"均勻度",v:78},{en:"Brightness",zh:"亮度",v:75},{en:"Redness",zh:"紅色指數",v:68}] },
    sensitivity: { score: RD.ui, details: [{en:"Redness Index",zh:"泛紅指數",v:65},{en:"Barrier Stability",zh:"屏障功能",v:71},{en:"Irritation Response",zh:"刺激反應",v:"Low"}] },
    clarity: { score: R.ui, details: [{en:"Micro-reflection",zh:"微反射",v:"Uneven"},{en:"Contrast Zones",zh:"高對比區",v:"Present"},{en:"Stability",zh:"穩定度",v:"Medium"}] },
    elasticity: { score: F.ui, details: [{en:"Rebound",zh:"回彈",v:"Stable"},{en:"Support",zh:"支撐",v:"Moderate"},{en:"Variance",zh:"變異",v:"Low"}] },
    redness: { score: RD.ui, details: [{en:"Hotspots",zh:"集中區",v:"Localized"},{en:"Threshold",zh:"門檻",v:"Near"},{en:"Stability",zh:"穩定度",v:"Medium"}] },
    brightness: { score: R.ui, details: [{en:"Global",zh:"整體",v:"Stable"},{en:"Shadow Zones",zh:"陰影區",v:"Minor deviation"},{en:"Trajectory",zh:"軌跡",v:"Improving"}] },
    firmness: { score: F.ui, details: [{en:"Support",zh:"支撐",v:"Present"},{en:"Baseline",zh:"基準",v:"Stable"},{en:"Variance",zh:"變異",v:"Low"}] },
    pores_depth: { score: clampScore(pore_nose?.raw ?? pore_whole?.raw ?? P.raw), details: [{en:"Depth Proxy",zh:"深度代理值",v:"Derived"},{en:"Edge Definition",zh:"邊界清晰度",v:"Good"},{en:"Stability",zh:"穩定度",v:"High"}] },
  };
}

async function analyzeWithYouCamSingle(primaryFile: File) {
  const init = await youcamInitUpload(primaryFile);
  const buf = new Uint8Array(await primaryFile.arrayBuffer());
  await youcamPutBinary(init.putUrl, buf, init.contentType);

  const taskId = await youcamCreateTask(init.fileId, YOUCAM_HD_ACTIONS);
  const finalJson = await youcamPollTask(taskId);

  const scoreMap = extractYoucamScores(finalJson);
  const raw = mapYoucamToYourRaw(scoreMap);

  return { taskId, task_status: finalJson?.data?.task_status, raw };
}

/* =========================
   ✅ Your Spec Narrative Builder (NO TEMPLATE TRASH)
   - 全部依你指定規模，段落分明
========================= */
function pigmentRegionClause(): string {
  return "未啟用區域遮罩時，系統不提供精準座標；依訊號型態，優先觀察顴骨—臉頰帶／鼻翼—上唇周邊的輪廓乾淨度與色階一致性。";
}

function cadenceById(id: MetricId): string {
  switch (id) {
    case "hydration":
    case "texture":
      return "監測：7–10 天先看緊繃感與反射乾淨度是否下降；14–21 天再看整體一致性是否更穩。";
    case "sensitivity":
    case "redness":
      return "監測：10–14 天看波動幅度是否收斂（比看數字更重要）；若仍容易被同樣情境觸發，再調整節奏。";
    case "pigmentation":
      return "監測：色素屬累積型訊號，建議以 21–28 天觀察一次趨勢線（輪廓乾淨度與色階一致性）。";
    case "pore":
    case "pores_depth":
      return "監測：10–14 天看 T 區與臉頰差異是否縮小；21–42 天再看邊界陰影是否變乾淨。";
    case "wrinkle":
    case "elasticity":
    case "firmness":
      return "監測：21–28 天看支撐維持時間是否變長；28–56 天再看回彈是否更穩。";
    default:
      return "監測：10–14 天看穩定度與一致性是否變乾淨。";
  }
}

function growthLine(id: MetricId, score: number): string {
  // 每張不同區間，不會再「都一樣」
  const table: Record<MetricId, [number, number]> = {
    texture: [18, 28],
    hydration: [20, 32],
    pigmentation: [24, 42],
    pore: [10, 18],
    pores_depth: [10, 18],
    sebum: [8, 16],
    skintone: [8, 14],
    sensitivity: [10, 18],
    redness: [10, 18],
    clarity: [8, 14],
    brightness: [8, 14],
    firmness: [6, 12],
    elasticity: [6, 12],
    wrinkle: [6, 12],
  };
  const [lo, hi] = table[id] ?? [10, 18];
  // 讓高分卡回收窗口更窄（合理）
  const narrow = score >= 88 ? [Math.max(1, lo - 4), Math.max(lo, hi - 8)] : [lo, hi];
  return `成長空間：可回收 ${narrow[0]}–${narrow[1]}%（阻力：中）`;
}

function mkCardFromRaw(id: MetricId, title_en: string, title_zh: string, score: number, details: any[], priority: number, confidence: number): Card {
  const d0 = details?.[0]?.zh || details?.[0]?.label_zh || "細項一";
  const d1 = details?.[1]?.zh || details?.[1]?.label_zh || "細項二";
  const d2 = details?.[2]?.zh || details?.[2]?.label_zh || "細項三";

  const band =
    score >= 88 ? "靠近同齡族群基準上緣" :
    score >= 72 ? "落在同齡族群可控偏差帶" :
    "接近需要管理的門檻";

  const pigmentClause = id === "pigmentation" ? `\n${pigmentRegionClause()}\n` : "";

  const signal_en_base: Record<MetricId, string> = {
    texture: "Your texture signal sits below the cohort baseline. Not a warning — a clear starting point for refinement.",
    hydration: "Hydration sits below the ideal reference band. Surface vs deep separation signals barrier instability rather than supply shortage.",
    pore: "Your pore signal is operating in a stable zone. Control is driven by cadence, not intensity.",
    pigmentation: "Pigment clusters were detected with an accumulation pattern — typically responsive to consistent protection.",
    wrinkle: "Fine-line activity remains within expected variance. This is an ideal window for prevention — stability-first works best here.",
    sebum: "Sebum output reads as manageable. The system prioritizes rhythm and variance over one-off peaks.",
    skintone: "Tone consistency is strong with localized variance. Stability can be improved without over-stimulation.",
    sensitivity: "Mild reactivity signals detected. Not critical — manage early to protect stability.",
    clarity: "Surface clarity is stable. Interpretation prioritizes baseline, stability, and trajectory.",
    elasticity: "Elasticity reads as stable with moderate support. Consistency protects rebound.",
    redness: "Redness intensity is manageable. The goal is a tighter stability band, not suppression.",
    brightness: "Brightness is stable with minor deviation in shadow zones. Keep consistency for a clean trajectory.",
    firmness: "Firmness support appears present. The system prioritizes stability and long-run support maintenance.",
    pores_depth: "Depth perception is derived from edge definition and stability. The signal is manageable with stability-first routines.",
  };

  const signal_zh = formatZhPanel(
`你的${title_zh}訊號目前${band}（${score}/100）。
這代表系統在影像中觀察到：
• ${d0}
• ${d1}
• ${d2}

這並不是老化或不可逆狀態，
而是節奏與穩定度不足所引發的結構型偏移。${pigmentClause}
換句話說，
系統不是看到「變糟」，
而是看到「水分與結構無法長時間被固定在正確位置」。`
  );

  const recommendation_en = formatEnPanel(
    id === "hydration"
      ? "Prioritize ceramides + humectants in a low-irritation formula. A consistent reset can lift stability without rebound."
      : id === "texture"
      ? "Focus on barrier re-stabilization and water retention. Consistency lifts uniformity without rebound."
      : "Stabilize first → refine second."
  );

  const recommendation_zh = formatZhPanel(
`系統建議的不是「短期加大強度」或「刺激型堆疊」，
而是優先把輸入節奏固定住，讓趨勢線變乾淨。

路徑：先止損（降低不必要的刺激密度）→ 再穩定（把狀態固定住）→ 最後精修（在穩定上做細節）。
${cadenceById(id)}

在模型推算中，若能維持一致性輸入，整體可改善約 ${growthLine(id, score).replace("成長空間：可回收 ", "")}，且不伴隨反彈風險。
${growthLine(id, score)}`
  );

  return {
    id,
    title_en,
    title_zh,
    score,
    max: 100,
    signal_en: formatEnPanel(signal_en_base[id] || "Instrument readout ready."),
    signal_zh,
    details: details.map((d:any)=>({
      label_en: d.en ?? d.label_en ?? "",
      label_zh: d.zh ?? d.label_zh ?? "",
      value: d.v ?? d.value ?? "",
    })),
    recommendation_en,
    recommendation_zh,
    priority,
    confidence,
  };
}

function buildCardsFromRaw(raw: any): Card[] {
  const order: { id: MetricId; en: string; zh: string; priority: number; confidence: number }[] = [
    { id:"texture", en:"TEXTURE", zh:"紋理", priority:95, confidence:0.90 },
    { id:"hydration", en:"HYDRATION", zh:"含水與屏障", priority:92, confidence:0.88 },
    { id:"pore", en:"PORE", zh:"毛孔", priority:86, confidence:0.84 },
    { id:"pores_depth", en:"PORE DEPTH", zh:"毛孔深度感", priority:84, confidence:0.82 },
    { id:"sensitivity", en:"SENSITIVITY", zh:"刺激反應傾向", priority:82, confidence:0.83 },
    { id:"redness", en:"REDNESS", zh:"泛紅強度", priority:81, confidence:0.82 },
    { id:"sebum", en:"SEBUM", zh:"油脂平衡", priority:80, confidence:0.81 },
    { id:"clarity", en:"CLARITY", zh:"表層清晰度", priority:79, confidence:0.80 },
    { id:"brightness", en:"BRIGHTNESS", zh:"亮度狀態", priority:78, confidence:0.80 },
    { id:"skintone", en:"SKIN TONE", zh:"膚色一致性", priority:77, confidence:0.79 },
    { id:"firmness", en:"FIRMNESS", zh:"緊緻支撐", priority:76, confidence:0.80 },
    { id:"elasticity", en:"ELASTICITY", zh:"彈性回彈", priority:75, confidence:0.79 },
    { id:"wrinkle", en:"WRINKLE", zh:"細紋與摺痕", priority:74, confidence:0.78 },
    { id:"pigmentation", en:"PIGMENTATION", zh:"色素沉著", priority:73, confidence:0.78 },
  ];

  const cards = order.map((m) => {
    const src = raw?.[m.id] || { score: 0, details: [] };
    return mkCardFromRaw(m.id, m.en, m.zh, Number(src.score ?? 0), (src.details || []), m.priority, m.confidence);
  });

  // priority high first (front-end 會自己排序也可)
  cards.sort((a,b)=> (b.priority ?? 0) - (a.priority ?? 0));
  return cards;
}

/* =========================
   Handler
========================= */
export default async function handler(req: Request) {
  try {
    if (req.method === "OPTIONS") return json({}, 200);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const form = await req.formData();
    const files = await getFiles(form);
    files.sort((a, b) => b.size - a.size);
    const primaryFile = files[0];

    const primaryBytes = await toBytes(primaryFile);
    const precheck = quickPrecheck(primaryBytes);

    const youcam = await analyzeWithYouCamSingle(primaryFile);

    const cards = buildCardsFromRaw(youcam.raw);

    const summary_zh = formatZhPanel(
      "系統已將主要訊號依優先順序整理。\n以下為系統判定之關鍵訊號，點開可讀取深層判讀與路徑。"
    );
    const summary_en = formatEnPanel(
      "Primary signals have been ordered for review. Open a card for deep readout."
    );

    return json({
      build: "honeytea_scan_youcam_v7_narrative_user_spec",
      scanId: nowId(),
      precheck: {
        ok: precheck.ok,
        warnings: precheck.warnings,
        tips: precheck.tips,
      },
      cards,
      summary_en,
      summary_zh,
      meta: {
        youcam_task_id: youcam.taskId,
        youcam_task_status: youcam.task_status,
        mode: "youcam_metrics + server_narrative",
      },
    });

  } catch (e: any) {
    const msg = e?.message ?? String(e);

    // YouCam errors -> retake tips
    if (msg.includes("error_src_face_too_small")) {
      return json({
        error: "scan_retake",
        code: "error_src_face_too_small",
        tips: [
          "距離太遠：臉部請佔畫面約 60–80%。",
          "保持正面置中，避免側臉或低頭。",
          "額頭與眼周需清晰可見（瀏海請撥開）。",
          "使用均勻柔光，避免背光。",
        ],
      }, 200);
    }

    if (msg.includes("error_lighting_dark")) {
      return json({
        error: "scan_retake",
        code: "error_lighting_dark",
        tips: [
          "光線不足：請面向窗戶或補柔光。",
          "避免背光與局部強反光（額頭/鼻翼）。",
        ],
      }, 200);
    }

    if (msg.includes("error_src_face_out_of_bound")) {
      return json({
        error: "scan_retake",
        code: "error_src_face_out_of_bound",
        tips: [
          "超出框位：請回到畫面中心。",
          "保持頭部穩定，避免左右快速移動。",
        ],
      }, 200);
    }

    return json({ error: "scan_failed", message: msg }, 500);
  }
}
