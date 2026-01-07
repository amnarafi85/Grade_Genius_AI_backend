// viva.ts (COMPLETE)  7NHsDr>\1>:0.<J
// ✅ Adds deep debug logs + FK/RLS checks so you can SEE why viva_sessions is not inserting
// ✅ Works with YOUR REAL DB: teachers/students + viva_configs/viva_sessions
// ✅ Also fixes common issues: status mismatch, missing JSON parsing, wrong engine mapping,
//    and prints Supabase project ref so you can confirm you’re looking at the same DB.

import { Express, Request, Response } from "express";
import multer from "multer";
import { SupabaseClient } from "@supabase/supabase-js";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import path from "path";
import fs from "fs";
import sharp, { OutputInfo } from "sharp";
import fetch from "node-fetch";
import Tesseract from "tesseract.js";
// @ts-ignore
import { convert } from "pdf-poppler";
const pdfParse = require("pdf-parse");

// ✅ multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// ✅ Optional validation lists
const ALLOWED_DIFFICULTY = ["easy", "medium", "hard"] as const;
const ALLOWED_VIVA_TYPES = ["basic", "conceptual", "application", "critical"] as const;

// ============================================================
// ✅ Helpers
// ============================================================

const stripGarbage = (s: string) =>
  (s || "")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

const isMeaningful = (s: string) => {
  const clean = (s || "").replace(/[^a-zA-Z0-9]/g, "");
  return clean.length >= 30;
};

// Cap base64 data-uri (~19MB)
async function toDataURIWithCap(imgPath: string, maxBytes = 19 * 1024 * 1024): Promise<string> {
  let buf: Buffer = fs.readFileSync(imgPath) as Buffer;
  const meta = await sharp(buf).metadata();
  let width = meta.width || 2600;

  while (buf.byteLength > maxBytes && width > 900) {
    width = Math.floor(width * 0.85);
    const next: Buffer = await sharp(buf)
      .resize({ width })
      .png({ compressionLevel: 9 })
      .toBuffer();
    buf = next;
  }

  return `data:image/png;base64,${buf.toString("base64")}`;
}

// ============================================================
// ✅ GOOGLE VISION: Images MultiVariant OCR
// ============================================================
async function ocrWithVisionImagesMultiVariant(
  visionClient: ImageAnnotatorClient,
  pdfPath: string,
  baseKey: string
) {
  console.log("🖼️ Vision OCR Images++ (DPI 350)");

  const outputBase = path.join(__dirname, `page_${baseKey}`);
  const opts: any = {
    format: "jpeg",
    out_dir: path.dirname(outputBase),
    out_prefix: `page_${baseKey}`,
    page: null,
    dpi: 350,
  };

  await convert(pdfPath, opts);

  const dir = path.dirname(outputBase);
  const imageFiles = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`page_${baseKey}`) && f.endsWith(".jpg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  let mergedDoc = "";

  for (const img of imageFiles) {
    const imgPath = path.join(dir, img);
    console.log("📸 OCR image:", img);

    const variants: Array<{ path: string }> = [];
    const variantBuilds: Array<Promise<OutputInfo>> = [];

    const addVariant = (p: string, pipeline: sharp.Sharp) => {
      variants.push({ path: p });
      variantBuilds.push(pipeline.toFile(p));
    };

    const base = sharp(imgPath).resize({ width: 2500 }).grayscale().normalize().median(1);
    addVariant(imgPath.replace(".jpg", "_v1_light.jpg"), base.clone().sharpen());
    addVariant(imgPath.replace(".jpg", "_v2_t150.jpg"), base.clone().threshold(150));
    addVariant(imgPath.replace(".jpg", "_v3_t175.jpg"), base.clone().threshold(175));

    await Promise.allSettled(variantBuilds);

    let bestText = "";

    for (const v of variants) {
      if (!fs.existsSync(v.path)) continue;
      try {
        const [result] = await visionClient.documentTextDetection({
          image: { source: { filename: v.path } },
          imageContext: { languageHints: ["en"] },
        });

        const text = stripGarbage(result.fullTextAnnotation?.text || "");
        if (text.length > bestText.length) bestText = text;
      } catch (e: any) {
        console.warn("⚠️ Vision OCR failed:", e.message);
      }

      try {
        fs.unlinkSync(v.path);
      } catch {}
    }

    if (bestText && isMeaningful(bestText)) mergedDoc += bestText + "\n\n";

    try {
      fs.unlinkSync(imgPath);
    } catch {}
  }

  return mergedDoc.trim();
}

