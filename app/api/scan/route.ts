// app/api/scan/route.ts
// HONEY.TEA — MVP Connection Test (Strict YouCam V2 Flow)
// 🎯 Goal: Verify "Init -> Upload -> Task -> Poll" sequence
// ⚠️ Coze is DISABLED. We are testing the "Eyes" (YouCam) first.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60; // Pro Tier Timeout

// 官方 V2 端點
const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function youcamWorkflow(file: File) {
    const apiKey = mustEnv("YOUCAM_API_KEY");
    
    // --- STEP 1: INIT (掛號) ---
    // 官方要求：必須先傳 file_size 和 content_type
    console.log("[YouCam] Step 1: Init (Requesting Upload URL)...");
    const initRes = await fetch(`${YOUCAM_BASE}/file/skin-analysis`, {
        method: "POST", 
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ 
            files: [{ 
                content_type: file.type, 
                file_name: "scan.jpg", 
                file_size: file.size // ⚠️ 關鍵：沒這個會被拒絕
            }] 
        })
    });
    
    if (!initRes.ok) {
        const err = await initRes.text();
        throw new Error(`Init Failed: ${err}`);
    }
    const initData = await initRes.json();
    const { file_id, requests } = initData.data.files[0];
    const uploadUrl = requests[0].url; // 這是 S3 的「准考證」
    console.log("[YouCam] Got File ID:", file_id);

    // --- STEP 2: UPLOAD (進場) ---
    // 官方要求：直接對 uploadUrl 做 PUT，且必須帶 Content-Length
    console.log("[YouCam] Step 2: Uploading to S3...");
    const bytes = await file.arrayBuffer();
    const uploadRes = await fetch(uploadUrl, { 
        method: "PUT", 
        headers: { 
            "Content-Type": file.type,
            "Content-Length": String(file.size) // ⚠️ 企業級規範：S3 強制要求
        }, 
        body: bytes 
    });
    
    if (!uploadRes.ok) throw new Error(`S3 Upload Failed: ${uploadRes.status}`);
    console.log("[YouCam] Upload Success");

    // --- STEP 3: TASK (考試) ---
    // 官方要求：指定 src_file_id 和 dst_actions (HD Only)
    console.log("[YouCam] Step 3: Starting Analysis Task...");
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
    
    if (!taskRes.ok) {
        const err = await taskRes.text();
        throw new Error(`Task Start Failed: ${err}`);
    }
    const taskData = await taskRes.json();
    const taskId = taskData.data.task_id;
    console.log("[YouCam] Task Started. ID:", taskId);

    // --- STEP 4: POLL (查榜) ---
    // 官方要求：輪詢直到 status='success'
    console.log("[YouCam] Step 4: Polling for Results...");
    for (let i = 0; i < 40; i++) {
        await sleep(1500); // 等 1.5 秒
        const pollRes = await fetch(`${YOUCAM_BASE}/task/skin-analysis/${taskId}`, { 
            headers: { Authorization: `Bearer ${apiKey}` } 
        });
        const pollData = await pollRes.json();
        const status = pollData?.data?.task_status;
        console.log(`[YouCam] Poll ${i}: ${status}`);

        if (status === "success") {
            return pollData.data.results.output; // ✅ 拿到數據了！
        }
        if (status === "error") throw new Error(`YouCam Analysis Error: ${JSON.stringify(pollData)}`);
    }
    throw new Error("YouCam Timeout");
}

export async function POST(req: Request) {
    const origin = req.headers.get("origin") || "";
    const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    try {
        const formData = await req.formData();
        const file = formData.get("image1") as File;
        if (!file) throw new Error("No image");

        // 執行官方流程
        const rawOutput = await youcamWorkflow(file);

        // 回傳原始數據給前端 Alert
        return NextResponse.json({
            status: "success",
            message: "YouCam Connection Verified",
            raw_data: rawOutput
        }, { headers: cors });

    } catch (e: any) {
        console.error("[Test Error]", e);
        return NextResponse.json({ 
            status: "error", 
            message: String(e.message || e) 
        }, { status: 500, headers: cors });
    }
}

export async function OPTIONS(req: Request) {
    const origin = req.headers.get("origin") || "";
    return new NextResponse(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
    });
}
