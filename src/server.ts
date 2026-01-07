import * as dotenv from "dotenv";
import path from "path";

// ✅ FIX: safe temp folder support
import os from "os";

// Load .env FIRST, before anything else
dotenv.config({ path: path.resolve(__dirname, "../.env") });

console.log("🧪 OPENAI_API_KEY Loaded:", process.env.OPENAI_API_KEY ? "✅ Yes" : "❌ No");
console.log("🧪 GOOGLE_API_KEY Loaded:", process.env.GOOGLE_API_KEY ? "✅ Yes" : "❌ No");

import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";

// ✅ NEW: RATE LIMITING
import rateLimit from "express-rate-limit";

import { createClient } from "@supabase/supabase-js";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import fs from "fs";
const pdfParse = require("pdf-parse"); // ✅ compatible import
// @ts-ignore
import { convert } from "pdf-poppler";
import sharp, { OutputInfo } from "sharp";
import { setupGraderRoutes } from "./grader";
import fetch from "node-fetch";

// Optional fallback OCR
import Tesseract from "tesseract.js";

const app = express();
const port = 5000;
import { setupGreenGradedRoutes } from "./green_graded";
import { setupSBABRoute } from "./SBAW";
import { setupVivaRoutes } from "./viva";

// ============================================================
// 🔑 SUPABASE CLIENT
// ============================================================
const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// ============================================================
// 🤖 GOOGLE VISION CLIENT
// ============================================================
const visionClient = new ImageAnnotatorClient({
  projectId: process.env.GOOGLE_PROJECT_ID,
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
});

// ============================================================
// ✅ FIX: Dynamic allowed origins (localhost + any ngrok-free.app)
// ============================================================
const allowedOrigins = [
  "http://localhost:5173",
];

function isAllowedOrigin(origin?: string) {
  if (!origin) return true; // allow curl/postman
  if (allowedOrigins.includes(origin)) return true;
  if (/^https:\/\/.*\.ngrok-free\.app$/.test(origin)) return true; // allow any ngrok
  return false;
}

// ============================================================
// ✅ FIX: Prevent OCR context races (mutex lock)
// ============================================================
let OCR_LOCKED = false;
async function acquireOcrLock() {
  while (OCR_LOCKED) {
    await new Promise((r) => setTimeout(r, 50));
  }
  OCR_LOCKED = true;
}
function releaseOcrLock() {
  OCR_LOCKED = false;
}

// ============================================================
// ✅ FIX: safe temp folder for OCR work
// ============================================================
function tmpPath(file: string) {
  return path.join(os.tmpdir(), file);
}

// ============================================================
// ✅ FIX: extract teacher_id from Supabase JWT if present
// ============================================================
async function getTeacherId(req: Request): Promise<string | null> {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

// ============================================================
// ✅ NEW: UUID validator (quizId / ids)
// ============================================================
function isUUID(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// ============================================================
// ✅ NEW: RATE LIMITERS
// ============================================================

// Global limiter (all requests)
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 120,            // 120 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

// Heavy endpoints limiter (OCR, upload, grading etc.)
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 10,             // 10 heavy req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply global limiter
app.use(generalLimiter);

// ============================================================
// ⚙️ MIDDLEWARE (✅ FIXED CORS)
// ============================================================

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));

// ✅ MUST handle OPTIONS preflight
app.options("*", cors(corsOptions));

app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// ✅ HEALTH CHECK
// ============================================================
app.get("/", (_req: Request, res: Response) => {
  res.json({ message: "✅ AI Grader Backend Running" });
});

