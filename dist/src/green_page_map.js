"use strict";
// ============================================================
// green_graded.ts — Build ONE merged, green-stamped PDF for all students
// Route: POST /build-green-graded/:id
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildGreenMergedPdf = buildGreenMergedPdf;
exports.setupGreenGradedRoutes = setupGreenGradedRoutes;
const pdf_lib_1 = require("pdf-lib");
const green_page_map_1 = require("./green_page_map");
// Buckets must match your existing setup
const QUIZ_BUCKET = "quizzes";
const GRADED_BUCKET = "graded";
function toArrayBuffer(u8) {
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
}
const green = () => (0, pdf_lib_1.rgb)(0.05, 0.55, 0.05);
const yellowSticky = () => (0, pdf_lib_1.rgb)(1, 1, 0.85);
function wrapLines(text, maxChars = 90) {
    const t = (text || "").trim();
    if (!t)
        return [];
    const words = t.split(/\s+/);
    const out = [];
    let cur = "";
    for (const w of words) {
        const tryLine = cur ? cur + " " + w : w;
        if (tryLine.length > maxChars) {
            if (cur)
                out.push(cur);
            cur = w;
        }
        else {
            cur = tryLine;
        }
    }
    if (cur)
        out.push(cur);
    return out;
}
async function drawGreenCircleAndSticky(p, fonts, student, options) {
    const { width, height } = p.getSize();
    // Circle at top-right
    const r = options?.circle?.r ?? 48;
    const cx = options?.circle?.x ?? (width - r - 36);
    const cy = options?.circle?.y ?? (height - r - 36);
    p.drawEllipse({
        x: cx,
        y: cy,
        xScale: r,
        yScale: r,
        borderColor: green(),
        borderWidth: 4,
    });
    const obtained = student.total_score ?? 0;
    const total = student.max_score ?? 0;
    const scoreText = `${obtained}/${total}`;
    const label = "Marks";
    const scoreSize = 16;
    const labelSize = 9;
    const scoreW = fonts.bold.widthOfTextAtSize(scoreText, scoreSize);
    const labelW = fonts.regular.widthOfTextAtSize(label, labelSize);
    p.drawText(scoreText, {
        x: cx - scoreW / 2,
        y: cy - 6,
        size: scoreSize,
        color: green(),
        font: fonts.bold,
    });
    p.drawText(label, {
        x: cx - labelW / 2,
        y: cy - 22,
        size: labelSize,
        color: green(),
        font: fonts.regular,
    });
    // Sticky (top-left area)
    const stickyX = options?.sticky?.x ?? 36;
    const stickyY = options?.sticky?.y ?? (height - 220);
    const stickyW = options?.sticky?.w ?? Math.min(420, width - 72);
    const stickyH = options?.sticky?.h ?? 180;
    const fs = options?.sticky?.fontSize ?? 10;
    p.drawRectangle({
        x: stickyX,
        y: stickyY,
        width: stickyW,
        height: stickyH,
        color: yellowSticky(),
        borderColor: green(),
        borderWidth: 2,
        opacity: 0.98,
    });
    const header = `${student.student_name || "Student"} (${student.roll_number || "-"}) — ` +
        `${obtained} / ${total}`;
    p.drawText(header, {
        x: stickyX + 8,
        y: stickyY + stickyH - 18,
        size: 12,
        color: green(),
        font: fonts.bold,
        maxWidth: stickyW - 16,
    });
    // Build sticky content
    const lines = [];
    if (Array.isArray(student.questions)) {
        for (const q of student.questions) {
            const qn = q.number ?? "?";
            const mm = q.max_marks ?? "-";
            lines.push(`Q${qn}: ${q.marks ?? 0}/${mm}` + (q.topic ? ` — ${q.topic}` : ""));
            if (Array.isArray(q.subparts) && q.subparts.length) {
                const subs = q.subparts
                    .map((s) => `${s.label ?? "?"}:${s.marks ?? 0}/${s.max_marks ?? "-"}`)
                    .join("   ");
                lines.push(`   • ${subs}`);
            }
            if (q.remarks)
                lines.push(`   ↳ ${q.remarks}`);
        }
    }
    if (student.remarks) {
        lines.push("");
        lines.push("Feedback:");
        lines.push(...wrapLines(student.remarks, 90));
    }
    let cursorY = stickyY + stickyH - 36;
    const lineH = fs + 3;
    for (const line of lines) {
        if (cursorY < stickyY + 10)
            break;
        p.drawText(line, {
            x: stickyX + 8,
            y: cursorY,
            size: fs,
            color: (0, pdf_lib_1.rgb)(0.1, 0.1, 0.1),
            font: fonts.regular,
            maxWidth: stickyW - 16,
        });
        cursorY -= lineH;
    }
}
async function annotateStudentSection(outDoc, studentPages, student) {
    const fontBold = await outDoc.embedFont(pdf_lib_1.StandardFonts.HelveticaBold);
    const font = await outDoc.embedFont(pdf_lib_1.StandardFonts.Helvetica);
    if (!studentPages.length)
        return;
    // Circle + sticky on the first page of the student's section
    await drawGreenCircleAndSticky(studentPages[0], { bold: fontBold, regular: font }, student);
    // Footer on each page
    const footerText = `${student.student_name || "Student"} (${student.roll_number || "-"})`;
    const fs = 9;
    for (const p of studentPages) {
        const { width } = p.getSize();
        const w = font.widthOfTextAtSize(footerText, fs);
        p.drawText(footerText, {
            x: width - w - 36,
            y: 24,
            size: fs,
            color: (0, pdf_lib_1.rgb)(0.15, 0.15, 0.15),
            font,
        });
    }
}
/**
 * Builds ONE merged PDF for all students (green circle + sticky).
 * Auto-maps pages using `grades.graded_json.page_indices`, or `quizzes.page_texts`,
 * or falls back to even split if neither is available.
 */