// ============================================================
// ✅ GOOGLE VISION: PDF Native OCR
// ============================================================
async function ocrWithVisionPdfNative(visionClient: ImageAnnotatorClient, pdfPath: string) {
  console.log("📄 Vision OCR PDF Native");

  const input = {
    mimeType: "application/pdf",
    content: fs.readFileSync(pdfPath),
  };

  const request = [
    {
      features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      inputConfig: input as any,
    },
  ];

  const [result] = await (visionClient as any).asyncBatchAnnotateFiles({
    requests: request,
  });

  const [operation] = result;
  const [filesResponse] = await operation.promise();

  let out = "";
  for (const f of filesResponse?.responses || []) {
    const r = f?.responses?.[0];
    const text = stripGarbage(r?.fullTextAnnotation?.text || "");
    if (text) out += text + "\n\n";
  }

  return out.trim();
}

// ============================================================
// ✅ TESSERACT OCR
// ============================================================
async function ocrWithTesseract(pdfPath: string, baseKey: string) {
  console.log("🔡 Tesseract fallback");

  const outputBase = path.join(__dirname, `tess_${baseKey}`);
  await convert(pdfPath, {
    format: "jpeg",
    out_dir: path.dirname(outputBase),
    out_prefix: `tess_${baseKey}`,
    page: null,
    dpi: 300,
  });

  const dir = path.dirname(outputBase);
  const imageFiles = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`tess_${baseKey}`) && f.endsWith(".jpg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  let merged = "";

  for (const img of imageFiles) {
    const imgPath = path.join(dir, img);
    try {
      const { data } = await Tesseract.recognize(imgPath, "eng", {
        tessedit_pageseg_mode: 6,
      } as any);

      const txt = stripGarbage(data?.text || "");
      if (txt && isMeaningful(txt)) merged += txt + "\n\n";
    } catch {}

    try {
      fs.unlinkSync(imgPath);
    } catch {}
  }

  return merged.trim();
}

// ============================================================
// ✅ OpenAI Vision OCR
// ============================================================
async function ocrWithOpenAIOCR(pdfPath: string) {
  console.log("🧠 OpenAI OCR");

  const outputBase = path.join(__dirname, `openai_${Date.now()}`);
  await convert(pdfPath, {
    format: "png",
    out_dir: path.dirname(outputBase),
    out_prefix: path.basename(outputBase),
    page: null,
    dpi: 420,
  });

  const dir = path.dirname(outputBase);

  const rawImages = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(path.basename(outputBase)) && f.endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  let allText = "";

  for (const img of rawImages) {
    const raw = path.join(dir, img);
    const preOut = raw.replace(".png", "_pre.png");

    await sharp(raw)
      .resize({ width: 2400 })
      .grayscale()
      .normalize()
      .median(1)
      .sharpen()
      .png({ compressionLevel: 9 })
      .toFile(preOut);

    const dataURI = await toDataURIWithCap(preOut);
    let pageText = "";

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_OCR_MODEL || "gpt-4o-mini",
        temperature: 0,
        max_output_tokens: 4096,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: "Extract ALL text. Preserve line breaks." }],
          },
          {
            role: "user",
            content: [{ type: "input_image", image_url: dataURI }],
          },
        ],
      }),
    });

    if (response.ok) {
      const data: any = await response.json();
      const extracted = data.output_text || data.output?.[0]?.content?.[0]?.text || "";
      pageText = stripGarbage(extracted);
    } else {
      const t = await response.text();
      console.warn("⚠️ OpenAI OCR HTTP error:", response.status, t);
    }

    if (pageText && isMeaningful(pageText)) allText += pageText + "\n\n";

    try {
      fs.unlinkSync(preOut);
    } catch {}
    try {
      fs.unlinkSync(raw);
    } catch {}
  }

  return allText.trim();
}

// ============================================================
// ✅ Debug utilities
// ============================================================

function maskUrl(u?: string) {
  if (!u) return "";
  try {
    const url = new URL(u);
    // show only project ref like https://xxxxx.supabase.co
    return `${url.protocol}//${url.host}`;
  } catch {
    return u;
  }
}