// ============================================================
// 📤 UPLOAD ENDPOINT (✅ now rate-limited + validated)
// ============================================================
app.post("/upload", heavyLimiter, upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // ✅ NEW: file validation
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    if (!req.file.mimetype.includes("pdf")) {
      return res.status(400).json({ error: "Only PDF uploads allowed" });
    }
    if (req.file.size > MAX_FILE_SIZE) {
      return res.status(400).json({ error: "File too large (max 10MB)" });
    }

    // ✅ FIX: prefer logged-in teacher id if provided via JWT, fallback to query param
    let teacherId = (await getTeacherId(req)) || (req.query.teacher_id as string);
    if (!teacherId) return res.status(400).json({ error: "teacher_id is required (or login token missing)" });

    // 🔹 NEW: optional quiz metadata
    const title = (req.query.title as string) || null;      // e.g., "Quiz 1"
    const section = (req.query.section as string) || null;  // e.g., "Section A"

    // ✅ NEW: metadata length validation
    if (title && title.length > 120) return res.status(400).json({ error: "title too long (max 120 chars)" });
    if (section && section.length > 60) return res.status(400).json({ error: "section too long (max 60 chars)" });

    const { originalname, buffer, mimetype } = req.file;
    console.log("📂 Uploading file:", originalname);

    const { data: fileData, error: uploadError } = await supabase.storage
      .from("quizzes")
      .upload(`uploads/${Date.now()}-${originalname}`, buffer, { contentType: mimetype });

    if (uploadError) throw uploadError;
    console.log("✅ File uploaded to storage:", fileData?.path);

    const { data: quizData, error: dbError } = await supabase
      .from("quizzes")
      .insert([
        {
          teacher_id: teacherId,
          original_pdf: fileData?.path,
          extracted_text: null,
          // 🔹 NEW FIELDS persisted
          title,
          section,
        },
      ])
      .select();

    if (dbError) throw dbError;

    console.log("✅ Quiz record inserted:", quizData);
    res.json({ success: true, row: quizData });
  } catch (err: any) {
    console.error("❌ Upload Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🧰 Helpers
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

// 🔹 NEW: simple slug for quiz title/section → used only inside OCR prompts
function slugify(s: string) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-]/g, "");
}

// 🔹 NEW: per-request OCR naming context used to shape the prompts
type OcrNamingContext = {
  firstIsSolution: boolean;
  quizTitle?: string | null;
  section?: string | null;
  pagesPerStudent: number; // NEW
};
let CURRENT_OCR_CTX: OcrNamingContext = { firstIsSolution: false, pagesPerStudent: 1 };

// Small helper to cap base64 data-URIs to ~19MB (OpenAI hard limit ~20MB)
async function toDataURIWithCap(imgPath: string, maxBytes = 19 * 1024 * 1024): Promise<string> {
  let buf: Buffer = fs.readFileSync(imgPath) as Buffer;
  const meta = await sharp(buf).metadata();
  let width = meta.width || 2600;
  while (buf.byteLength > maxBytes && width > 900) {
    width = Math.floor(width * 0.85);
    const next: Buffer = await sharp(buf).resize({ width }).png({ compressionLevel: 9 }).toBuffer();
    buf = next;
  }
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// ============================================================
// 🖼️ GOOGLE VISION IMAGES MULTIVARIANT
// ============================================================
async function ocrWithVisionImagesMultiVariant(pdfPath: string, baseKey: string) {
  console.log("🖼️ Vision OCR Images++ (DPI 350, variants & angles)");
  const outputBase = tmpPath(`page_${baseKey}`); // ✅ FIX
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
    addVariant(imgPath.replace(".jpg", "_v4_invert.jpg"), base.clone().negate());

    const angles = [-4, -2, 0, 2, 4];
    angles.forEach((deg) => {
      addVariant(imgPath.replace(".jpg", `_rot_${deg}.jpg`), base.clone().rotate(deg).sharpen());
    });

    await Promise.allSettled(variantBuilds);
    const variantResults: Array<{ text: string; score: number }> = [];
    const ocrPasses = [{ hints: ["en", "en-t-i0-handwrit"] }, { hints: ["und", "en"] }];

    for (const v of variants) {
      if (!fs.existsSync(v.path)) continue;
      let best = "";
      for (const pass of ocrPasses) {
        try {
          const [result] = await visionClient.documentTextDetection({
            image: { source: { filename: v.path } },
            imageContext: { languageHints: pass.hints },
          });
          const text = stripGarbage(result.fullTextAnnotation?.text || "");
          if (text && text.length > best.length) best = text;
        } catch (e: any) {
          console.warn("⚠️ Vision OCR variant failed:", e.message);
        }
      }
      if (best) {
        const score = Math.min(best.length, 10000) + (isMeaningful(best) ? 1000 : 0);
        variantResults.push({ text: best, score });
      }
    }

    variantResults.sort((a, b) => b.score - a.score);
    const best = variantResults[0]?.text || "";

    const seen = new Set<string>();
    const mergedLines: string[] = [];
    const addLines = (txt: string) => {
      for (const line of (txt || "").split(/\r?\n/)) {
        const k = line.trim();
        if (k && !seen.has(k)) {
          seen.add(k);
          mergedLines.push(line);
        }
      }
    };

    addLines(best);
    for (let i = 1; i < variantResults.length; i++) {
      if (isMeaningful(variantResults[i].text)) addLines(variantResults[i].text);
    }

    const pageText = stripGarbage(mergedLines.join("\n"));
    if (pageText && isMeaningful(pageText)) {
      mergedDoc += pageText + "\n\n";
      console.log(`📜 ${img} kept ${pageText.length} chars`);
    } else console.log(`⚠️ ${img} low quality, skipping`);

    for (const v of variants) {
      try { if (fs.existsSync(v.path)) fs.unlinkSync(v.path); } catch {}
    }
    try { fs.unlinkSync(imgPath); } catch {}
  }

  return mergedDoc.trim();
}

