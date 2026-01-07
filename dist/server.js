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
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const multer_1 = __importDefault(require("multer"));
const dotenv_1 = __importDefault(require("dotenv"));
const supabase_js_1 = require("@supabase/supabase-js");
const vision_1 = require("@google-cloud/vision");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const pdfParse = __importStar(require("pdf-parse"));
const pdf_poppler_1 = require("pdf-poppler");
const sharp_1 = __importDefault(require("sharp"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const port = 5000;
// ============================
// 🔑 SUPABASE CLIENT
// ============================
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
// ============================
// 🤖 GOOGLE VISION CLIENT
// ============================
const visionClient = new vision_1.ImageAnnotatorClient({
    projectId: process.env.GOOGLE_PROJECT_ID,
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
});
// ============================
// ⚙️ MIDDLEWARE
// ============================
app.use((0, cors_1.default)({
    origin: ["http://localhost:5173"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
}));
app.use(express_1.default.json());
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
// ============================
// ✅ HEALTH CHECK
// ============================
app.get("/", (_req, res) => {
    res.json({ message: "✅ AI Grader Backend Running" });
});
// ============================
// 📤 UPLOAD ENDPOINT
// ============================
app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: "No file uploaded" });
        const teacherId = req.query.teacher_id;
        if (!teacherId)
            return res.status(400).json({ error: "teacher_id is required" });
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
// ============================
// 🧠 OCR PROCESS ENDPOINT
// ============================
app.post("/process-quiz/:id", async (req, res) => {
    try {
        const quizId = req.params.id;
        console.log(`🔍 Starting OCR for quiz ${quizId}`);
        // Step 1️⃣ Fetch quiz info
        const { data: quiz, error: quizError } = await supabase
            .from("quizzes")
            .select("*")
            .eq("id", quizId)
            .single();
        if (quizError || !quiz)
            return res.status(404).json({ error: "Quiz not found" });
        console.log("📘 Found quiz record for:", quiz.original_pdf);
        // Step 2️⃣ Download file
        const { data: file, error: downloadError } = await supabase.storage
            .from("quizzes")
            .download(quiz.original_pdf);
        if (downloadError || !file)
            throw new Error("Failed to download quiz PDF");
        const tempPdfPath = path_1.default.join(__dirname, `temp_${quizId}.pdf`);
        fs_1.default.writeFileSync(tempPdfPath, Buffer.from(await file.arrayBuffer()));
        console.log("📄 PDF downloaded locally");
        // Step 3️⃣ Try pdf-parse (for text-based PDFs)
        let extractedText = "";
        try {
            const pdfBuffer = fs_1.default.readFileSync(tempPdfPath);
            const pdfData = await pdfParse(pdfBuffer);
            extractedText = pdfData.text.trim();
        }
        catch (e) {
            console.warn("⚠️ pdf-parse failed:", e.message);
        }
        // Step 4️⃣ Convert PDF pages to images (for image-based PDFs)
        if (!extractedText || extractedText.length < 10) {
            console.log("🖼️ Converting PDF pages to images for OCR...");
            const outputBase = path_1.default.join(__dirname, `page_${quizId}`);
            const opts = {
                format: "jpeg",
                out_dir: path_1.default.dirname(outputBase),
                out_prefix: `page_${quizId}`,
                page: null,
            };
            await (0, pdf_poppler_1.convert)(tempPdfPath, opts);
            const dir = path_1.default.dirname(outputBase);
            const imageFiles = fs_1.default.readdirSync(dir).filter(f => f.startsWith(`page_${quizId}`) && f.endsWith(".jpg"));
            for (const img of imageFiles) {
                const imgPath = path_1.default.join(dir, img);
                // Optional: enhance image for OCR
                await (0, sharp_1.default)(imgPath).grayscale().normalize().toFile(imgPath);
                const [result] = await visionClient.textDetection(imgPath);
                const text = result.fullTextAnnotation?.text || "";
                extractedText += text + "\n";
                console.log(`📜 Extracted text from ${img}`);
                fs_1.default.unlinkSync(imgPath);
            }
        }
        // Step 5️⃣ Save OCR result
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
        console.log("✅ OCR completed for quiz", quizId);
        res.json({ success: true, text: extractedText });
    }
    catch (err) {
        console.error("❌ OCR Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================
// 🚀 START SERVER
// ============================
app.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
});
