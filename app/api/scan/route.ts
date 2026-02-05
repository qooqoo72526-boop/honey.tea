// app/api/scan/route.ts
// HONEY.TEA — MVP Connection Test (Strict YouCam V2 Flow)
// 🎯 Domain: https://honeytea.framer.ai
// 🎯 Goal: Frontend -> Backend -> YouCam -> Backend -> Frontend

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60; // 給 API 足夠時間跑

const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";

// 設定你的網域 (CORS)
const ALLOWED_ORIGIN = "https://honeytea.framer.ai";

function corsHeaders(origin: string) {
    return {
        "Access-Control-Allow-Origin": "*", // 為了測試方便先開全通，上線可改 ALLOWED_ORIGIN
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function youcamWorkflow(file: File) {
    const apiKey = mustEnv("YOUCAM_API_KEY");
    
    // 1. Init (掛號)
    console.log("[Test] 1. Init...");
    const initRes = await fetch(`${YOUCAM_BASE}/file/skin-analysis`, {
        method: "POST", 
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ content_type: file.type, file_name: "scan.jpg", file_size: file.size }] })
    });
    
    if (!initRes.ok) throw new Error(`Init Failed: ${await initRes.text()}`);
    const initData = await initRes.json();
    const { file_id, requests } = initData.data.files[0];

    // 2. Upload (上傳 S3)
    console.log("[Test] 2. Uploading...");
    const bytes = await file.arrayBuffer();
    const uploadRes = await fetch(requests[0].url, { 
        method: "PUT", 
        headers: { 
            "Content-Type": file.type,
            "Content-Length": String(file.size) // 官方強制要求
        }, 
        body: bytes 
    });
    
    if (!uploadRes.ok) throw new Error("S3 Upload Failed");

    // 3. Task (開始分析 HD)
    console.log("[Test] 3. Task...");
    const hdActions = [
        "hd_texture", "hd_pore", "hd_wrinkle", "hd_redness", "hd_oiliness", 
        "hd_age_spot", "hd_radiance", "hd_moisture", "hd_firmness", 
        "hd_acne", "hd_dark_circle", "hd_eye_bag"
    ];

    const taskRes = await fetch(`${YOUCAM_BASE}/task/skin-analysis`, {
        method: "POST", 
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ 
            src_file_id: file_id, 
            dst_actions: hdActions,
            miniserver_args: { "enable_mask_overlay": false },
            format: "json" 
        })
    });
    
    if (!taskRes.ok) throw new Error(`Task Failed: ${await taskRes.text()}`);
    const taskData = await taskRes.json();
    const taskId = taskData.data.task_id;

    // 4. Poll (等結果)
    console.log("[Test] 4. Polling...");
    for (let i = 0; i < 40; i++) {
        await sleep(1500);
        const pollRes = await fetch(`${YOUCAM_BASE}/task/skin-analysis/${taskId}`, { 
            headers: { Authorization: `Bearer ${apiKey}` } 
        });
        const pollData = await pollRes.json();
        
        if (pollData?.data?.task_status === "success") {
            return pollData.data.results.output; // ✅ 拿到貨了，直接回傳
        }
    }
    throw new Error("YouCam Timeout");
}

export async function POST(req: Request) {
    const origin = req.headers.get("origin") || "";
    try {
        const formData = await req.formData();
        const file = formData.get("image1") as File;
        
        // 執行 YouCam 流程
        const rawData = await youcamWorkflow(file);

        // 回傳給前端
        return NextResponse.json({
            status: "success",
            data: rawData
        }, { status: 200, headers: corsHeaders(origin) });

    } catch (e: any) {
        console.error("[API Error]", e);
        return NextResponse.json({ 
            status: "error", 
            message: String(e.message || e) 
        }, { status: 500, headers: corsHeaders(origin) });
    }
}

export async function OPTIONS(req: Request) {
    const origin = req.headers.get("origin") || "";
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}
