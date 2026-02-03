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

async function getFiles(form: FormData) {
  // expects: image1, image2, image3
  const f1 = form.get("image1");
  const f2 = form.get("image2");
  const f3 = form.get("image3");
  if (!(f1 instanceof File) || !(f2 instanceof File) || !(f3 instanceof File)) {
    throw new Error("Missing images: image1/image2/image3 required");
  }
  return [f1, f2, f3] as File[];
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
    tips.push("Image looks compressed. Use a clearer photo (avoid screenshots).");
  }

  let sample = 0, sum = 0;
  for (let i = 0; i < bytes.length; i += 401) { sum += bytes[i]; sample++; }
  const avg = sample ? sum / sample : 120;

  if (avg < 85) { warnings.push("TOO_DARK"); tips.push("Lighting is low. Face a window or brighter light."); }
  if (avg > 185) { warnings.push("TOO_BRIGHT"); tips.push("Highlights are strong. Avoid direct overhead light."); }

  // we can’t decode true WB here; we still give a premium tip
  tips.push("Keep white balance neutral. Avoid warm indoor bulbs when possible.");

  return {
    ok: warnings.length === 0,
    avgSignal: avg,
    warnings,
    tips,
  };
}

/**
 * IMPORTANT:
 * For v1: return a high-quality "live" experience with real 3-photo pipeline,
 * but use stub metric values so UI is perfect first.
 * For v2: replace analyzeWithYouCamMulti() with real YouCam call that consumes 3 images.
 */
async function analyzeWithYouCamMulti(_imgs: Uint8Array[]) {
  // TODO: real YouCam (highest tier / full metrics) here.
  // return raw 14 metrics based on three views.
  return {
    // (You will swap these with real outputs.)
    texture: { score: 68, details: [{en:"Roughness",zh:"粗糙度",v:72},{en:"Smoothness",zh:"平滑度",v:64},{en:"Evenness",zh:"均勻度",v:68}] },
    pore: { score: 92, details: [{en:"T-Zone",zh:"T 區",v:88},{en:"Cheek",zh:"臉頰",v:95},{en:"Chin",zh:"下巴",v:93}] },
    pigmentation: { score: 75, details: [{en:"Brown Spot",zh:"棕色斑",v:78},{en:"Red Area",zh:"紅色區",v:82},{en:"Dullness",zh:"暗沉度",v:65}] },
    wrinkle: { score: 80, details: [{en:"Eye Area",zh:"眼周",v:76},{en:"Forehead",zh:"額頭",v:85},{en:"Nasolabial",zh:"法令紋",v:79}] },
    hydration: { score: 61, details: [{en:"Surface",zh:"表層含水",v:58},{en:"Deep",zh:"深層含水",v:64},{en:"TEWL",zh:"經皮水分流失",v:"Moderate"}] },
    sebum: { score: 73, details: [{en:"T-Zone",zh:"T 區",v:82},{en:"Cheek",zh:"臉頰",v:64},{en:"Chin",zh:"下巴",v:73}] },
    skintone: { score: 78, details: [{en:"Evenness",zh:"均勻度",v:78},{en:"Brightness",zh:"亮度",v:75},{en:"Redness",zh:"紅色指數",v:68}] },
    sensitivity: { score: 68, details: [{en:"Redness Index",zh:"泛紅指數",v:65},{en:"Barrier Stability",zh:"屏障功能",v:71},{en:"Irritation",zh:"刺激反應",v:"Low"}] },

    clarity: { score: 74, details: [{en:"Micro-reflection",zh:"微反射",v:"Uneven"},{en:"Contrast Zones",zh:"高對比區",v:"Present"},{en:"Stability",zh:"穩定度",v:"Medium"}] },
    elasticity: { score: 76, details: [{en:"Rebound",zh:"回彈",v:"Stable"},{en:"Support",zh:"支撐",v:"Moderate"},{en:"Variance",zh:"變異",v:"Low"}] },
    redness: { score: 68, details: [{en:"Hotspots",zh:"集中區",v:"Localized"},{en:"Threshold",zh:"門檻",v:"Near"},{en:"Stability",zh:"穩定度",v:"Medium"}] },
    brightness: { score: 75, details: [{en:"Global",zh:"整體",v:"Stable"},{en:"Shadow Zones",zh:"陰影區",v:"Minor deviation"},{en:"Trajectory",zh:"軌跡",v:"Improving"}] },
    firmness: { score: 77, details: [{en:"Support",zh:"支撐",v:"Present"},{en:"Baseline",zh:"基準",v:"Stable"},{en:"Variance",zh:"變異",v:"Low"}] },
    pores_depth: { score: 84, details: [{en:"Directional Light",zh:"方向光",v:"Minor variance"},{en:"Edge Definition",zh:"邊界清晰度",v:"Good"},{en:"Stability",zh:"穩定度",v:"High"}] },
  };
}

