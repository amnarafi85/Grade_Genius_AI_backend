"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// ============================================================
// AI GRADER BACKEND — ULTRA OCR VERSION + AI GRADER
// Supports text-based + scanned + handwritten PDFs with cleaning
// Engines: pdf-parse → Google Vision (native PDF) → Images++ → Tesseract → OpenAI OCR → Gemini OCR
// ============================================================
const dotenv = __importStar(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Load .env FIRST, before anything else
dotenv.config({ path: path_1.default.resolve(__dirname, "../.env") });
console.log("🧪 OPENAI_API_KEY Loaded:", process.env.OPENAI_API_KEY ? "✅ Yes" : "❌ No");
console.log("🧪 GOOGLE_API_KEY Loaded:", process.env.GOOGLE_API_KEY ? "✅ Yes" : "❌ No");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const multer_1 = __importDefault(require("multer"));
const supabase_js_1 = require("@supabase/supabase-js");
const vision_1 = require("@google-cloud/vision");
const fs_1 = __importDefault(require("fs"));
const pdfParse = require("pdf-parse"); // ✅ compatible import
// @ts-ignore
const pdf_poppler_1 = require("pdf-poppler");
const sharp_1 = __importDefault(require("sharp"));
const grader_1 = require("./grader");
const node_fetch_1 = __importDefault(require("node-fetch"));
// Optional fallback OCR
const tesseract_js_1 = __importDefault(require("tesseract.js"));
const app = (0, express_1.default)();
const port = 5000;
const green_graded_1 = require("./green_graded");
const SBAW_1 = require("./SBAW");
// ============================================================
// 🔑 SUPABASE CLIENT
// ============================================================
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
// ============================================================
// 🤖 GOOGLE VISION CLIENT
// ============================================================
const visionClient = new vision_1.ImageAnnotatorClient({
    projectId: process.env.GOOGLE_PROJECT_ID,
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
});
// ============================================================
// ⚙️ MIDDLEWARE
// ============================================================
app.use((0, cors_1.default)({
    origin: ["http://localhost:5173"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
}));
app.use(express_1.default.json());
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
// ============================================================
// ✅ HEALTH CHECK
// ============================================================
app.get("/", (_req, res) => {
    res.json({ message: "✅ AI Grader Backend Running" });
});
// ============================================================
// 📤 UPLOAD ENDPOINT
// ============================================================
app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: "No file uploaded" });
        const teacherId = req.query.teacher_id;
        if (!teacherId)
            return res.status(400).json({ error: "teacher_id is required" });
        // 🔹 NEW: optional quiz metadata
        const title = req.query.title || null; // e.g., "Quiz 1"
        const section = req.query.section || null; // e.g., "Section A"
        const { originalname, buffer, mimetype } = req.file;
        console.log("📂 Uploading file:", originalname);
        const { data: fileData, error: uploadError } = await supabase.storage
            .from("quizzes")
            .upload(`uploads/${Date.now()}-${originalname}`, buffer, { contentType: mimetype });
        if (uploadError)
            throw uploadError;
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
        if (dbError)
            throw dbError;
        console.log("✅ Quiz record inserted:", quizData);
        res.json({ success: true, row: quizData });
    }
    catch (err) {
        console.error("❌ Upload Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// 🧰 Helpers
// ============================================================
const stripGarbage = (s) => (s || "")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
const isMeaningful = (s) => {
    const clean = (s || "").replace(/[^a-zA-Z0-9]/g, "");
    return clean.length >= 30;
};
// 🔹 NEW: simple slug for quiz title/section → used only inside OCR prompts
function slugify(s) {
    return (s || "")
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_\-]/g, "");
}
let CURRENT_OCR_CTX = { firstIsSolution: false, pagesPerStudent: 1 };
// Small helper to cap base64 data-URIs to ~19MB (OpenAI hard limit ~20MB)
async function toDataURIWithCap(imgPath, maxBytes = 19 * 1024 * 1024) {
    let buf = fs_1.default.readFileSync(imgPath);
    const meta = await (0, sharp_1.default)(buf).metadata();
    let width = meta.width || 2600;
    while (buf.byteLength > maxBytes && width > 900) {
        width = Math.floor(width * 0.85);
        const next = await (0, sharp_1.default)(buf).resize({ width }).png({ compressionLevel: 9 }).toBuffer();
        buf = next;
    }
    return `data:image/png;base64,${buf.toString("base64")}`;
}
// ============================================================
// 🖼️ GOOGLE VISION IMAGES MULTIVARIANT
// ============================================================
async function ocrWithVisionImagesMultiVariant(pdfPath, baseKey) {
    console.log("🖼️ Vision OCR Images++ (DPI 350, variants & angles)");
    const outputBase = path_1.default.join(__dirname, `page_${baseKey}`);
    const opts = {
        format: "jpeg",
        out_dir: path_1.default.dirname(outputBase),
        out_prefix: `page_${baseKey}`,
        page: null,
        dpi: 350,
    };
    await (0, pdf_poppler_1.convert)(pdfPath, opts);
    const dir = path_1.default.dirname(outputBase);
    const imageFiles = fs_1.default
        .readdirSync(dir)
        .filter((f) => f.startsWith(`page_${baseKey}`) && f.endsWith(".jpg"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    let mergedDoc = "";
    for (const img of imageFiles) {
        const imgPath = path_1.default.join(dir, img);
        const variants = [];
        const variantBuilds = [];
        const addVariant = (p, pipeline) => {
            variants.push({ path: p });
            variantBuilds.push(pipeline.toFile(p));
        };
        const base = (0, sharp_1.default)(imgPath).resize({ width: 2500 }).grayscale().normalize().median(1);
        addVariant(imgPath.replace(".jpg", "_v1_light.jpg"), base.clone().sharpen());
        addVariant(imgPath.replace(".jpg", "_v2_t150.jpg"), base.clone().threshold(150));
        addVariant(imgPath.replace(".jpg", "_v3_t175.jpg"), base.clone().threshold(175));
        addVariant(imgPath.replace(".jpg", "_v4_invert.jpg"), base.clone().negate());
        const angles = [-4, -2, 0, 2, 4];
        angles.forEach((deg) => {
            addVariant(imgPath.replace(".jpg", `_rot_${deg}.jpg`), base.clone().rotate(deg).sharpen());
        });
        await Promise.allSettled(variantBuilds);
        const variantResults = [];
        const ocrPasses = [{ hints: ["en", "en-t-i0-handwrit"] }, { hints: ["und", "en"] }];
        for (const v of variants) {
            if (!fs_1.default.existsSync(v.path))
                continue;
            let best = "";
            for (const pass of ocrPasses) {
                try {
                    const [result] = await visionClient.documentTextDetection({
                        image: { source: { filename: v.path } },
                        imageContext: { languageHints: pass.hints },
                    });
                    const text = stripGarbage(result.fullTextAnnotation?.text || "");
                    if (text && text.length > best.length)
                        best = text;
                }
                catch (e) {
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
        const seen = new Set();
        const mergedLines = [];
        const addLines = (txt) => {
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
            if (isMeaningful(variantResults[i].text))
                addLines(variantResults[i].text);
        }
        const pageText = stripGarbage(mergedLines.join("\n"));
        if (pageText && isMeaningful(pageText)) {
            mergedDoc += pageText + "\n\n";
            console.log(`📜 ${img} kept ${pageText.length} chars`);
        }
        else
            console.log(`⚠️ ${img} low quality, skipping`);
        for (const v of variants) {
            try {
                if (fs_1.default.existsSync(v.path))
                    fs_1.default.unlinkSync(v.path);
            }
            catch { }
        }
        try {
            fs_1.default.unlinkSync(imgPath);
        }
        catch { }
    }
    return mergedDoc.trim();
}
// ============================================================
// 📄 GOOGLE VISION PDF NATIVE
// ============================================================
async function ocrWithVisionPdfNative(pdfPath) {
    console.log("📄 Vision OCR Native PDF (async batch)");
    const input = {
        mimeType: "application/pdf",
        content: fs_1.default.readFileSync(pdfPath),
    };
    const request = [
        {
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            inputConfig: input,
        },
    ];
    const [result] = await visionClient.asyncBatchAnnotateFiles({ requests: request });
    const [operation] = result;
    const [filesResponse] = await operation.promise();
    let out = "";
    for (const f of filesResponse?.responses || []) {
        const r = f?.responses?.[0];
        const text = stripGarbage(r?.fullTextAnnotation?.text || "");
        if (text)
            out += text + "\n\n";
    }
    return out.trim();
}
// ============================================================
// 🔡 TESSERACT FALLBACK
// ============================================================
async function ocrWithTesseract(pdfPath, baseKey) {
    console.log("🔡 Tesseract fallback (PSM 6 & 7)");
    const outputBase = path_1.default.join(__dirname, `tess_${baseKey}`);
    await (0, pdf_poppler_1.convert)(pdfPath, {
        format: "jpeg",
        out_dir: path_1.default.dirname(outputBase),
        out_prefix: `tess_${baseKey}`,
        page: null,
        dpi: 300,
    });
    const dir = path_1.default.dirname(outputBase);
    const imageFiles = fs_1.default
        .readdirSync(dir)
        .filter((f) => f.startsWith(`tess_${baseKey}`) && f.endsWith(".jpg"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    let merged = "";
    for (const img of imageFiles) {
        const imgPath = path_1.default.join(dir, img);
        const passes = [{ psm: 6 }, { psm: 7 }];
        let best = "";
        for (const p of passes) {
            try {
                const { data } = await tesseract_js_1.default.recognize(imgPath, "eng", {
                    tessedit_pageseg_mode: p.psm,
                });
                const txt = stripGarbage(data?.text || "");
                if (txt.length > best.length)
                    best = txt;
            }
            catch (e) {
                console.warn("⚠️ Tesseract pass failed:", e.message);
            }
        }
        if (best && isMeaningful(best))
            merged += best + "\n\n";
        try {
            fs_1.default.unlinkSync(imgPath);
        }
        catch { }
    }
    return merged.trim();
}
// ============================================================
// 🧠 OpenAI OCR API (upgraded model + preprocessing + prompting)
// ============================================================
async function ocrWithOpenAIOCR(pdfPath) {
    console.log("🧠 OpenAI OCR API (Vision-based model)");
    const modelCandidates = [
        process.env.OPENAI_OCR_MODEL,
        "gpt-4o-mini",
        "gpt-4o",
    ].filter(Boolean);
    // Base system prompt
    const baseSystemPrompt = "You are an OCR engine. Extract ALL legible text from the provided page image. " +
        "Preserve line breaks and reading order. Include printed and handwritten text, math, " +
        "labels in diagrams, and table cells (use tabs between cells). Do NOT summarize or omit content. " +
        "If a page is blank or unreadable, return an empty string.";
    try {
        const outputBase = path_1.default.join(__dirname, `openai_${Date.now()}`);
        await (0, pdf_poppler_1.convert)(pdfPath, {
            format: "png",
            out_dir: path_1.default.dirname(outputBase),
            out_prefix: path_1.default.basename(outputBase),
            page: null,
            dpi: 420,
        });
        const dir = path_1.default.dirname(outputBase);
        const rawImages = fs_1.default
            .readdirSync(dir)
            .filter((f) => f.startsWith(path_1.default.basename(outputBase)) && f.endsWith(".png"))
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
            // If it's NOT the first page in a student's block, don't prepend the header at all.
            const headerRules = isFirstInStudentBlock
                ? ("Additionally, ALWAYS prepend a normalized header to your output EXACTLY like:\n" +
                    "Name: <value>\n" +
                    "Roll: <value>\n" +
                    "----\n" +
                    "Rules for <value>:\n" +
                    `- CURRENT_PAPER_IS_SOLUTION = ${isSolutionForThisPaper ? "true" : "false"}.\n` +
                    // When treating first as solution, write solution paper title (quiz + section).
                    (isSolutionForThisPaper
                        ? `- If CURRENT_PAPER_IS_SOLUTION is true, set BOTH Name and Roll to '${solutionName}'.\n`
                        : `- If CURRENT_PAPER_IS_SOLUTION is false, try to read the student's name/roll from the page. If none is clearly present, set BOTH Name and Roll to '${unknownName}'.\n`) +
                    "Do not invent different values. Use the exact strings above when required.")
                : ("Return raw text only for this page. Do NOT prepend any Name/Roll header for this page.");
            const SYSTEM_PROMPT = baseSystemPrompt + "\n\n" + headerRules;
            const raw = path_1.default.join(dir, img);
            const preOut = raw.replace(".png", "_pre.png");
            const meta = await (0, sharp_1.default)(raw).metadata();
            const targetWidth = Math.max(Math.min((meta.width || 2400), 2800), 1800);
            await (0, sharp_1.default)(raw)
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
                const response = await (0, node_fetch_1.default)("https://api.openai.com/v1/responses", {
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
                        if (code === "model_not_found")
                            continue;
                    }
                    catch { }
                    break;
                }
                const data = (await response.json());
                const extracted = data.output_text ??
                    data.output?.[0]?.content?.[0]?.text ??
                    "";
                pageText = stripGarbage(extracted || "");
                if (pageText && pageText.length > 20)
                    break;
            }
            if (pageText && pageText.length > 20) {
                allText += pageText + "\n\n";
                console.log(`✅ OCR success for ${img} (${pageText.length} chars)`);
            }
            else {
                console.warn(`⚠️ No meaningful text from ${img}${lastErrText ? " — last error: " + lastErrText : ""}`);
            }
            try {
                fs_1.default.unlinkSync(preOut);
            }
            catch { }
            try {
                fs_1.default.unlinkSync(raw);
            }
            catch { }
        }
        return allText.trim();
    }
    catch (err) {
        console.error("❌ OpenAI OCR failed:", err.message);
        return "";
    }
}
// ============================================================
// 🟣 Gemini OCR (custom endpoint OR official Google Gemini REST)
// ============================================================
async function ocrWithGeminiOCR(pdfPath) {
    console.log("🧠 Gemini OCR API");
    const relayBase = process.env.GEMINIOCR_BASE_URL;
    const relayPath = process.env.GEMINIOCR_PATH || "/api/recognize";
    const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const baseSystemPrompt = "You are an OCR engine. Extract ALL legible text from the provided page image. " +
        "Preserve line breaks and reading order. Include printed and handwritten text, math, " +
        "labels in diagrams, and table cells (use tabs between cells). Do NOT summarize or omit content. " +
        "If a page is blank or unreadable, return an empty string.";
    try {
        const outputBase = path_1.default.join(__dirname, `gemini_${Date.now()}`);
        await (0, pdf_poppler_1.convert)(pdfPath, {
            format: "png",
            out_dir: path_1.default.dirname(outputBase),
            out_prefix: path_1.default.basename(outputBase),
            page: null,
            dpi: 420,
        });
        const dir = path_1.default.dirname(outputBase);
        const pngs = fs_1.default
            .readdirSync(dir)
            .filter((f) => f.startsWith(path_1.default.basename(outputBase)) && f.endsWith(".png"))
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
                ? ("Additionally, ALWAYS prepend a normalized header to your output EXACTLY like:\n" +
                    "Name: <value>\n" +
                    "Roll: <value>\n" +
                    "----\n" +
                    "Rules for <value>:\n" +
                    `- CURRENT_PAPER_IS_SOLUTION = ${isSolutionForThisPaper ? "true" : "false"}.\n` +
                    (isSolutionForThisPaper
                        ? `- If CURRENT_PAPER_IS_SOLUTION is true, set BOTH Name and Roll to '${solutionName}'.\n`
                        : `- If CURRENT_PAPER_IS_SOLUTION is false, try to read the student's name/roll from the page. If none is clearly present, set BOTH Name and Roll to '${unknownName}'.\n`) +
                    "Do not invent different values. Use the exact strings above when required.")
                : ("Return raw text only for this page. Do NOT prepend any Name/Roll header for this page.");
            const SYSTEM_PROMPT = baseSystemPrompt + "\n\n" + headerRules;
            const imgPath = path_1.default.join(dir, img);
            const preOut = imgPath.replace(".png", "_pre.png");
            const meta = await (0, sharp_1.default)(imgPath).metadata();
            const targetWidth = Math.max(Math.min((meta.width || 2400), 2800), 1800);
            await (0, sharp_1.default)(imgPath)
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
            // 1) Try user-provided relay if present
            if (relayBase) {
                const url = `${relayBase.replace(/\/+$/, "")}${relayPath}`;
                console.log(`🧾 Sending ${path_1.default.basename(imgPath)} to Gemini OCR relay → ${url}`);
                try {
                    const resp = await (0, node_fetch_1.default)(url, {
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
                    }
                    else {
                        const j = await resp.json();
                        const text = j?.text ??
                            j?.result ??
                            j?.output ??
                            j?.candidates?.[0]?.content?.parts?.map((p) => p?.text).join("") ??
                            "";
                        const cleaned = stripGarbage(text || "");
                        if (cleaned && cleaned.length > 20) {
                            pageText = cleaned;
                        }
                        else {
                            console.warn("⚠️ Gemini relay returned no meaningful text");
                        }
                    }
                }
                catch (e) {
                    lastError = `Relay request failed: ${e.message}`;
                    console.warn("⚠️", lastError);
                }
            }
            // 2) Official Google REST
            if (!pageText) {
                if (!GOOGLE_API_KEY) {
                    console.warn("⚠️ GOOGLE_API_KEY missing; cannot call official Gemini API");
                }
                else {
                    try {
                        console.log(`🧾 Sending ${path_1.default.basename(imgPath)} to Google Gemini REST model=${GEMINI_MODEL}`);
                        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
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
                        const resp = await (0, node_fetch_1.default)(endpoint, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(body),
                        });
                        if (!resp.ok) {
                            const errText = await resp.text();
                            lastError = `Google Gemini HTTP ${resp.status}: ${errText}`;
                            console.warn("⚠️", lastError);
                        }
                        else {
                            const j = await resp.json();
                            const text = j?.candidates?.[0]?.content?.parts
                                ?.map((p) => p?.text)
                                ?.filter(Boolean)
                                ?.join("") || "";
                            const cleaned = stripGarbage(text);
                            if (cleaned && cleaned.length > 20) {
                                pageText = cleaned;
                            }
                            else {
                                console.warn("⚠️ Google Gemini returned no meaningful text");
                            }
                        }
                    }
                    catch (e) {
                        lastError = `Google Gemini request failed: ${e.message}`;
                        console.warn("⚠️", lastError);
                    }
                }
            }
            if (pageText && pageText.length > 20) {
                allText += pageText + "\n\n";
                console.log(`🟣 Gemini extracted ${pageText.length} chars`);
            }
            else {
                console.warn(`⚠️ Gemini: no meaningful text from ${path_1.default.basename(imgPath)}${lastError ? " — last error: " + lastError : ""}`);
            }
            try {
                fs_1.default.unlinkSync(preOut);
            }
            catch { }
            try {
                fs_1.default.unlinkSync(imgPath);
            }
            catch { }
        }
        return allText.trim();
    }
    catch (err) {
        console.error("❌ Gemini OCR failed:", err.message);
        return "";
    }
}
// ============================================================
// 🧠 OCR PROCESS ENDPOINT
// ============================================================
app.post("/process-quiz/:id", async (req, res) => {
    try {
        const quizId = req.params.id;
        const engine = req.query.engine || "auto";
        console.log(`🔍 Starting OCR for quiz ${quizId} (engine=${engine})`);
        const { data: quiz, error: quizError } = await supabase
            .from("quizzes")
            .select("*")
            .eq("id", quizId)
            .single();
        if (quizError || !quiz)
            return res.status(404).json({ error: "Quiz not found" });
        const { data: file, error: downloadError } = await supabase.storage
            .from("quizzes")
            .download(quiz.original_pdf);
        if (downloadError || !file)
            throw new Error("Failed to download quiz PDF");
        const tempPdfPath = path_1.default.join(__dirname, `temp_${quizId}.pdf`);
        fs_1.default.writeFileSync(tempPdfPath, Buffer.from(await file.arrayBuffer()));
        console.log("📄 PDF downloaded locally");
        // 🔹 NEW: set OCR prompt context (DB-driven)
        const pagesPerStudent = Math.max(1, Number(quiz.no_of_pages || 1));
        const firstIsSolutionFromDB = quiz.read_first_paper_is_solution !== false; // default true if missing
        CURRENT_OCR_CTX = {
            firstIsSolution: firstIsSolutionFromDB,
            quizTitle: quiz.title || null,
            section: quiz.section || null,
            pagesPerStudent,
        };
        const tryPdfParse = async () => {
            try {
                const pdfBuffer = fs_1.default.readFileSync(tempPdfPath);
                const pdfData = await pdfParse(pdfBuffer);
                const txt = stripGarbage(pdfData.text || "");
                console.log(`📖 pdf-parse extracted ${txt.length} characters`);
                return txt;
            }
            catch (e) {
                console.warn("⚠️ pdf-parse failed:", e.message);
                return "";
            }
        };
        const tryVisionPdf = async () => {
            try {
                const txt = await ocrWithVisionPdfNative(tempPdfPath);
                console.log(`📘 Vision PDF native extracted ${txt.length} chars`);
                return txt;
            }
            catch (e) {
                console.warn("⚠️ Vision PDF native failed:", e.message);
                return "";
            }
        };
        const tryImages = async () => {
            try {
                const txt = await ocrWithVisionImagesMultiVariant(tempPdfPath, quizId);
                console.log(`🖼️ Vision Images++ extracted ${txt.length} chars`);
                return txt;
            }
            catch (e) {
                console.warn("⚠️ Vision Images++ failed:", e.message);
                return "";
            }
        };
        const tryTesseract = async () => {
            try {
                const txt = await ocrWithTesseract(tempPdfPath, quizId);
                console.log(`🔡 Tesseract extracted ${txt.length} chars`);
                return txt;
            }
            catch (e) {
                console.warn("⚠️ Tesseract failed:", e.message);
                return "";
            }
        };
        const tryOpenAIOCR = async () => {
            try {
                const txt = await ocrWithOpenAIOCR(tempPdfPath);
                console.log(`🧠 OpenAI OCR extracted ${txt.length} chars`);
                return txt;
            }
            catch (e) {
                console.warn("⚠️ OpenAI OCR failed:", e.message);
                return "";
            }
        };
        const tryGeminiOCR = async () => {
            try {
                const txt = await ocrWithGeminiOCR(tempPdfPath);
                console.log(`🟣 Gemini OCR extracted ${txt.length} chars`);
                return txt;
            }
            catch (e) {
                console.warn("⚠️ Gemini OCR failed:", e.message);
                return "";
            }
        };
        // 🔁 Engine selection
        let extractedText = "";
        if (engine === "vision-pdf") {
            extractedText = await tryVisionPdf();
            if (!isMeaningful(extractedText))
                extractedText = await tryImages();
            if (!isMeaningful(extractedText))
                extractedText = await tryTesseract();
        }
        else if (engine === "images") {
            extractedText = await tryImages();
            if (!isMeaningful(extractedText))
                extractedText = await tryTesseract();
        }
        else if (engine === "tesseract") {
            extractedText = await tryTesseract();
        }
        else if (engine === "openai-ocr") {
            extractedText = await tryOpenAIOCR();
            if (!isMeaningful(extractedText))
                extractedText = await tryTesseract();
        }
        else if (engine === "gemini-ocr") {
            extractedText = await tryGeminiOCR();
            if (!isMeaningful(extractedText))
                extractedText = await tryTesseract();
        }
        else {
            // auto: pdf-parse → vision-pdf → openai → gemini → images → tesseract
            extractedText = await tryPdfParse();
            if (!isMeaningful(extractedText))
                extractedText = await tryVisionPdf();
            if (!isMeaningful(extractedText))
                extractedText = await tryOpenAIOCR();
            if (!isMeaningful(extractedText))
                extractedText = await tryGeminiOCR();
            if (!isMeaningful(extractedText))
                extractedText = await tryImages();
            if (!isMeaningful(extractedText))
                extractedText = await tryTesseract();
        }
        // Reset OCR context (safety)
        CURRENT_OCR_CTX = { firstIsSolution: false, quizTitle: null, section: null, pagesPerStudent: 1 };
        // Post-clean
        function cleanExtractedText(text) {
            return text
                .replace(/[^\x20-\x7E\n]/g, "")
                .replace(/\s{2,}/g, " ")
                .replace(/\n{3,}/g, "\n\n")
                .trim();
        }
        extractedText = cleanExtractedText(extractedText);
        if (!extractedText.trim())
            console.warn("⚠️ No text detected by OCR");
        else
            console.log(`✅ OCR Extracted ${extractedText.length} characters`);
        const { error: updateError } = await supabase
            .from("quizzes")
            .update({ extracted_text: extractedText })
            .eq("id", quizId);
        if (updateError)
            throw updateError;
        fs_1.default.unlinkSync(tempPdfPath);
        console.log("🧹 Cleaned up temp files");
        // ❌ Removed auto-trigger of grading. Frontend will call /analyze-quiz with user-selected settings.
        res.json({ success: true, text: extractedText });
    }
    catch (err) {
        console.error("❌ OCR Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// 🧩 GRADER MODULE ROUTES
// ============================================================
(0, grader_1.setupGraderRoutes)(app, supabase);
(0, green_graded_1.setupGreenGradedRoutes)(app, supabase);
// ...
// setupSBAWRoutes(app, supabase);
(0, SBAW_1.setupSBABRoute)(app, supabase);
// ============================================================
// 🚀 START SERVER
// ============================================================
app.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
});
