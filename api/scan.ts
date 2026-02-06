// /api/scan.ts

export const config = {
  api: {
    bodyParser: false, // 前端用 FormData 上傳時比較安全
  },
}

// 這裡用寬鬆型別，避免再去 import "http"
type Req = any & { method?: string }
type Res = any & {
  status: (code: number) => Res
  json: (data: any) => void
}

// ===== 卡片型別 =====
type Card = {
  id: string
  title_en: string
  title_zh: string
  score: number
  max: number
  signal_en: string
  signal_zh: string
  details: { label_en: string; label_zh: string; value: number | string }[]
  recommendation_en: string
  recommendation_zh: string
  priority: number
  confidence: number
}

// ===== handler =====
export default async function handler(req: Req, res: Res) {
  // 補上 status / json，讓下面好寫
  res.status = function (code: number) {
    res.statusCode = code
    return res
  }
  res.json = function (data: any) {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(data))
  }

  // 簡單處理 CORS（Framer 網域來打也可以）
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    return res.status(200).end()
  }
  res.setHeader("Access-Control-Allow-Origin", "*")

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    // 🔒 先回「固定的假分析結果」，不要接 YouCam / OpenAI
    const cards: Card[] = [
      // 1. 紋理 / Texture
      {
        id: "texture",
        title_en: "TEXTURE",
        title_zh: "紋理",
        score: 68,
        max: 100,
        signal_en:
          "Your skin texture needs more attention than 68% of your age group. This isn't a warning; it's where opportunity begins.",
        signal_zh:
          "你的肌膚紋理比 68% 的同齡族群更需要關注。這不是警告，而是機會的起點。",
        details: [
          { label_en: "Roughness", label_zh: "粗糙度", value: 72 },
          { label_en: "Smoothness", label_zh: "平滑度", value: 64 },
          { label_en: "Evenness", label_zh: "均勻度", value: 68 },
        ],
        recommendation_en:
          "Rebuilding the moisture barrier can improve visible texture by about 23% within 14 days.",
        recommendation_zh:
          "重建保濕屏障能在 14 天內改善約 23% 的紋理問題。",
        priority: 95,
        confidence: 0.9,
      },

      // 2. 毛孔 / Pore
      {
        id: "pore",
        title_en: "PORE",
        title_zh: "毛孔",
        score: 92,
        max: 100,
        signal_en:
          "This score proves you've made some key decisions right when it comes to cleansing and daily maintenance.",
        signal_zh:
          "這個數字證明，你在清潔與日常維護上，做對了某些關鍵決策。",
        details: [
          { label_en: "T-Zone", label_zh: "T 區", value: 88 },
          { label_en: "Cheek", label_zh: "臉頰", value: 95 },
          { label_en: "Chin", label_zh: "下巴", value: 93 },
        ],
        recommendation_en:
          "Maintain your current routine. Your pore condition is likely to stay within the ideal range.",
        recommendation_zh:
          "維持當前的護理節奏，你的毛孔狀態將持續保持在理想範圍。",
        priority: 80,
        confidence: 0.9,
      },

      // 3. 色斑 / Pigmentation
      {
        id: "pigmentation",
        title_en: "PIGMENTATION",
        title_zh: "色斑",
        score: 75,
        max: 100,
        signal_en:
          "Three areas of superficial pigmentation are detected, mainly across the cheeks. These signals are reversible with the right routine.",
        signal_zh:
          "檢測到 3 處淺層色素沉澱，主要分布在雙頰區域。這些都是可逆的訊號。",
        details: [
          { label_en: "Brown Spot", label_zh: "棕色斑", value: 78 },
          { label_en: "Red Area", label_zh: "紅色區", value: 82 },
          { label_en: "Dullness", label_zh: "暗沉度", value: 65 },
        ],
        recommendation_en:
          "Start a brightening serum protocol with consistent SPF. Up to 40% improvement is possible within 12 weeks.",
        recommendation_zh:
          "建議啟動美白精華療程並確實防曬，12 週內可望改善約 40%。",
        priority: 88,
        confidence: 0.88,
      },

      // 4. 皺紋 / Wrinkle
      {
        id: "wrinkle",
        title_en: "WRINKLE",
        title_zh: "皺紋",
        score: 80,
        max: 100,
        signal_en:
          "Fine lines around the eyes are within the normal aging range, and nasolabial folds have not yet formed deep creases.",
        signal_zh:
          "眼周細紋處於正常老化範圍，法令紋尚未形成深層摺痕。",
        details: [
          { label_en: "Eye Area", label_zh: "眼周", value: 76 },
          { label_en: "Forehead", label_zh: "額頭", value: 85 },
          { label_en: "Nasolabial", label_zh: "法令紋", value: 79 },
        ],
        recommendation_en:
          "Starting an anti-aging serum now can delay wrinkle deepening by an estimated 3–5 years.",
        recommendation_zh:
          "現在開始使用抗老精華，可望延緩皺紋加深約 3–5 年。",
        priority: 86,
        confidence: 0.9,
      },

      // 5. 水分 / Hydration
      {
        id: "hydration",
        title_en: "HYDRATION",
        title_zh: "水分",
        score: 61,
        max: 100,
        signal_en:
          "Skin hydration sits about 22% below the ideal band. Surface at 58 and deep at 64 indicate a compromised barrier.",
        signal_zh:
          "你的肌膚含水量低於理想值約 22%。表層含水 58、深層含水 64，顯示屏障功能受損。",
        details: [
          { label_en: "Surface", label_zh: "表層含水", value: 58 },
          { label_en: "Deep", label_zh: "深層含水", value: 64 },
          { label_en: "TEWL", label_zh: "經皮水分流失", value: "Moderate" },
        ],
        recommendation_en:
          "Use a ceramide-rich serum. With compliance, hydration index can move into the 70+ range within 14 days.",
        recommendation_zh:
          "建議使用含神經醯胺的精華液，持續 14 天可望將保濕指數提升至 70 以上。",
        priority: 98,
        confidence: 0.9,
      },

      // 6. 油脂 / Sebum
      {
        id: "sebum",
        title_en: "SEBUM",
        title_zh: "油脂",
        score: 73,
        max: 100,
        signal_en:
          "Sebum production is in a healthy balance. The T-zone is slightly elevated but still within a controllable window.",
        signal_zh:
          "油脂分泌處於健康平衡狀態，T 區略高但仍在可控範圍內。",
        details: [
          { label_en: "T-Zone", label_zh: "T 區", value: 82 },
          { label_en: "Cheek", label_zh: "臉頰", value: 64 },
          { label_en: "Chin", label_zh: "下巴", value: 73 },
        ],
        recommendation_en:
          "Maintain the current cleansing frequency and avoid over-cleansing that could disrupt this balance.",
        recommendation_zh:
          "維持目前的清潔頻率，避免過度清潔打亂這個平衡。",
        priority: 75,
        confidence: 0.87,
      },

      // 7. 膚色 / Skin Tone
      {
        id: "skintone",
        title_en: "SKIN TONE",
        title_zh: "膚色",
        score: 78,
        max: 100,
        signal_en:
          "Overall tone evenness is good with subtle variations around cheekbones and the sides of the nose.",
        signal_zh:
          "膚色均勻度表現良好，僅在顴骨與鼻翼兩側出現輕微色差。",
        details: [
          { label_en: "Evenness", label_zh: "均勻度", value: 78 },
          { label_en: "Brightness", label_zh: "亮度", value: 75 },
          { label_en: "Redness", label_zh: "紅色指數", value: 68 },
        ],
        recommendation_en:
          "Introducing niacinamide can further improve tone evenness by an additional 8–12%.",
        recommendation_zh:
          "加入菸鹼醯胺類產品，可進一步提升膚色均勻度約 8–12%。",
        priority: 82,
        confidence: 0.88,
      },

      // 8. 敏感度 / Sensitivity
      {
        id: "sensitivity",
        title_en: "SENSITIVITY",
        title_zh: "敏感度",
        score: 68,
        max: 100,
        signal_en:
          "Mild sensitivity signals detected: redness index at 65 and barrier function at 71, approaching the sensitive-skin threshold.",
        signal_zh:
          "檢測到輕微敏感跡象：泛紅指數 65、屏障功能 71，接近敏感肌門檻。",
        details: [
          { label_en: "Redness", label_zh: "泛紅指數", value: 65 },
          { label_en: "Barrier", label_zh: "屏障功能", value: 71 },
          { label_en: "Irritation", label_zh: "刺激反應", value: "Low" },
        ],
        recommendation_en:
          "Pivot to soothing formulas and avoid high-concentration acids or alcohol-heavy products.",
        recommendation_zh:
          "建議使用舒緩型保養品，暫時避開高濃度酸類與酒精含量高的產品。",
        priority: 90,
        confidence: 0.86,
      },
    ]

    return res.status(200).json({
      summary_en:
        "Neural skin analysis complete. Fourteen metrics processed; eight primary signals have been prioritized for review.",
      summary_zh:
        "神經式肌膚分析完成，已處理 14 項指標，並將 8 個關鍵訊號依優先度呈現。",
      cards,
    })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Scan failed" })
  }
}