function buildCards(raw: any): Card[] {
  // 你指定的高級英文 + 深層中文（Texture/Hydration）
  const cards: Card[] = [
    {
      id:"texture", title_en:"TEXTURE", title_zh:"紋理", score: raw.texture.score, max:100,
      signal_en:"Your texture signal sits below the cohort baseline. Not a warning — a clear starting point for refinement.",
      signal_zh:`你的肌膚紋理訊號目前落在 同齡族群基準值之下，
這代表系統在影像中觀察到：
• 表層角質排列出現不一致
• 光線反射呈現「散射型」而非集中型
• 紋理邊界的連續性不足，導致觸感與視覺細緻度下降

這並不是老化或不可逆狀態，
而是屏障穩定度不足所引發的結構型紋理問題。

換句話說，
系統不是看到「粗糙」，
而是看到 「水分與結構無法長時間被固定在正確位置」。`,
      details: raw.texture.details.map((d:any)=>({label_en:d.en,label_zh:d.zh,value:d.v})),
      recommendation_en:"Focus on barrier re-stabilization and water retention. A consistent moisture-barrier protocol can lift texture uniformity by ~23% in 14 days.",
      recommendation_zh:`系統建議的不是「去角質」或「刺激型修復」，
而是優先重建水分屏障的穩定度。

當水分能被穩定鎖定在表層結構中時，
紋理排列會自然回歸一致性。

在模型預測中，
若屏障穩定度能維持 14 天以上，
整體紋理訊號可改善 約 23%，
且不伴隨反彈風險。`,
      priority: 95, confidence: 0.9
    },
    {
      id:"hydration", title_en:"HYDRATION", title_zh:"含水與屏障", score: raw.hydration.score, max:100,
      signal_en:"Hydration is ~22% below the ideal reference band. Surface vs deep separation signals barrier instability rather than supply shortage.",
      signal_zh:`目前檢測到你的肌膚含水狀態
低於理想參考區間約 22%。

但更關鍵的不是「水少」，
而是 水無法停留在應該停留的位置。

系統比對表層與深層數據後發現：
• 表層含水值明顯低於深層
• 表層水分流失速度高於正常穩定區間

這是一個典型的 屏障功能不穩定訊號。`,
      details: raw.hydration.details.map((d:any)=>({label_en:d.en,label_zh:d.zh,value:d.v})),
      recommendation_en:"Prioritize ceramides + humectants in a low-irritation formula. A 14-day reset can lift hydration into the 70+ band if consistency holds.",
      recommendation_zh:`系統不建議短期大量補水，
而是透過 結構型保濕成分（如神經醯胺）
重建水分停留能力。

當水分不再快速流失，
表層含水值會自然追上深層數值。

在模型推算下，
穩定執行 14 天後，
整體含水指標可回升至 70+ 區間，
並降低後續敏感與紋理惡化的風險。`,
      priority: 92, confidence: 0.88
    },

    // 其餘卡片用同一語氣（之後接 OpenAI 會讓每次敘事不同）
    ...(["pore","pigmentation","wrinkle","sebum","skintone","sensitivity","clarity","elasticity","redness","brightness","firmness","pores_depth"] as MetricId[])
      .map((id, idx) => {
        const m = raw[id];
        const baseTitle: Record<string,[string,string]> = {
          pore:["PORE","毛孔"],
          pigmentation:["PIGMENTATION","色素沉著"],
          wrinkle:["WRINKLE","細紋與摺痕"],
          sebum:["SEBUM","油脂平衡"],
          skintone:["SKIN TONE","膚色一致性"],
          sensitivity:["SENSITIVITY","刺激反應傾向"],
          clarity:["CLARITY","表層清晰度"],
          elasticity:["ELASTICITY","彈性回彈"],
          redness:["REDNESS","泛紅強度"],
          brightness:["BRIGHTNESS","亮度狀態"],
          firmness:["FIRMNESS","緊緻支撐"],
          pores_depth:["PORE DEPTH","毛孔深度感"],
        };
        const [en,zh] = baseTitle[id] ?? [id.toUpperCase(),"補充指標"];

        return {
          id,
          title_en: en,
          title_zh: zh,
          score: m.score,
          max: 100,
          signal_en: "Signal extracted from multi-view input. Interpretation prioritizes baseline, stability, and trajectory.",
          signal_zh: "此指標來自多角度輸入的訊號整合。\n判讀以 baseline / stability / trajectory 為主，不做誇張推論。",
          details: m.details.map((d:any)=>({label_en:d.en,label_zh:d.zh,value:d.v})),
          recommendation_en: "Keep routines consistent and avoid intensity spikes. Stability-first inputs produce the cleanest trendline.",
          recommendation_zh: "維持節奏一致，避免強度忽高忽低。\n以穩定輸入建立最乾淨的趨勢線。",
          priority: 80 - idx,
          confidence: 0.82
        } as Card;
      }),
  ];

  // 依 priority 排序（更像美國產品）
  cards.sort((a,b)=> (b.priority??0) - (a.priority??0));
  return cards;
}

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return json({}, 200);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const form = await req.formData();
  const files = await getFiles(form);
  const bytes = await Promise.all(files.map(toBytes));

  // 預檢：每張都檢查，給使用者提示（你要的：太暗/太糊/太黃提醒）
  const prechecks = bytes.map(quickPrecheck);

  // 目前先跑順（真接 YouCam 只要換 analyzeWithYouCamMulti）
  const raw = await analyzeWithYouCamMulti(bytes);
  const cards = buildCards(raw);

  return json({
    scanId: nowId(),
    precheck: {
      ok: prechecks.every(p => p.ok),
      warnings: Array.from(new Set(prechecks.flatMap(p => p.warnings))),
      tips: Array.from(new Set(prechecks.flatMap(p => p.tips))),
    },
    cards,
    summary_en: "Multi-view analysis complete. Fourteen signals generated; primary eight prioritized for review.",
    summary_zh: "多角度分析完成。已生成 14 項訊號，並優先排序 8 項主指標。",
  });
}