// ============================================================
// 📄 GOOGLE VISION PDF NATIVE
// ============================================================
async function ocrWithVisionPdfNative(pdfPath: string) {
  console.log("📄 Vision OCR Native PDF (async batch)");
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

  const [result] = await (visionClient as any).asyncBatchAnnotateFiles({ requests: request });
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
// 🔡 TESSERACT FALLBACK
// ============================================================
async function ocrWithTesseract(pdfPath: string, baseKey: string) {
  console.log("🔡 Tesseract fallback (PSM 6 & 7)");
  const outputBase = tmpPath(`tess_${baseKey}`); // ✅ FIX
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

    const passes = [{ psm: 6 }, { psm: 7 }];

    let best = "";
    for (const p of passes) {
      try {
        const { data } = await Tesseract.recognize(imgPath, "eng", {
          tessedit_pageseg_mode: p.psm,
        } as any);
        const txt = stripGarbage(data?.text || "");
        if (txt.length > best.length) best = txt;
      } catch (e: any) {
        console.warn("⚠️ Tesseract pass failed:", e.message);
      }
    }

    if (best && isMeaningful(best)) merged += best + "\n\n";

    try { fs.unlinkSync(imgPath); } catch {}
  }

  return merged.trim();
}

// ============================================================
// 🧠 OpenAI OCR API (upgraded model + preprocessing + prompting)
// ============================================================
// ✅ YOUR FUNCTION CONTINUES EXACTLY (UNCHANGED)
// (No changes made below)
// ============================================================

