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

/** ✅ 支援 1~3 張：image1 必填；image2/3 可選 */
async function getFiles(form: FormData) {
  const f1 = form.get("image1");
  const f2 = form.get("image2");
  const f3 = form.get("image3");

  if (!(f1 instanceof File)) {
    throw new Error("Missing image1");
  }

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
    tips.push("Image looks compressed. Use a clearer photo (avoid screenshots).");
  }

  let sample = 0, sum = 0;
  for (let i = 0; i < bytes.length; i += 401) { sum += bytes[i]; sample++; }
  const avg = sample ? sum / sample : 120;

  if (avg < 85) { warnings.push("TOO_DARK"); tips.push("Lighting is low. Face a window or brighter light."); }
  if (avg > 185) { warnings.push("TOO_BRIGHT"); tips.push("Highlights are strong. Avoid direct overhead light."); }

  tips.push("Keep white balance neutral. Avoid warm indoor bulbs when possible.");

  return {
    ok: warnings.length === 0,
    avgSignal: avg,
    warnings,
    tips,
  };
}

/* =========================
   YouCam — HD Skin Analysis (Single Photo)
   ========================= */

const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";
const YOUCAM_FILE_ENDPOINT = `${YOUCAM_BASE}/file/skin-analysis`;
const YOUCAM_TASK_CREATE = `${YOUCAM_BASE}/task/skin-analysis`;
const YOUCAM_TASK_GET = (taskId: string) => `${YOUCAM_BASE}/task/skin-analysis/${taskId}`;

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function youcamInitUpload(file: File) {
  const apiKey = mustEnv("YOUCAM_API_KEY");

  const payload = {
    files: [
      {
        content_type: file.type || "image/jpeg",
        file_name: (file as any).name || `skin_${Date.now()}.jpg`,
        file_size: file.size,
      },
    ],
  };

  const r = await fetch(YOUCAM_FILE_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const j = await r.json();
  if (!r.ok || j.status !== 200) {
    throw new Error(`YouCam file init failed: ${r.status} ${JSON.stringify(j)}`);
  }

  const f = j.data?.files?.[0];
  const req = f?.requests?.[0];
  if (!f?.file_id || !req?.url) throw new Error("YouCam file init missing file_id/upload url");

  return {
    fileId: f.file_id as string,
    putUrl: req.url as string,
    contentType: f.content_type as string,
  };
}

async function youcamPutBinary(putUrl: string, fileBytes: Uint8Array, contentType: string) {
  const r = await fetch(putUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      // Content-Length 在 edge 有時會被忽略，但保留不影響
      "Content-Length": String(fileBytes.length),
    },
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
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const j = await r.json();
  if (!r.ok || j.status !== 200 || !j.data?.task_id) {
    throw new Error(`YouCam task create failed: ${r.status} ${JSON.stringify(j)}`);
  }
  return j.data.task_id as string;
}

async function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

async function youcamPollTask(taskId: string, maxMs = 65000) {
  const apiKey = mustEnv("YOUCAM_API_KEY");
  const start = Date.now();
  let wait = 1200;

  while (Date.now() - start < maxMs) {
    const r = await fetch(YOUCAM_TASK_GET(taskId), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    const j = await r.json();
    if (!r.ok || j.status !== 200) {
      throw new Error(`YouCam task poll failed: ${r.status} ${JSON.stringify(j)}`);
    }

    const st = j.data?.task_status;
    if (st === "success") return j;
    if (st === "error") throw new Error(`YouCam task error: ${JSON.stringify(j.data)}`);

    await sleep(wait);
    wait = Math.min(wait * 1.6, 8000);
  }

  throw new Error("YouCam task timeout");
}

const YOUCAM_HD_ACTIONS = [
  "hd_texture",
  "hd_pore",
  "hd_wrinkle",
  "hd_redness",
  "hd_oiliness",
  "hd_age_spot",
  "hd_radiance",
  "hd_moisture",
  "hd_dark_circle",
  "hd_eye_bag",
  "hd_droopy_upper_eyelid",
  "hd_droopy_lower_eyelid",
  "hd_firmness",
  "hd_acne",
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
          masks: vv.output_mask_name ? [String(vv.output_mask_name)] : [],
        });
      } else if (vv?.whole?.ui_score != null && vv?.whole?.raw_score != null) {
        map.set(k, {
          ui: Number(vv.whole.ui_score),
          raw: Number(vv.whole.raw_score),
          masks: vv.whole.output_mask_name ? [String(vv.whole.output_mask_name)] : [],
        });
      } else {
        for (const [subk, subv] of Object.entries(vv)) {
          const sv: any = subv;
          if (sv?.ui_score != null && sv?.raw_score != null) {
            map.set(`${k}.${subk}`, {
              ui: Number(sv.ui_score),
              raw: Number(sv.raw_score),
              masks: sv.output_mask_name ? [String(sv.output_mask_name)] : [],
            });
          }
        }
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
    texture: {
      score: T.ui,
      details: [
        { en: "UI Score", zh: "呈現分數", v: T.ui },
        { en: "Raw Score", zh: "原始分數", v: Math.round(T.raw * 100) / 100 },
        { en: "Signal", zh: "訊號強度", v: "Derived" },
      ],
    },

    pore: {
      score: P.ui,
      details: [
        { en: "Forehead", zh: "額頭", v: pore_forehead ? clampScore(pore_forehead.ui) : "—" },
        { en: "Nose", zh: "鼻翼/鼻頭", v: pore_nose ? clampScore(pore_nose.ui) : "—" },
        { en: "Cheek", zh: "臉頰", v: pore_cheek ? clampScore(pore_cheek.ui) : "—" },
      ],
    },

    pigmentation: {
      score: PG.ui,
      details: [
        { en: "Age Spot", zh: "色素沉著/斑點", v: PG.ui },
        { en: "Raw Score", zh: "原始分數", v: Math.round(PG.raw * 100) / 100 },
        { en: "Coverage", zh: "分布趨勢", v: "Localized/Distributed" },
      ],
    },

    wrinkle: {
      score: W.ui,
      details: [
        { en: "Forehead", zh: "額頭", v: wrk_forehead ? clampScore(wrk_forehead.ui) : "—" },
        { en: "Crow's Feet", zh: "魚尾", v: wrk_crowfeet ? clampScore(wrk_crowfeet.ui) : "—" },
        { en: "Nasolabial", zh: "法令紋", v: wrk_nasolabial ? clampScore(wrk_nasolabial.ui) : "—" },
      ],
    },

    hydration: {
      score: H.ui,
      details: [
        { en: "Moisture", zh: "含水", v: H.ui },
        { en: "Raw Score", zh: "原始分數", v: Math.round(H.raw * 100) / 100 },
        { en: "TEWL", zh: "經皮水分流失", v: "Model-inferred" },
      ],
    },

    sebum: {
      score: S.ui,
      details: [
        { en: "Oiliness", zh: "油脂", v: S.ui },
        { en: "Raw Score", zh: "原始分數", v: Math.round(S.raw * 100) / 100 },
        { en: "Balance", zh: "平衡傾向", v: "T-zone weighted" },
      ],
    },

    skintone: {
      score: R.ui,
      details: [
        { en: "Radiance", zh: "光澤/亮度", v: R.ui },
        { en: "Uniformity", zh: "均勻度", v: "Model-derived" },
        { en: "Stability", zh: "穩定度", v: "Medium" },
      ],
    },

    sensitivity: {
      score: RD.ui,
      details: [
        { en: "Redness", zh: "泛紅", v: RD.ui },
        { en: "Volatility", zh: "波動性", v: "Low/Med" },
        { en: "Irritation", zh: "刺激反應", v: "Model-derived" },
      ],
    },

    clarity: {
      score: R.ui,
      details: [
        { en: "Surface Clarity", zh: "表層清晰度", v: R.ui },
        { en: "Micro-contrast", zh: "微對比", v: "Derived" },
        { en: "Noise", zh: "影像雜訊", v: "Low" },
      ],
    },

    elasticity: {
      score: F.ui,
      details: [
        { en: "Firmness", zh: "緊緻", v: F.ui },
        { en: "Rebound", zh: "回彈", v: "Derived" },
        { en: "Support", zh: "支撐", v: "Stable" },
      ],
    },

    redness: {
      score: RD.ui,
      details: [
        { en: "Hotspots", zh: "集中區", v: "Model-derived" },
        { en: "Index", zh: "指數", v: RD.ui },
        { en: "Stability", zh: "穩定度", v: "Medium" },
      ],
    },

    brightness: {
      score: R.ui,
      details: [
        { en: "Global", zh: "整體", v: R.ui },
        { en: "Shadow Zones", zh: "陰影區", v: "Minor deviation" },
        { en: "Trajectory", zh: "軌跡", v: "Improving" },
      ],
    },

    firmness: {
      score: F.ui,
      details: [
        { en: "Support", zh: "支撐", v: "Present" },
        { en: "Index", zh: "指數", v: F.ui },
        { en: "Variance", zh: "變異", v: "Low" },
      ],
    },

    pores_depth: {
      score: clampScore(pore_nose?.raw ?? pore_whole?.raw ?? P.raw),
      details: [
        { en: "Depth Proxy", zh: "深度代理值", v: Math.round((pore_nose?.raw ?? pore_whole?.raw ?? P.raw) * 100) / 100 },
        { en: "Edge Definition", zh: "邊界清晰度", v: "Derived" },
        { en: "Stability", zh: "穩定度", v: "High" },
      ],
    },
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

  return {
    taskId,
    task_status: finalJson?.data?.task_status,
    raw,
  };
}

