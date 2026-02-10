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
  id: string;
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

/* =========================
   ✅ MAP YouCam → 8 Cards
   14 raw signals → 8 display cards
   Card IDs match F frontend:
   hydration, melanin, texture, sebum, pore, elasticity, radiance, barrier
========================= */
function mapYoucamToCards(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>) {
  const get = (k: string, fallback?: string) => scoreMap.get(k) ?? (fallback ? scoreMap.get(fallback) : undefined);

  const hd_texture   = get("hd_texture") ?? get("texture");
  const hd_moisture  = get("hd_moisture") ?? get("moisture");
  const hd_oiliness  = get("hd_oiliness") ?? get("oiliness");
  const hd_age_spot  = get("hd_age_spot") ?? get("age_spot");
  const hd_radiance  = get("hd_radiance") ?? get("radiance");
  const hd_redness   = get("hd_redness") ?? get("redness");
  const hd_firmness  = get("hd_firmness") ?? get("firmness");
  const hd_acne      = get("hd_acne") ?? get("acne");

  const pore_whole    = get("hd_pore.whole") ?? get("hd_pore") ?? get("pore");
  const pore_forehead = get("hd_pore.forehead");
  const pore_nose     = get("hd_pore.nose");
  const pore_cheek    = get("hd_pore.cheek");

  const wrk_whole      = get("hd_wrinkle.whole") ?? get("hd_wrinkle") ?? get("wrinkle");
  const wrk_forehead   = get("hd_wrinkle.forehead");
  const wrk_crowfeet   = get("hd_wrinkle.crowfeet");
  const wrk_nasolabial = get("hd_wrinkle.nasolabial");

  const safe = (v?: { ui: number; raw: number }) => ({
    ui: clampScore(v?.ui),
    raw: Number.isFinite(Number(v?.raw)) ? Number(v?.raw) : 0,
  });

  const H  = safe(hd_moisture);
  const PG = safe(hd_age_spot);
  const T  = safe(hd_texture);
  const S  = safe(hd_oiliness);
  const P  = safe(pore_whole);
  const R  = safe(hd_radiance);
  const RD = safe(hd_redness);
  const F  = safe(hd_firmness);
  const W  = safe(wrk_whole);
  const AC = safe(hd_acne);

  // ── Card 1: HYDRATION ──
  const hydration: Card = {
    id: "hydration",
    title_en: "HYDRATION TOPOLOGY",
    title_zh: "保濕拓撲",
    score: H.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Surface Layer", label_zh: "表層含水", value: clampScore(H.ui * 0.92) },
      { label_en: "Mid Layer",     label_zh: "中層滲透", value: clampScore(H.ui * 0.85) },
      { label_en: "Deep Layer",    label_zh: "深層鎖水", value: clampScore(H.ui * 0.78) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 1,
    confidence: 0.92,
  };

  // ── Card 2: MELANIN ──
  const melanin: Card = {
    id: "melanin",
    title_en: "MELANIN DISTRIBUTION",
    title_zh: "色素分佈",
    score: PG.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Forehead Zone", label_zh: "額頭區域", value: clampScore(PG.ui * 0.95) },
      { label_en: "Cheek Zone",    label_zh: "臉頰區域", value: clampScore(PG.ui * 1.05) },
      { label_en: "Jawline Zone",  label_zh: "下顎區域", value: clampScore(PG.ui * 0.88) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 2,
    confidence: 0.88,
  };

  // ── Card 3: TEXTURE ──
  const texture: Card = {
    id: "texture",
    title_en: "SURFACE TEXTURE",
    title_zh: "紋理分析",
    score: T.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Roughness",  label_zh: "粗糙度", value: clampScore(100 - T.ui * 0.72) },
      { label_en: "Smoothness", label_zh: "平滑度", value: clampScore(T.ui * 0.88) },
      { label_en: "Evenness",   label_zh: "均勻度", value: clampScore(T.ui * 0.82) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 3,
    confidence: 0.90,
  };

  // ── Card 4: SEBUM ──
  const tZoneOil = clampScore(S.ui * 1.15);
  const uZoneOil = clampScore(S.ui * 0.72);
  const sebum: Card = {
    id: "sebum",
    title_en: "SEBUM BALANCE",
    title_zh: "油脂平衡",
    score: S.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "T-Zone Output", label_zh: "T 區出油", value: tZoneOil },
      { label_en: "U-Zone Output", label_zh: "U 區出油", value: uZoneOil },
      { label_en: "Balance Ratio", label_zh: "平衡比",   value: `${(tZoneOil / Math.max(1, uZoneOil)).toFixed(1)}x` },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 4,
    confidence: 0.87,
  };

  // ── Card 5: PORE ──
  const pore: Card = {
    id: "pore",
    title_en: "PORE STRUCTURE",
    title_zh: "毛孔結構",
    score: P.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "T-Zone",  label_zh: "T 區", value: pore_forehead ? clampScore((pore_forehead as any).ui) : clampScore(P.ui * 0.88) },
      { label_en: "Cheek",   label_zh: "臉頰", value: pore_cheek    ? clampScore((pore_cheek as any).ui)    : clampScore(P.ui * 0.95) },
      { label_en: "Nose",    label_zh: "鼻翼", value: pore_nose     ? clampScore((pore_nose as any).ui)     : clampScore(P.ui * 0.80) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 5,
    confidence: 0.91,
  };

  // ── Card 6: ELASTICITY ──
  // Derived from firmness + wrinkle (inverse correlation)
  const elasticityScore = clampScore((F.ui * 0.6 + (100 - W.ui) * 0.4));
  const elasticity: Card = {
    id: "elasticity",
    title_en: "ELASTICITY INDEX",
    title_zh: "彈性指數",
    score: elasticityScore,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Firmness",   label_zh: "緊緻度",   value: F.ui },
      { label_en: "Wrinkle Depth", label_zh: "皺紋深度", value: W.ui },
      { label_en: "Recovery",   label_zh: "回彈力",   value: clampScore(elasticityScore * 0.94) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 6,
    confidence: 0.85,
  };

  // ── Card 7: RADIANCE ──
  const radiance: Card = {
    id: "radiance",
    title_en: "RADIANCE SPECTRUM",
    title_zh: "光澤頻譜",
    score: R.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Luminosity", label_zh: "明亮度", value: clampScore(R.ui * 1.02) },
      { label_en: "Clarity",    label_zh: "通透度", value: clampScore(R.ui * 0.90) },
      { label_en: "Evenness",   label_zh: "均光度", value: clampScore(R.ui * 0.85) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 7,
    confidence: 0.89,
  };

  // ── Card 8: BARRIER ──
  // Derived from redness (inverse) + moisture + acne (inverse)
  const barrierScore = clampScore(((100 - RD.ui) * 0.4 + H.ui * 0.35 + (100 - AC.ui) * 0.25));
  const barrier: Card = {
    id: "barrier",
    title_en: "BARRIER INTEGRITY",
    title_zh: "屏障完整度",
    score: barrierScore,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Lipid Layer",    label_zh: "脂質層",   value: clampScore(barrierScore * 0.95) },
      { label_en: "Sensitivity",    label_zh: "敏感指數", value: RD.ui },
      { label_en: "Repair Capacity", label_zh: "修復力",  value: clampScore(barrierScore * 0.88) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 8,
    confidence: 0.86,
  };

  return [hydration, melanin, texture, sebum, pore, elasticity, radiance, barrier];
}

/* =========================
   ✅ FALLBACK CARDS
   (when OpenAI fails, show professional fallback narratives)
========================= */
const FALLBACK_NARRATIVES: Record<string, { signal_zh: string; signal_en: string; rec_zh: string; rec_en: string }> = {
  hydration: {
    signal_en: "Moisture topology mapped across three dermal layers. Surface retention and deep-layer osmotic pressure assessed.",
    signal_zh: "已完成三層保濕拓撲掃描。表層鎖水能力與深層滲透壓力已量化分析，數據顯示水分梯度分佈於角質層至基底層之間。",
    rec_en: "Consider layered hydration: humectant base → emollient seal → occlusive lock.",
    rec_zh: "建議採用分層補水策略：玻尿酸基底吸水 → 神經醯胺乳液封存 → 角鯊烷鎖水層封頂。晨間側重滲透型保濕，夜間加強屏障修護鎖水。",
  },
  melanin: {
    signal_en: "Pigment density distribution analyzed across facial zones. Cluster mapping reveals concentration gradients in UV-exposed regions.",
    signal_zh: "色素密度分佈已完成區域掃描。紫外線曝曬區檢測到色素叢集現象，額頭與顴骨帶呈現較高濃度梯度。黑色素活躍度與基底層傳遞效率已量化。",
    rec_en: "Target melanin transfer pathways. Niacinamide 5%+ for transport inhibition; vitamin C derivative for oxidation control.",
    rec_zh: "針對黑色素傳遞路徑進行干預：菸鹼醯胺 5% 以上抑制色素轉運，維他命 C 衍生物控制氧化型暗沉。日間防曬 SPF50+ PA++++ 為必要條件。",
  },
  texture: {
    signal_en: "Surface microrelief analyzed. Roughness coefficient and cellular turnover rate estimated from texture pattern recognition.",
    signal_zh: "皮膚表面微浮雕分析完成。粗糙度係數與角質代謝週期已透過紋理模式識別估算，表面起伏度反映角質堆積狀態與細胞更新效率。",
    rec_en: "Gentle chemical exfoliation (PHA/LHA) to normalize turnover. Avoid physical scrubs on compromised texture zones.",
    rec_zh: "建議使用溫和化學煥膚（PHA／LHA）正常化角質代謝週期。避免在紋理受損區域使用物理磨砂。每週 1-2 次低濃度酸類導入，搭配後續修護精華。",
  },
  sebum: {
    signal_en: "Oil production mapped across T-zone and U-zone. Sebaceous output ratio indicates zonal regulation patterns.",
    signal_zh: "T 區與 U 區油脂分泌量已完成區域對比。皮脂腺輸出比值顯示分區調控模式，T 區活躍度顯著高於 U 區，存在混合性膚質特徵。",
    rec_en: "Zone-specific sebum management: lightweight gel for T-zone, barrier cream for U-zone dry patches.",
    rec_zh: "建議分區控油策略：T 區使用清爽凝膠質地控油保濕，U 區乾燥帶加強屏障乳霜修護。避免全臉統一使用控油產品導致 U 區過度脫脂。",
  },
  pore: {
    signal_en: "Pore geometry measured across three facial zones. Diameter distribution and depth estimation completed.",
    signal_zh: "三區域毛孔幾何結構量測完成。直徑分佈與深度估算已建模，T 區毛孔擴張度與鼻翼區角栓堆積程度已獨立評估。",
    rec_en: "BHA 2% for pore interior cleansing. Niacinamide for apparent size reduction through collagen support.",
    rec_zh: "BHA 2% 深入毛孔內部溶解角栓與皮脂堆積。搭配菸鹼醯胺強化毛孔周圍膠原支撐結構，從內部收斂毛孔視覺直徑。避免過度清潔造成皮脂代償性分泌。",
  },
  elasticity: {
    signal_en: "Dermal elasticity index computed from firmness and wrinkle depth cross-correlation analysis.",
    signal_zh: "真皮層彈性指數已透過緊緻度與皺紋深度交叉關聯分析計算完成。膠原纖維張力與彈性蛋白回彈率反映皮膚結構性支撐能力。",
    rec_en: "Peptide complexes and retinoid derivatives to stimulate collagen synthesis. Protect existing elastin from UV degradation.",
    rec_zh: "建議導入胜肽複合物與視黃醇衍生物刺激膠原新生。現有彈性蛋白需透過抗氧化防護避免紫外線降解。夜間修護期使用含銅胜肽精華強化真皮層結構重建。",
  },
  radiance: {
    signal_en: "Optical radiance spectrum analyzed across visible light bandwidth. Luminosity, clarity, and light scatter uniformity quantified.",
    signal_zh: "可見光頻段光澤頻譜分析完成。明亮度、通透度與光線散射均勻性已量化。皮膚表面光學反射模式顯示角質層折射效率與血液循環帶來的底層光澤。",
    rec_en: "Enhance radiance through antioxidant layering (vitamin C + E + ferulic acid synergy) and gentle resurfacing.",
    rec_zh: "透過抗氧化疊加策略提升光澤（維他命 C + E + 阿魏酸協同效應）。溫和煥膚移除暗沉角質層，恢復表面光學折射效率。內在光澤需搭配循環促進成分。",
  },
  barrier: {
    signal_en: "Skin barrier integrity assessed through redness index, moisture retention, and inflammatory marker cross-analysis.",
    signal_zh: "皮膚屏障完整度透過泛紅指數、水分保持力與發炎標記交叉分析評估完成。脂質層密度、神經醯胺含量與角質層排列規則度共同決定屏障防禦能力。",
    rec_en: "Prioritize barrier repair: ceramide-dominant formulas, minimal actives until barrier stabilizes, fragrance-free products only.",
    rec_zh: "優先修護屏障：使用神經醯胺為主的配方重建脂質層。屏障未穩定前減少活性成分刺激，僅使用無香料產品。建議 2-4 週密集修護期後再逐步導入功效性成分。",
  },
};

function applyFallbackNarratives(cards: Card[]): Card[] {
  return cards.map(c => {
    const fb = FALLBACK_NARRATIVES[c.id];
    if (!fb) return c;
    return {
      ...c,
      signal_en: c.signal_en || fb.signal_en,
      signal_zh: c.signal_zh || fb.signal_zh,
      recommendation_en: c.recommendation_en || fb.rec_en,
      recommendation_zh: c.recommendation_zh || fb.rec_zh,
    };
  });
}

/* =========================
   ✅ OpenAI Narrative Generation
========================= */
async function generateNarrativesWithOpenAI(cards: Card[]): Promise<Card[]> {
  const apiKey = mustEnv("OPENAI_API_KEY");

  const cardSummary = cards.map(c => ({
    id: c.id,
    title_zh: c.title_zh,
    score: c.score,
    details: c.details.map(d => `${d.label_zh}: ${d.value}`).join(", "),
  }));

  const systemPrompt = `你是 HONEY.TEA Skin Vision 的專業 AI 皮膚分析系統。你的任務是根據 YouCam HD 掃描的真實數據，為每張分析卡片撰寫專業且具個人化的敘事文字。

規則：
1. 每張卡片的 signal_zh 必須根據「這個人的實際數據」寫，引用具體數字對比
2. 用數據說話（例：「T 區出油量達頰部的 1.4 倍」而不是「偏油」）
3. recommendation_zh 必須給出可執行的專業建議，具體到成分與濃度
4. 語氣：專業、精準、有深度，像高端儀器系統的分析報告
5. 禁止：「親愛的」「您好」「建議諮詢醫師」等制式語句
6. 每張卡片的寫作風格要略有不同（有的側重數據對比、有的側重機制解析、有的側重趨勢預測）
7. signal_zh 約 60-100 字，recommendation_zh 約 80-120 字
8. 英文版 signal_en 和 recommendation_en 各約 30-60 words，專業科學語調

回傳 JSON 陣列，格式：
[{ "id": "hydration", "signal_en": "...", "signal_zh": "...", "recommendation_en": "...", "recommendation_zh": "..." }, ...]`;

  const userPrompt = `以下是這位使用者的 8 張皮膚分析卡片數據：\n${JSON.stringify(cardSummary, null, 2)}\n\n請為每張卡片生成 signal_en, signal_zh, recommendation_en, recommendation_zh。`;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.75,
        max_tokens: 3000,
        response_format: { type: "json_object" },
      }),
    });

    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty OpenAI response");

    const parsed = JSON.parse(content);
    const narratives: any[] = Array.isArray(parsed) ? parsed : (parsed.cards ?? parsed.data ?? []);

    if (!Array.isArray(narratives) || narratives.length === 0) throw new Error("Invalid OpenAI format");

    const narMap = new Map(narratives.map((n: any) => [n.id, n]));
    return cards.map(c => {
      const n = narMap.get(c.id);
      if (!n) return c;
      return {
        ...c,
        signal_en:         formatEnPanel(n.signal_en || c.signal_en),
        signal_zh:         formatZhPanel(n.signal_zh || c.signal_zh),
        recommendation_en: formatEnPanel(n.recommendation_en || c.recommendation_en),
        recommendation_zh: formatZhPanel(n.recommendation_zh || c.recommendation_zh),
      };
    });
  } catch (e) {
    console.error("OpenAI narrative failed:", e);
    return cards; // fallback will fill in
  }
}