async function buildGreenMergedPdf(supabase, quizId) {
    // 1) Load quiz + original PDF (+ optional page_texts if present)
    const { data: quiz, error: quizError } = await supabase
        .from("quizzes")
        .select("id, original_pdf, page_texts")
        .eq("id", quizId)
        .single();
    if (quizError || !quiz?.original_pdf) {
        throw new Error("Quiz or original PDF not found");
    }
    // Download original
    const { data: file, error: dErr } = await supabase.storage
        .from(QUIZ_BUCKET)
        .download(quiz.original_pdf);
    if (dErr || !file)
        throw new Error("Failed to download original quiz PDF");
    const originalBuf = Buffer.from(await file.arrayBuffer());
    // 2) Load grades (per student JSON)
    const { data: rows, error: gErr } = await supabase
        .from("grades")
        .select("graded_json")
        .eq("quiz_id", quizId);
    if (gErr)
        throw gErr;
    if (!rows || !rows.length)
        throw new Error("No grades to stamp");
    const students = rows
        .map((r) => r.graded_json)
        .filter(Boolean);
    // 3) Read source PDF, prepare output
    const src = await pdf_lib_1.PDFDocument.load(originalBuf);
    const out = await pdf_lib_1.PDFDocument.create();
    const pageCount = src.getPageCount();
    const page_texts = Array.isArray(quiz?.page_texts) ? quiz.page_texts : undefined;
    // 4) Ensure each student has page_indices
    const mapped = (0, green_page_map_1.mapPagesToStudents)(pageCount, students, page_texts);
    // 5) Copy pages for each student in order, annotate their section
    for (const s of mapped) {
        const indices = Array.isArray(s.page_indices) && s.page_indices.length
            ? s.page_indices
            : [...Array(pageCount)].map((_, i) => i); // total fallback: all pages
        const uniqueSorted = Array.from(new Set(indices)).filter(i => i >= 0 && i < pageCount).sort((a, b) => a - b);
        if (!uniqueSorted.length)
            continue;
        const copied = await out.copyPages(src, uniqueSorted);
        const section = [];
        copied.forEach((p) => {
            out.addPage(p);
            section.push(p);
        });
        await annotateStudentSection(out, section, s);
    }
    // 6) Save, upload, return
    const bytes = await out.save();
    const ab = toArrayBuffer(bytes);
    const objectName = `green/${quizId}-green-merged-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
        .from(GRADED_BUCKET)
        .upload(objectName, ab, {
        contentType: "application/pdf",
        upsert: true,
    });
    if (upErr)
        throw upErr;
    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${GRADED_BUCKET}/${objectName}`;
    return publicUrl;
}
// ------------------ Express route ------------------
function setupGreenGradedRoutes(app, supabase) {
    app.post("/build-green-graded/:id", async (req, res) => {
        try {
            const quizId = req.params.id;
            const url = await buildGreenMergedPdf(supabase, quizId);
            res.json({ success: true, url });
        }
        catch (e) {
            console.error("❌ Build Green Merged Error:", e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });
}