function logSupabaseProjectInfo() {
  console.log("🔧 Supabase URL:", maskUrl(process.env.SUPABASE_URL));
  // Helpful: project ref is host subdomain
  try {
    const host = new URL(process.env.SUPABASE_URL || "").host;
    const ref = host.split(".")[0];
    console.log("🔧 Supabase Project Ref (from env):", ref);
  } catch {}
}

async function ensureTeacherExists(supabase: SupabaseClient, teacher_id: string) {
  const { data, error } = await supabase.from("teachers").select("id,email").eq("id", teacher_id).maybeSingle();
  if (error) {
    console.error("❌ teachers lookup error:", error);
    return { ok: false, reason: "teachers lookup failed", error };
  }
  if (!data) {
    return {
      ok: false,
      reason:
        "teacher_id not found in teachers table. FK teacher_id -> teachers(id) will FAIL. " +
        "If you’re sending auth.uid(), make sure you insert teachers row with id = auth.uid().",
    };
  }
  return { ok: true, teacher: data };
}

async function ensureConfigExists(supabase: SupabaseClient, config_id: string) {
  const { data, error } = await supabase
    .from("viva_configs")
    .select("id,teacher_id,title")
    .eq("id", config_id)
    .maybeSingle();

  if (error) {
    console.error("❌ viva_configs lookup error:", error);
    return { ok: false, reason: "viva_configs lookup failed", error };
  }
  if (!data) return { ok: false, reason: "config_id not found in viva_configs table" };
  return { ok: true, config: data };
}

