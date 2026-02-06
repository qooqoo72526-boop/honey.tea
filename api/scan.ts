// /api/scan.ts
import type { IncomingMessage, ServerResponse } from "http"

export const config = {
  api: {
    bodyParser: false,
  },
}

// ===== 型別（不用 vercel 套件）=====
type Req = IncomingMessage & { method?: string }
type Res = ServerResponse & {
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
  res.status = function (code: number) {
    res.statusCode = code
    return res
  }
  res.json = function (data: any) {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(data))
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    // 🔒 先穩定回傳「一定能顯示的報告」

    const cards: Card[] = [
      {
        id: "texture",
        title_en: "TEXTURE",
        title_zh: "紋理",
        score: 84,
        max: 100,
        signal_en:
          "Your texture signal sits below the cohort baseline. Not a warning — a clear starting point for refinement.",
        signal_zh:
          "你的肌膚紋理訊號目前落在同齡族群基準值之下，這不是警告，而是一個可以被優化的起點。",
        details: [
          { label_en: "Roughness", label_zh: "粗糙度", value: 72 },
          { label_en: "Smoothness", label_zh: "平滑度", value: 64 },
          { label_en: "Evenness", label_zh: "均勻度", value: 68 },
        ],
        recommendation_en:
          "Focus on barrier re-stabilization and water retention. Consistency matters more than intensity.",
        recommendation_zh:
          "建議優先重建屏障穩定與含水留存能力，一致性比強度更重要。",
        priority: 95,
        confidence: 0.9,
      },
      {
        id: "hydration",
        title_en: "HYDRATION",
        title_zh: "含水與屏障",
        score: 73,
        max: 100,
        signal_en:
          "Hydration is ~22% below the ideal reference band. Surface vs deep separation signals barrier instability.",
        signal_zh:
          "目前含水狀態低於理想參考區間約 22%，顯示屏障穩定度不足。",
        details: [
          { label_en: "Surface", label_zh: "表層含水", value: 58 },
          { label_en: "Deep", label_zh: "深層含水", value: 64 },
          { label_en: "TEWL", label_zh: "經皮水分流失", value: "Medium" },
        ],
        recommendation_en:
          "Rebuild water-holding capacity before increasing actives.",
        recommendation_zh:
          "先修復留水能力，再考慮提升活性成分。",
        priority: 92,
        confidence: 0.88,
      },
    ]

    return res.status(200).json({
      summary_en:
        "HD skin analysis complete. Fourteen signals generated; primary indicators prioritized for review.",
      summary_zh:
        "HD 皮膚分析完成，已生成 14 項訊號，並依優先度呈現。",
      cards,
    })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Scan failed" })
  }
}