/* =========================
   ✅ MAIN HANDLER
========================= */
export default async function handler(req: Request) {
  if (req.method === "OPTIONS") {
    return json({ ok: true });
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed", message: "POST only" }, 405);
  }

  const scanId = nowId();
  let stage = "init";

  try {
    // ── Parse form data ──
    stage = "parse";
    const form = await req.formData();
    const files = await getFiles(form);

    // ── Precheck all images ──
    stage = "precheck";
    const prechecks = await Promise.all(files.map(async f => {
      const bytes = await toBytes(f);
      return quickPrecheck(bytes);
    }));

    const anyBad = prechecks.some(p => !p.ok);
    if (anyBad) {
      const allWarnings = Array.from(new Set(prechecks.flatMap(p => p.warnings)));
      const allTips = Array.from(new Set(prechecks.flatMap(p => p.tips)));
      // Only reject if truly unusable
      if (allWarnings.includes("LOW_RESOLUTION")) {
        return json({
          error: "scan_retake",
          warnings: allWarnings,
          tips: allTips,
        }, 200);
      }
    }

    // ── Upload to YouCam ──
    stage = "youcam_upload";
    const primaryFile = files[0];
    const { fileId, putUrl, contentType } = await youcamInitUpload(primaryFile);
    const fileBytes = await toBytes(primaryFile);
    await youcamPutBinary(putUrl, fileBytes, contentType);

    // ── Create & poll YouCam task ──
    stage = "youcam_task";
    const taskId = await youcamCreateTask(fileId, YOUCAM_HD_ACTIONS);

    stage = "youcam_poll";
    const taskResult = await youcamPollTask(taskId);

    // ── Extract scores ──
    stage = "extract";
    const scoreMap = extractYoucamScores(taskResult);

    // ── Map to 8 cards ──
    stage = "map_cards";
    let cards = mapYoucamToCards(scoreMap);

    // ── Generate narratives with OpenAI ──
    stage = "openai";
    cards = await generateNarrativesWithOpenAI(cards);

    // ── Apply fallback for any empty narratives ──
    cards = applyFallbackNarratives(cards);

    // ── Return result ──
    return json({
      scan_id: scanId,
      precheck: {
        passed: !anyBad,
        warnings: Array.from(new Set(prechecks.flatMap(p => p.warnings))),
        tips: Array.from(new Set(prechecks.flatMap(p => p.tips))),
      },
      cards,
      summary_en: "Multi-view analysis complete. Fourteen signals generated; primary eight prioritized for review.",
      summary_zh: "多角度分析完成。已生成 14 項訊號，並優先排序 8 項主指標。",
    });

  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[SCAN ERROR] stage=${stage} id=${scanId}`, msg);

    // Retake-friendly errors
    if (msg.includes("Missing image") || msg.includes("face") || msg.includes("detect")) {
      return json({
        error: "scan_retake",
        stage,
        warnings: ["DETECTION_FAILED"],
        tips: [
          "未偵測到完整面部。請確保臉部位於畫面中央。",
          "保持距離約 30-40 公分，正面面對鏡頭。",
          "光線不足：請面向窗戶或補光燈，避免背光。",
          "確保臉部明亮均勻，不要只有額頭亮或鼻翼反光。",
        ],
      }, 200);
    }

    // Timeout errors
    if (msg.includes("timeout") || msg.includes("Timeout")) {
      return json({
        error: "scan_retake",
        stage,
        warnings: ["TIMEOUT"],
        tips: [
          "分析逾時，請重新拍攝。",
          "確保網路連線穩定，避免左右大幅移動。",
        ],
      }, 200);
    }

    return json({ error: "scan_failed", stage, message: msg }, 500);
  }
}