async function ocrWithOpenAIOCR(pdfPath: string) {
  console.log("🧠 OpenAI OCR API (Vision-based model)");

  type OpenAIResp = {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    error?: { message?: string };
  };

  const modelCandidates = [
    process.env.OPENAI_OCR_MODEL,
    "gpt-4o-mini",
    "gpt-4o",
  ].filter(Boolean) as string[];

  const baseSystemPrompt =
    "You are an OCR engine. Extract ALL legible text from the provided page image. " +
    "Preserve line breaks and reading order. Include printed and handwritten text, math, " +
    "labels in diagrams, and table cells (use tabs between cells). Do NOT summarize or omit content. " +
    "If a page is blank or unreadable, return an empty string.";

  try {
    const outputBase = tmpPath(`openai_${Date.now()}`); // ✅ FIX
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

    for (let idx = 0; idx < rawImages.length; idx++) {
      const img = rawImages[idx];
      const isFirstPageAbsolute = idx === 0;
      const isFirstInStudentBlock = (idx % Math.max(1, CURRENT_OCR_CTX.pagesPerStudent)) === 0;
      const isSolutionForThisPaper = CURRENT_OCR_CTX.firstIsSolution && isFirstPageAbsolute;

      const titleSlug = slugify(CURRENT_OCR_CTX.quizTitle || "");
      const sectionSlug = slugify(CURRENT_OCR_CTX.section || "");
      const solutionName = `solution_paper_${titleSlug}${sectionSlug ? "_" + sectionSlug : ""}`.replace(/^_+|_+$/g, "");
      const unknownName = `unknown_${titleSlug}${sectionSlug ? "_" + sectionSlug : ""}`.replace(/^_+|_+$/g, "");

      const headerRules = isFirstInStudentBlock
        ? (
            "Additionally, ALWAYS prepend a normalized header to your output EXACTLY like:\n" +
            "Name: <value>\n" +
            "Roll: <value>\n" +
            "----\n" +
            "Rules for <value>:\n" +
            `- CURRENT_PAPER_IS_SOLUTION = ${isSolutionForThisPaper ? "true" : "false"}.\n` +
            (isSolutionForThisPaper
              ? `- If CURRENT_PAPER_IS_SOLUTION is true, set BOTH Name and Roll to '${solutionName}'.\n`
              : `- If CURRENT_PAPER_IS_SOLUTION is false, try to read the student's name/roll from the page. If none is clearly present, set BOTH Name and Roll to '${unknownName}'.\n`) +
            "Do not invent different values. Use the exact strings above when required."
          )
        : (
            "Return raw text only for this page. Do NOT prepend any Name/Roll header for this page."
          );

      const SYSTEM_PROMPT = baseSystemPrompt + "\n\n" + headerRules;

      const raw = path.join(dir, img);

      const preOut = raw.replace(".png", "_pre.png");
      const meta = await sharp(raw).metadata();
      const targetWidth = Math.max(Math.min((meta.width || 2400), 2800), 1800);
      await sharp(raw)
        .resize({ width: targetWidth })
        .grayscale()
        .normalize()
        .median(1)
        .sharpen()
        .png({ compressionLevel: 9 })
        .toFile(preOut);

      const dataURI = await toDataURIWithCap(preOut);

      let pageText = "";
      let lastErrText = "";

      for (const model of modelCandidates) {
        console.log(`🧾 Sending ${img} to OpenAI OCR API with model=${model}...`);
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_output_tokens: 4096,
            input: [
              { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
              {
                role: "user",
                content: [
                  { type: "input_text", text: "Extract the text following the instructions above." },
                  { type: "input_image", image_url: dataURI },
                ],
              },
            ],
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          lastErrText = text;
          console.warn(`⚠️ OpenAI HTTP ${response.status}: ${text}`);
          try {
            const j = JSON.parse(text);
            const code = j?.error?.code;
            if (code === "model_not_found") continue;
          } catch {}
          break;
        }

        const data = (await response.json()) as OpenAIResp;
        const extracted =
          data.output_text ??
          data.output?.[0]?.content?.[0]?.text ??
          "";

        pageText = stripGarbage(extracted || "");
        if (pageText && pageText.length > 20) break;
      }

      if (pageText && pageText.length > 20) {
        allText += pageText + "\n\n";
        console.log(`✅ OCR success for ${img} (${pageText.length} chars)`);
      } else {
        console.warn(`⚠️ No meaningful text from ${img}${lastErrText ? " — last error: " + lastErrText : ""}`);
      }

      try { fs.unlinkSync(preOut); } catch {}
      try { fs.unlinkSync(raw); } catch {}
    }

    return allText.trim();
  } catch (err: any) {
    console.error("❌ OpenAI OCR failed:", err.message);
    return "";
  }
}

// ============================================================
// 🟣 Gemini OCR (custom endpoint OR official Google Gemini REST)
// ============================================================
// ✅ UNCHANGED (your existing function continues exactly)
// ============================================================