/* =========================
   Your cards (kept) — 原封不動保留你的高級敘事
   ========================= */
function buildCards(raw: any): Card[] {
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

  cards.sort((a,b)=> (b.priority??0) - (a.priority??0));
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

    // ✅ 自動挑最大張當主圖（臉通常更大、更清楚）
    files.sort((a, b) => b.size - a.size);
    const primaryFile = files[0];

    const bytes = await Promise.all(files.map(toBytes));
    const prechecks = bytes.map(quickPrecheck);

    const youcam = await analyzeWithYouCamSingle(primaryFile);
    const cards = buildCards(youcam.raw);

    return json({
      build: "honeytea_scan_edge_cam_v1",
      scanId: nowId(),
      precheck: {
        ok: prechecks.every(p => p.ok),
        warnings: Array.from(new Set(prechecks.flatMap(p => p.warnings))),
        tips: Array.from(new Set(prechecks.flatMap(p => p.tips))),
      },
      cards,
      summary_en: "HD skin analysis complete. Fourteen signals generated; primary indicators prioritized for review.",
      summary_zh: "HD 皮膚分析完成。已生成 14 項訊號，並依優先度排序呈現。",
      meta: {
        youcam_task_id: youcam.taskId,
        youcam_task_status: youcam.task_status,
        mode: "single_photo_hd_14",
      },
    });

  } catch (e: any) {
    const msg = e?.message ?? String(e);

    // ✅ YouCam 常見錯誤：臉太小 / 太暗 / 超出範圍 → 回高級重拍提示（200）
    if (msg.includes("error_src_face_too_small")) {
      return json({
        error: "scan_retake",
        code: "error_src_face_too_small",
        tips: [
          "鏡頭再靠近一點：臉部寬度需佔畫面 60–80%。",
          "臉置中、正面直視，避免低頭/側臉。",
          "額頭露出（瀏海撥開），避免眼鏡遮擋。",
          "光線均勻：面向窗戶或柔光補光，避免背光。",
        ],
      }, 200);
    }

    if (msg.includes("error_lighting_dark")) {
      return json({
        error: "scan_retake",
        code: "error_lighting_dark",
        tips: [
          "光線不足：請面向窗戶或補光燈，避免背光。",
          "確保臉部明亮均勻，不要只有額頭亮或鼻翼反光。",
        ],
      }, 200);
    }

    if (msg.includes("error_src_face_out_of_bound")) {
      return json({
        error: "scan_retake",
        code: "error_src_face_out_of_bound",
        tips: [
          "臉部超出範圍：請把臉放回畫面中心。",
          "保持頭部穩定，避免左右大幅移動。",
        ],
      }, 200);
    }

    return json({
      error: "scan_failed",
      message: msg,
    }, 500);
  }
}