// ============================================================
// ✅ Viva Routes Setup
// ============================================================
export function setupVivaRoutes(app: Express, supabase: SupabaseClient, visionClient: ImageAnnotatorClient) {
  console.log("✅ Viva routes loaded");
  logSupabaseProjectInfo();

  // ✅ OPTIONS preflight (CORS)
  app.options("/viva/*", (_req, res) => res.sendStatus(200));

  // ============================================================
  // ✅ STEP 2: Upload Viva Material
  // ============================================================
  app.post("/viva/upload-material", upload.single("file"), async (req: Request, res: Response) => {
    try {
      console.log("📥 /viva/upload-material hit");
      console.log("BODY:", {
        teacher_id: req.body?.teacher_id,
        title: req.body?.title,
        difficulty: req.body?.difficulty,
        viva_type: req.body?.viva_type,
      });

      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const teacherId = req.body.teacher_id as string;
      const title = req.body.title || null;
      const difficulty = req.body.difficulty || "medium";
      const vivaType = req.body.viva_type || "basic";

      let markingScheme: any = req.body.marking_scheme || { full: 1, half: 0.5, zero: 0 };

      if (!teacherId) return res.status(400).json({ error: "teacher_id required" });
      if (!ALLOWED_DIFFICULTY.includes(difficulty)) return res.status(400).json({ error: "Invalid difficulty" });
      if (!ALLOWED_VIVA_TYPES.includes(vivaType)) return res.status(400).json({ error: "Invalid viva_type" });

      // Parse marking scheme if sent as JSON string
      if (typeof markingScheme === "string") {
        try {
          markingScheme = JSON.parse(markingScheme);
        } catch {
          return res.status(400).json({ error: "marking_scheme must be valid JSON" });
        }
      }

      // ✅ FK check early so you don’t upload file if teacher invalid
      const teacherCheck = await ensureTeacherExists(supabase, teacherId);
      if (!teacherCheck.ok) {
        console.error("❌ Upload blocked:", teacherCheck.reason);
        return res.status(400).json({ error: teacherCheck.reason });
      }

      const { originalname, buffer, mimetype } = req.file;
      console.log("📂 Uploading:", originalname);

      const storagePath = `viva/${teacherId}/${Date.now()}-${originalname}`;
      const { data: fileData, error: uploadError } = await supabase.storage
        .from("quizzes")
        .upload(storagePath, buffer, { contentType: mimetype });

      if (uploadError) {
        console.error("❌ storage upload error:", uploadError);
        return res.status(500).json({ error: uploadError.message, details: uploadError });
      }

      console.log("✅ Storage upload ok:", fileData?.path);

      const { data: config, error: insertError } = await supabase
        .from("viva_configs")
        .insert([
          {
            teacher_id: teacherId,
            title,
            material_pdf: fileData.path,
            extracted_text: null,
            difficulty,
            viva_type: vivaType,
            marking_scheme: markingScheme,
            questions_json: null,
          },
        ])
        .select()
        .single();

      if (insertError) {
        console.error("❌ viva_configs insert error:", insertError);
        return res.status(500).json({ error: insertError.message, details: insertError });
      }

      console.log("✅ viva_configs inserted:", config?.id);

      return res.json({ success: true, config });
    } catch (err: any) {
      console.error("❌ upload-material crash:", err);
      return res.status(500).json({ error: err?.message || "Unknown error" });
    }
  });

  // ============================================================
  // ✅ STEP 3: OCR Process Material
  // ============================================================
  app.post("/viva/process-material/:configId", async (req: Request, res: Response) => {
    try {
      console.log("📥 /viva/process-material hit");
      const configId = req.params.configId;

      // ✅ engine mapping (frontend sends "openai-ocr" but old code didn't handle it)
      const engineRaw = (req.query.engine as string) || "auto";
      const engine = engineRaw === "openai-ocr" ? "openai-ocr" : engineRaw;

      console.log("PARAMS:", { configId, engine });

      const { data: config, error } = await supabase.from("viva_configs").select("*").eq("id", configId).single();
      if (error || !config) {
        console.error("❌ config not found:", error);
        return res.status(404).json({ error: "Config not found" });
      }

      const { data: file, error: downloadError } = await supabase.storage.from("quizzes").download(config.material_pdf);
      if (downloadError || !file) {
        console.error("❌ download error:", downloadError);
        throw new Error("Failed to download PDF");
      }

      const tempPdfPath = path.join(__dirname, `temp_viva_${configId}.pdf`);
      fs.writeFileSync(tempPdfPath, Buffer.from(await (file as any).arrayBuffer()));

      let extractedText = "";

      const tryPdfParse = async () => {
        try {
          const pdfBuffer = fs.readFileSync(tempPdfPath);
          const pdfData = await pdfParse(pdfBuffer);
          return stripGarbage(pdfData.text || "");
        } catch {
          return "";
        }
      };

      // ✅ Engine strategy
      if (engine === "vision-pdf") extractedText = await ocrWithVisionPdfNative(visionClient, tempPdfPath);
      else extractedText = await tryPdfParse();

      if (!isMeaningful(extractedText) && engine === "openai-ocr") extractedText = await ocrWithOpenAIOCR(tempPdfPath);
      if (!isMeaningful(extractedText)) extractedText = await ocrWithOpenAIOCR(tempPdfPath);
      if (!isMeaningful(extractedText))
        extractedText = await ocrWithVisionImagesMultiVariant(visionClient, tempPdfPath, configId);
      if (!isMeaningful(extractedText)) extractedText = await ocrWithTesseract(tempPdfPath, configId);

      const { error: updateError } = await supabase
        .from("viva_configs")
        .update({ extracted_text: extractedText })
        .eq("id", configId);

      if (updateError) console.error("❌ extracted_text update error:", updateError);

      try {
        fs.unlinkSync(tempPdfPath);
      } catch {}

      console.log("✅ OCR done, length:", extractedText.length);

      return res.json({ success: true, extracted_text_length: extractedText.length, extracted_text: extractedText });
    } catch (err: any) {
      console.error("❌ OCR error:", err);
      return res.status(500).json({ error: err?.message || "OCR failed" });
    }
  });

  // ============================================================
  // ✅ STEP 4: Generate Questions
  // ============================================================
  app.post("/viva/generate-questions/:configId", async (req: Request, res: Response) => {
    try {
      console.log("📥 /viva/generate-questions hit");
      const configId = req.params.configId;

      const numQuestions = Math.min(Math.max(Number(req.body?.num_questions || 10), 3), 12);
      console.log("PARAMS:", { configId, numQuestions });

      const { data: config, error } = await supabase.from("viva_configs").select("*").eq("id", configId).single();
      if (error || !config) return res.status(404).json({ error: "Config not found" });
      if (!config.extracted_text || config.extracted_text.length < 30)
        return res.status(400).json({ error: "OCR text missing" });

      const prompt = `
You are a teacher generating viva questions.

Generate ${numQuestions} viva questions from the material below.
Difficulty: ${config.difficulty}
Type: ${config.viva_type}

Return JSON like:
{ "questions": [ { "question": "", "ideal_answer": "", "difficulty":"", "type":"" } ] }
      `.trim();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const openaiResp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.3,
          max_output_tokens: 2500,
          input: [
            { role: "system", content: [{ type: "input_text", text: "Return ONLY JSON. No markdown." }] },
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_text", text: `Material:\n${config.extracted_text}` },
              ],
            },
          ],
        }),
      });

      clearTimeout(timeout);

      if (!openaiResp.ok) {
        const errText = await openaiResp.text();
        console.error("❌ OpenAI error:", errText);
        return res.status(500).json({ error: "OpenAI failed", details: errText });
      }

      const raw: any = await openaiResp.json();
      const extracted =
        raw?.output?.[0]?.content?.find((c: any) => c.type === "output_text")?.text || raw?.output_text || "";

      if (!extracted) return res.status(500).json({ error: "OpenAI returned empty output", raw });

      let parsed: any;
      try {
        parsed = JSON.parse(extracted);
      } catch {
        return res.status(500).json({ error: "Invalid JSON from OpenAI", raw_output: extracted });
      }

      const questions = parsed.questions || [];
      console.log("✅ Questions generated:", Array.isArray(questions) ? questions.length : 0);

      const { error: updateErr } = await supabase
        .from("viva_configs")
        .update({ questions_json: { questions } })
        .eq("id", configId);

      if (updateErr) {
        console.error("❌ Supabase questions_json update failed:", updateErr);
        return res.status(500).json({ error: "Failed to save questions_json", details: updateErr });
      }

      return res.json({ success: true, config_id: configId, num_questions: questions.length, questions });
    } catch (err: any) {
      console.error("❌ generate-questions error:", err);
      return res.status(500).json({ error: err?.message || "generate-questions failed" });
    }
  });

  // ============================================================
  // ✅ STEP 5: Create Viva Session (DEEP DEBUG)
  // ============================================================
  app.post("/viva/create-session", async (req: Request, res: Response) => {
    try {
      console.log("📥 /viva/create-session hit");
      console.log("HEADERS origin:", req.headers.origin);
      console.log("BODY raw:", req.body);

      const { teacher_id, student_id, config_id } = (req.body || {}) as {
        teacher_id?: string;
        student_id?: string | null;
        config_id?: string;
      };

      if (!teacher_id || !config_id) {
        console.log("❌ Missing teacher_id or config_id");
        return res.status(400).json({ error: "teacher_id and config_id are required", got: { teacher_id, config_id } });
      }

      // ✅ 1) Verify teacher exists (FK teacher_id -> teachers.id)
      const teacherCheck = await ensureTeacherExists(supabase, teacher_id);
      if (!teacherCheck.ok) {
        console.error("❌ teacher check failed:", teacherCheck.reason);
        return res.status(400).json({ error: teacherCheck.reason });
      }
      console.log("✅ teacher exists:", (teacherCheck as any).teacher);

      // ✅ 2) Verify config exists (FK config_id -> viva_configs.id)
      const configCheck = await ensureConfigExists(supabase, config_id);
      if (!configCheck.ok) {
        console.error("❌ config check failed:", configCheck.reason);
        return res.status(400).json({ error: configCheck.reason });
      }
      console.log("✅ config exists:", (configCheck as any).config);

      // ✅ 3) Ensure config belongs to teacher (common mismatch)
      const cfg = (configCheck as any).config;
      if (cfg.teacher_id && cfg.teacher_id !== teacher_id) {
        console.error("❌ config.teacher_id mismatch", { config_teacher_id: cfg.teacher_id, teacher_id });
        return res.status(400).json({
          error: "config does not belong to this teacher_id",
          config_teacher_id: cfg.teacher_id,
          teacher_id,
        });
      }

      // ✅ 4) OPTIONAL: if student_id provided, validate it exists
      if (student_id) {
        const { data: st, error: stErr } = await supabase
          .from("students")
          .select("id,name")
          .eq("id", student_id)
          .maybeSingle();

        if (stErr) console.error("⚠️ student lookup error:", stErr);
        if (!st) {
          console.error("❌ student_id not found:", student_id);
          return res.status(400).json({ error: "student_id not found in students table", student_id });
        }
        console.log("✅ student exists:", st);
      } else {
        console.log("ℹ️ student_id is null (allowed if your schema allows null)");
      }

      // ✅ IMPORTANT: your DB expects status like pending/ready/in_progress/done
      // Do NOT use "draft"
      const rowToInsert: any = {
        teacher_id,
        student_id: student_id || null,
        config_id,
        status: "pending",
        current_index: 0,
        total_score: 0,
        max_score: 0,
      };

      console.log("➡️ Attempt insert into viva_sessions:", rowToInsert);

      const { data: session, error } = await supabase.from("viva_sessions").insert([rowToInsert]).select().single();

      if (error) {
        console.error("❌ INSERT FAILED viva_sessions:", error);
        // Common: FK violations, RLS, wrong project, bad schema, etc.
        return res.status(500).json({
          error: error.message,
          details: error,
          hint:
            "If details show FK violation: teacher_id must exist in teachers, config_id must exist in viva_configs. " +
            "If details show RLS: either disable RLS for viva_sessions or add policy / use service role key. " +
            "If nothing shows: verify SUPABASE_URL project ref matches dashboard.",
        });
      }

      console.log("✅ INSERT OK viva_sessions id:", session?.id);

      // Extra: double-check read-back
      const { data: verify, error: vErr } = await supabase
        .from("viva_sessions")
        .select("id,teacher_id,student_id,config_id,status,created_at")
        .eq("id", session.id)
        .maybeSingle();

      if (vErr) console.error("⚠️ verify read error:", vErr);
      console.log("🔎 verify inserted row:", verify);

      return res.json({ success: true, session: verify || session });
    } catch (err: any) {
      console.error("❌ create-session crash:", err);
      return res.status(500).json({ error: err?.message || "create-session failed" });
    }
  });

  // ============================================================
  // ✅ Vapi Create Call Response Type
  // ============================================================
  type VapiCreateCallResponse = {
    id?: string;
    call?: { id?: string };
    statusCode?: number;
    message?: string;
    error?: string;
    subscriptionLimits?: any;
  };

  // ============================================================
  // ✅ Start Call (Phone)
  // ============================================================
  app.post("/viva/start-call/:sessionId", async (req: Request, res: Response) => {
    try {
      console.log("📥 /viva/start-call hit");
      const sessionId = req.params.sessionId;

      const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
      const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
      const PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID;

      if (!VAPI_PRIVATE_KEY || !ASSISTANT_ID || !PHONE_NUMBER_ID) {
        return res.status(400).json({
          error: "Missing VAPI_PRIVATE_KEY / VAPI_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID in .env",
        });
      }

      const { phoneNumber } = (req.body || {}) as { phoneNumber?: string };

      const payload: any = {
        assistantId: ASSISTANT_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        metadata: { session_id: sessionId },
      };

      if (phoneNumber && phoneNumber.trim()) {
        payload.customer = { number: phoneNumber.trim() };
      }

      const response = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as VapiCreateCallResponse;

      if (!response.ok) {
        console.error("❌ Vapi create call failed:", data);
        return res.status(500).json({ error: data });
      }

      const callId = data?.id || data?.call?.id;

      const { error: updErr } = await supabase
        .from("viva_sessions")
        .update({ vapi_call_id: callId, status: "in_progress" })
        .eq("id", sessionId);

      if (updErr) console.error("❌ viva_sessions update vapi_call_id failed:", updErr);

      return res.json({ success: true, call: data, call_id: callId });
    } catch (err: any) {
      console.error("❌ start-call error:", err);
      return res.status(500).json({ error: err?.message || "start-call failed" });
    }
  });

  // ============================================================
  // ✅ Start WEB Call (Inbound Web Call)
  // ============================================================
  app.post("/viva/start-web-call/:sessionId", async (req: Request, res: Response) => {
    try {
      console.log("📥 /viva/start-web-call hit");
      const sessionId = req.params.sessionId;

      const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
      const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

      if (!VAPI_PRIVATE_KEY || !ASSISTANT_ID) {
        return res.status(400).json({
          error: "Missing VAPI_PRIVATE_KEY / VAPI_ASSISTANT_ID in .env",
        });
      }

      const payload: any = {
        assistantId: ASSISTANT_ID,
        metadata: { session_id: sessionId },
      };

      const response = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as VapiCreateCallResponse;

      if (!response.ok) {
        console.error("❌ Vapi create web call failed:", data);
        return res.status(500).json({ error: data });
      }

      const callId = data?.id || data?.call?.id;

      const { error: updErr } = await supabase
        .from("viva_sessions")
        .update({ vapi_call_id: callId, status: "in_progress" })
        .eq("id", sessionId);

      if (updErr) console.error("❌ viva_sessions update vapi_call_id failed:", updErr);

      return res.json({ success: true, call: data, call_id: callId });
    } catch (err: any) {
      console.error("❌ start-web-call error:", err);
      return res.status(500).json({ error: err?.message || "start-web-call failed" });
    }
  });

  // ============================================================
  // ✅ TOOL: next_question
  // ============================================================
  app.post("/viva/next-question", async (req: Request, res: Response) => {
    try {
      const session_id = req.body?.session_id as string;
      if (!session_id) return res.status(400).json({ error: "session_id required" });

      const { data: session, error: sErr } = await supabase.from("viva_sessions").select("*").eq("id", session_id).single();
      if (sErr || !session) return res.status(404).json({ error: "Session not found" });

      const { data: config, error: cErr } = await supabase.from("viva_configs").select("*").eq("id", session.config_id).single();
      if (cErr || !config) return res.status(404).json({ error: "Config not found for this session" });

      const questions = config?.questions_json?.questions || config?.questions_json || [];
      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "No questions found for this config" });
      }

      const idx = Number(session.current_index || 0);
      if (idx >= questions.length) {
        await supabase.from("viva_sessions").update({ status: "done" }).eq("id", session_id);
        return res.json({ done: true, session_id });
      }

      const q = questions[idx];
      const question_id = q?.id || q?.question_id || String(idx);
      const question = q?.question || q?.text || "";

      if (!question) return res.status(500).json({ error: "Question text missing in DB" });

      return res.json({ done: false, session_id, question_id, question });
    } catch (err: any) {
      console.error("❌ next-question error:", err);
      return res.status(500).json({ error: err?.message || "next-question failed" });
    }
  });

  // ============================================================
  // ✅ TOOL: grade_answer (simple heuristic grading)
  // ============================================================
  app.post("/viva/grade-answer", async (req: Request, res: Response) => {
    try {
      const session_id = req.body?.session_id as string;
      const question_id = req.body?.question_id as string;
      const student_answer = (req.body?.student_answer || "") as string;

      if (!session_id) return res.status(400).json({ error: "session_id required" });
      if (!question_id) return res.status(400).json({ error: "question_id required" });
      if (!student_answer.trim()) return res.status(400).json({ error: "student_answer required" });

      const { data: session, error: sErr } = await supabase.from("viva_sessions").select("*").eq("id", session_id).single();
      if (sErr || !session) return res.status(404).json({ error: "Session not found" });

      const { data: config, error: cErr } = await supabase.from("viva_configs").select("*").eq("id", session.config_id).single();
      if (cErr || !config) return res.status(404).json({ error: "Config not found for this session" });

      const questions = config?.questions_json?.questions || config?.questions_json || [];
      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "No questions found for this config" });
      }

      const idx = Number(session.current_index || 0);
      const q = questions[idx] || {};
      const ideal_answer = (q?.ideal_answer || q?.answer || "") as string;

      const scheme = config?.marking_scheme || { full: 1, half: 0.5, zero: 0 };
      const max_score = scheme?.full ?? 1;

      let score = scheme?.zero ?? 0;
      let feedback = "Thanks. Let's move to the next question.";

      const ans = student_answer.toLowerCase();
      const ideal = (ideal_answer || "").toLowerCase();

      if (ideal && ans && (ideal.includes(ans.slice(0, 12)) || ans.includes(ideal.slice(0, 12)))) {
        score = scheme?.full ?? 1;
        feedback = "Good answer.";
      } else if (student_answer.trim().length > 20) {
        score = scheme?.half ?? 0.5;
        feedback = "Decent attempt—try to be a bit more specific.";
      } else {
        score = scheme?.zero ?? 0;
        feedback = "That’s okay—let’s continue.";
      }

      const new_total = Number(session.total_score || 0) + Number(score || 0);
      const new_max = Number(session.max_score || 0) + Number(max_score || 0);
      const new_index = idx + 1;

      await supabase
        .from("viva_sessions")
        .update({ total_score: new_total, max_score: new_max, current_index: new_index })
        .eq("id", session_id);

      return res.json({ success: true, feedback, score, max_score });
    } catch (err: any) {
      console.error("❌ grade-answer error:", err);
      return res.status(500).json({ error: err?.message || "grade-answer failed" });
    }
  });
}