async function ocrWithGeminiOCR(pdfPath: string) {
  console.log("🧠 Gemini OCR API");

  const relayBase = process.env.GEMINIOCR_BASE_URL;
  const relayPath = process.env.GEMINIOCR_PATH || "/api/recognize";
  const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

  const baseSystemPrompt =
    "You are an OCR engine. Extract ALL legible text from the provided page image. " +
    "Preserve line breaks and reading order. Include printed and handwritten text, math, " +
    "labels in diagrams, and table cells (use tabs between cells). Do NOT summarize or omit content. " +
    "If a page is blank or unreadable, return an empty string.";

  try {
    const outputBase = tmpPath(`gemini_${Date.now()}`); // ✅ FIX
    await convert(pdfPath, {
      format: "png",
      out_dir: path.dirname(outputBase),
      out_prefix: path.basename(outputBase),
      page: null,
      dpi: 420,
    });

    const dir = path.dirname(outputBase);
    const pngs = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(path.basename(outputBase)) && f.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    let allText = "";

    for (let idx = 0; idx < pngs.length; idx++) {
      const img = pngs[idx];
      const isFirstPageAbsolute = idx === 0;
      const isFirstInStudentBlock = (idx % Math.max(1, CURRENT_OCR_CTX.pagesPerStudent)) === 0;
      const isSolutionForThisPaper = CURRENT_OCR_CTX.firstIsSolution && isFirstPageAbsolute;

      const titleSlug = slugify(CURRENT_OCR_CTX.quizTitle || "");
      const sectionSlug = slugify(CURRENT_OCR_CTX.section || "");
      const solutionName = `solution_paper_${titleSlug}${sectionSlug ? "_" + sectionSlug : ""}`.replace(/^_+|_+$/g, "");
      const unknownName = `unknown_${titleSlug}${sectionSlug ? "_" + sectionSlug : ""}`.replace(/^_+|_+$/g, "");

      const headerRules = isFirstInStudentBlock
        ? (
            "Additionally, ALWAYS prepend a normalized header to your output EXACTLY like:\n" +
            "Name: <value>\n" +
            "Roll: <value>\n" +
            "----\n" +
            "Rules for <value>:\n" +
            `- CURRENT_PAPER_IS_SOLUTION = ${isSolutionForThisPaper ? "true" : "false"}.\n` +
            (isSolutionForThisPaper
              ? `- If CURRENT_PAPER_IS_SOLUTION is true, set BOTH Name and Roll to '${solutionName}'.\n`
              : `- If CURRENT_PAPER_IS_SOLUTION is false, try to read the student's name/roll from the page. If none is clearly present, set BOTH Name and Roll to '${unknownName}'.\n`) +
            "Do not invent different values. Use the exact strings above when required."
          )
        : (
            "Return raw text only for this page. Do NOT prepend any Name/Roll header for this page."
          );

      const SYSTEM_PROMPT = baseSystemPrompt + "\n\n" + headerRules;

      const imgPath = path.join(dir, img);

      const preOut = imgPath.replace(".png", "_pre.png");
      const meta = await sharp(imgPath).metadata();
      const targetWidth = Math.max(Math.min((meta.width || 2400), 2800), 1800);
      await sharp(imgPath)
        .resize({ width: targetWidth })
        .grayscale()
        .normalize()
        .median(1)
        .sharpen()
        .png({ compressionLevel: 9 })
        .toFile(preOut);

      const dataUri = await toDataURIWithCap(preOut);

      let pageText = "";
      let lastError = "";

      if (relayBase) {
        const url = `${relayBase.replace(/\/+$/, "")}${relayPath}`;
        console.log(`🧾 Sending ${path.basename(imgPath)} to Gemini OCR relay → ${url}`);
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GEMINIOCR_API_KEY || ""}`,
            },
            body: JSON.stringify({
              image: dataUri,
              prompt: SYSTEM_PROMPT,
              raw_text_only: true,
            }),
          });

          if (!resp.ok) {
            const t = await resp.text();
            lastError = `GeminiOCR.com/relay HTTP ${resp.status}: ${t}`;
            console.warn(`⚠️ ${lastError}`);
          } else {
            const j: any = await resp.json();
            const text =
              j?.text ??
              j?.result ??
              j?.output ??
              j?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).join("") ??
              "";
            const cleaned = stripGarbage(text || "");
            if (cleaned && cleaned.length > 20) {
              pageText = cleaned;
            } else {
              console.warn("⚠️ Gemini relay returned no meaningful text");
            }
          }
        } catch (e: any) {
          lastError = `Relay request failed: ${e.message}`;
          console.warn("⚠️", lastError);
        }
      }

      if (!pageText) {
        if (!GOOGLE_API_KEY) {
          console.warn("⚠️ GOOGLE_API_KEY missing; cannot call official Gemini API");
        } else {
          try {
            console.log(`🧾 Sending ${path.basename(imgPath)} to Google Gemini REST model=${GEMINI_MODEL}`);
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
              GEMINI_MODEL
            )}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;

            const body = {
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: SYSTEM_PROMPT + "\nReturn raw text only." },
                    {
                      inline_data: {
                        mime_type: "image/png",
                        data: (dataUri.split(",")[1] || "").trim(),
                      },
                    },
                  ],
                },
              ],
            };

            const resp = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });

            if (!resp.ok) {
              const errText = await resp.text();
              lastError = `Google Gemini HTTP ${resp.status}: ${errText}`;
              console.warn("⚠️", lastError);
            } else {
              const j: any = await resp.json();
              const text =
                j?.candidates?.[0]?.content?.parts
                  ?.map((p: any) => p?.text)
                  ?.filter(Boolean)
                  ?.join("") || "";
              const cleaned = stripGarbage(text);
              if (cleaned && cleaned.length > 20) {
                pageText = cleaned;
              } else {
                console.warn("⚠️ Google Gemini returned no meaningful text");
              }
            }
          } catch (e: any) {
            lastError = `Google Gemini request failed: ${e.message}`;
            console.warn("⚠️", lastError);
          }
        }
      }

      if (pageText && pageText.length > 20) {
        allText += pageText + "\n\n";
        console.log(`🟣 Gemini extracted ${pageText.length} chars`);
      } else {
        console.warn(`⚠️ Gemini: no meaningful text from ${path.basename(imgPath)}${lastError ? " — last error: " + lastError : ""}`);
      }

      try { fs.unlinkSync(preOut); } catch {}
      try { fs.unlinkSync(imgPath); } catch {}
    }

    return allText.trim();
  } catch (err: any) {
    console.error("❌ Gemini OCR failed:", err.message);
    return "";
  }
}

// ============================================================
// 🧠 OCR PROCESS ENDPOINT (✅ now rate limited + validated)
// ============================================================
app.post("/process-quiz/:id", heavyLimiter, async (req: Request, res: Response) => {
  await acquireOcrLock(); // ✅ FIX: lock OCR so CURRENT_OCR_CTX doesn't race

  try {
    const quizId = req.params.id;

    // ✅ NEW: validate quizId
    if (!isUUID(quizId)) return res.status(400).json({ error: "Invalid quiz id" });

    const engine = (req.query.engine as string) || "auto";

    // ✅ NEW: validate engine
    const allowedEngines = ["auto", "vision-pdf", "images", "tesseract", "openai-ocr", "gemini-ocr"];
    if (!allowedEngines.includes(engine)) return res.status(400).json({ error: "Invalid engine" });

    console.log(`🔍 Starting OCR for quiz ${quizId} (engine=${engine})`);

    const { data: quiz, error: quizError } = await supabase
      .from("quizzes")
      .select("*")
      .eq("id", quizId)
      .single();

    if (quizError || !quiz) return res.status(404).json({ error: "Quiz not found" });

    const { data: file, error: downloadError } = await supabase.storage
      .from("quizzes")
      .download(quiz.original_pdf);

    if (downloadError || !file) throw new Error("Failed to download quiz PDF");

    const tempPdfPath = tmpPath(`temp_${quizId}.pdf`); // ✅ FIX
    fs.writeFileSync(tempPdfPath, Buffer.from(await (file as any).arrayBuffer()));
    console.log("📄 PDF downloaded locally");

    const pagesPerStudent = Math.max(1, Number((quiz as any).no_of_pages || 1));
    const firstIsSolutionFromDB = (quiz as any).read_first_paper_is_solution !== false;
    CURRENT_OCR_CTX = {
      firstIsSolution: firstIsSolutionFromDB,
      quizTitle: (quiz as any).title || null,
      section: (quiz as any).section || null,
      pagesPerStudent,
    };

    const tryPdfParse = async () => {
      try {
        const pdfBuffer = fs.readFileSync(tempPdfPath);
        const pdfData = await pdfParse(pdfBuffer);
        const txt = stripGarbage(pdfData.text || "");
        console.log(`📖 pdf-parse extracted ${txt.length} characters`);
        return txt;
      } catch (e: any) {
        console.warn("⚠️ pdf-parse failed:", e.message);
        return "";
      }
    };

    const tryVisionPdf = async () => {
      try {
        const txt = await ocrWithVisionPdfNative(tempPdfPath);
        console.log(`📘 Vision PDF native extracted ${txt.length} chars`);
        return txt;
      } catch (e: any) {
        console.warn("⚠️ Vision PDF native failed:", e.message);
        return "";
      }
    };

    const tryImages = async () => {
      try {
        const txt = await ocrWithVisionImagesMultiVariant(tempPdfPath, quizId);
        console.log(`🖼️ Vision Images++ extracted ${txt.length} chars`);
        return txt;
      } catch (e: any) {
        console.warn("⚠️ Vision Images++ failed:", e.message);
        return "";
      }
    };

    const tryTesseract = async () => {
      try {
        const txt = await ocrWithTesseract(tempPdfPath, quizId);
        console.log(`🔡 Tesseract extracted ${txt.length} chars`);
        return txt;
      } catch (e: any) {
        console.warn("⚠️ Tesseract failed:", e.message);
        return "";
      }
    };

    const tryOpenAIOCR = async () => {
      try {
        const txt = await ocrWithOpenAIOCR(tempPdfPath);
        console.log(`🧠 OpenAI OCR extracted ${txt.length} chars`);
        return txt;
      } catch (e: any) {
        console.warn("⚠️ OpenAI OCR failed:", e.message);
        return "";
      }
    };

    const tryGeminiOCR = async () => {
      try {
        const txt = await ocrWithGeminiOCR(tempPdfPath);
        console.log(`🟣 Gemini OCR extracted ${txt.length} chars`);
        return txt;
      } catch (e: any) {
        console.warn("⚠️ Gemini OCR failed:", e.message);
        return "";
      }
    };

    let extractedText = "";
    if (engine === "vision-pdf") {
      extractedText = await tryVisionPdf();
      if (!isMeaningful(extractedText)) extractedText = await tryImages();
      if (!isMeaningful(extractedText)) extractedText = await tryTesseract();
    } else if (engine === "images") {
      extractedText = await tryImages();
      if (!isMeaningful(extractedText)) extractedText = await tryTesseract();
    } else if (engine === "tesseract") {
      extractedText = await tryTesseract();
    } else if (engine === "openai-ocr") {
      extractedText = await tryOpenAIOCR();
      if (!isMeaningful(extractedText)) extractedText = await tryTesseract();
    } else if (engine === "gemini-ocr") {
      extractedText = await tryGeminiOCR();
      if (!isMeaningful(extractedText)) extractedText = await tryTesseract();
    } else {
      extractedText = await tryPdfParse();
      if (!isMeaningful(extractedText)) extractedText = await tryVisionPdf();
      if (!isMeaningful(extractedText)) extractedText = await tryOpenAIOCR();
      if (!isMeaningful(extractedText)) extractedText = await tryGeminiOCR();
      if (!isMeaningful(extractedText)) extractedText = await tryImages();
      if (!isMeaningful(extractedText)) extractedText = await tryTesseract();
    }

    CURRENT_OCR_CTX = { firstIsSolution: false, quizTitle: null, section: null, pagesPerStudent: 1 };

    function cleanExtractedText(text: string): string {
      return text
        .replace(/[^\x20-\x7E\n]/g, "")
        .replace(/\s{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    extractedText = cleanExtractedText(extractedText);
    if (!extractedText.trim()) console.warn("⚠️ No text detected by OCR");
    else console.log(`✅ OCR Extracted ${extractedText.length} characters`);

    const { error: updateError } = await supabase
      .from("quizzes")
      .update({ extracted_text: extractedText })
      .eq("id", quizId);

    if (updateError) throw updateError;

    try { fs.unlinkSync(tempPdfPath); } catch {}

    console.log("🧹 Cleaned up temp files");

    res.json({ success: true, text: extractedText });
  } catch (err: any) {
    console.error("❌ OCR Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    releaseOcrLock(); // ✅ FIX: always release OCR lock
  }
});

// ============================================================
// 🧩 GRADER MODULE ROUTES
// ============================================================
setupGraderRoutes(app, supabase);
setupGreenGradedRoutes(app, supabase);

// ...
// setupSBAWRoutes(app, supabase);
setupSBABRoute(app, supabase);

setupVivaRoutes(app, supabase, visionClient);

// ============================================================
// 🚀 START SERVER
// ============================================================
app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
