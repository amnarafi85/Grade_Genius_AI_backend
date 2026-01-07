"use strict";
// ============================================================
// GRADER MODULE — GPT/GEMINI-BASED AI QUIZ GRADING
// (+ leniency dial, solution-key option, CSV export, graded-PDF pack)
// ============================================================
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
exports.setupGraderRoutes = setupGraderRoutes;
const dotenv = __importStar(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv.config({ path: path_1.default.resolve(__dirname, "../.env") });
const openai_1 = __importDefault(require("openai"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const pdf_lib_1 = require("pdf-lib");
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
// ---------- Gemini config ----------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GRADER_GEMINI_MODEL = process.env.GRADER_GEMINI_MODEL || "gemini-2.5-flash";
// ---------- OpenAI model for grading ----------
const GRADER_OPENAI_MODEL = process.env.GRADER_OPENAI_MODEL || "gpt-4o-mini";
// The bucket names you already use
const QUIZ_BUCKET = "quizzes";
const GRADED_BUCKET = "graded";
const RESULTS_BUCKET = "results";
// ---------- Shared prompts ----------
const SYSTEM_PROMPT = "You are a structured OCR quiz parser and grader. " +
    "Segment multiple students, extract question/answer pairs, " +
    "apply the rubric and grading mode, and ALWAYS return clean, valid JSON ONLY " +
    "(no markdown, no prose). If unreadable, mark the paper unreadable with total_score=0. " +
    "Do not exceed any max marks (question or subpart). Explain scoring in remarks. " +
    // Global leniency reiteration so the model sees it in the system message too:
    "Be VERY LENIENT across all cases: accept ANY explanation (pseudocode, grammatical/plain-language text, partial code/syntax, or graphical/diagrammatic reasoning). " +
    "You do NOT need 100% correct syntax in ANY case; if code/syntax is even ~40% correct or shows intent, award marks proportionally. Do NOT rely on fully correct syntax to give credit. " +
    "For 1×4 and 1×2 subpart formats, if the student attempts any subpart with any explanation/code/syntax, award generous credit for that subpart. " +
    "In any 'relevant' case, grant MORE THAN HALF of the available marks (strictly >50%) while still respecting per-subpart and total maxima. " +
    // NEW: explicit requirement to also grade and output the solution paper
    "You MUST grade and output EVERY paper in the final JSON, including the solution paper. For the solution paper, include name, roll_number, every question and subpart with marks/max_marks and remarks, total_score/max_score, and overall remarks exactly like for other students. Provide full grading criteria and explanations for the solution paper as well.";
function gradingModeGuidance(mode) {
    switch ((mode || "").toLowerCase()) {
        case "very_easy":
        case "more_easy":
            return `VERY_EASY: Extremely generous with partial credit. Be VERY, VERY LENIENT.
Accept ANY form of explanation: pseudocode, grammatical/worded explanation, bullet points, or graphical/diagrammatic reasoning for EVERYTHING.
Reward any relevant attempt, keywords, reasoning clues, and explanatory/graphical reasoning.
Do NOT require perfect syntax; if syntax is even ~40% correct or shows intent, GIVE MARKS.
SPECIAL: For an older student who even attempts, award a baseline of 30% of each question’s max marks (rounded sensibly), BUT never exceed any question/subpart max or the total exam max.
ALSO: For 1×4 / 1×2 formats, if the student attempts any subpart with any explanation/code/syntax, award proportional marks for that subpart (be generous). If exactly 1 out of 2 subparts is correct, give FULL marks for that subpart; if exactly 1 out of 4 subparts is correct, give FULL marks for that subpart. In 'relevant' cases, award MORE THAN HALF of available marks while respecting maxima.`;
        case "easy":
            return `EASY: Be generous with partial credit and VERY LENIENT.
Accept ANY explanation including pseudocode, text/grammatical prose, or graphical/diagram evidence for EVERYTHING.
Reward attempts and relevant reasoning even if logic is incomplete. Do NOT require perfect syntax; ~40% correct syntax merits marks.
ALSO: For 1×4 / 1×2 formats, if the student attempts any subpart with any explanation/code/syntax, award proportional marks for that subpart (be generous). If exactly 1 out of 2 subparts is correct, give FULL marks for that subpart; if exactly 1 out of 4 subparts is correct, give FULL marks for that subpart. In 'relevant' cases, award MORE THAN HALF of available marks while respecting maxima.`;
        case "strict":
            return `STRICT: Prioritize correctness but remain LENIENT where possible.
Accept ANY explanatory form (pseudocode, grammatical prose, or graphical reasoning) as valid evidence of understanding.
Do NOT require perfect syntax; if syntax is ~40% correct or shows intent, award partial marks accordingly.
Award points primarily for correct logic and complete steps; partial credit is minimal but allowed when understanding is evident.
ALSO: Even in STRICT mode, for 1×4 / 1×2 formats, if the student attempts any subpart with any explanation/code/syntax, award proportional credit for that subpart. If exactly 1 out of 2 is correct, give FULL marks for that subpart; if exactly 1 out of 4 is correct, give FULL marks for that subpart. In 'relevant' cases, award MORE THAN HALF of available marks (strictly >50%) without exceeding maxima.`;
        case "hard":
            return `HARD: Stricter than STRICT, but still accept ANY explanation form (pseudocode, grammatical prose, graphical/diagrammatic) as evidence.
Do NOT require perfect syntax; if syntax is ~40% correct or shows intent, award some marks.
Deduct for missing steps or unclear logic. Full marks only for fully correct, well-justified answers, but remain proportionally LENIENT when partial understanding is demonstrated.
ALSO: For 1×4 / 1×2 formats, if the student attempts any subpart with any explanation/code/syntax, award proportional marks for that subpart. If exactly 1 out of 2 is correct, give FULL marks for that subpart; if exactly 1 out of 4 is correct, give FULL marks for that subpart. In 'relevant' cases, award MORE THAN HALF of available marks while respecting maxima.`;
        case "blind":
            return `BLIND: Focus on semantic correctness and understanding (not exact wording/syntax). Be VERY, VERY LENIENT.
Always accept ANY form of explanation (pseudocode, grammatical/text explanation, graphical/diagrammatic) for EVERYTHING.
Do NOT require perfect syntax; if syntax is ~40% correct or shows intent, AWARD MARKS.
BASELINE FAIRNESS: Award a baseline of 50% of each question’s max marks to every student (rounded sensibly), provided there is at least an attempt, BUT do NOT exceed any question/subpart max or the total exam max. Above this baseline, award additional proportional credit for coverage of core ideas and semantic correctness.
EXTRA LENIENCY: Additionally award +40% of each question’s max marks as extra credit to every student (attempt required), capped so totals NEVER exceed the per-question/subpart or overall max.
ALSO: For 1×4 / 1×2 formats, if the student attempts any subpart with any explanation/code/syntax, award proportional marks for that subpart. If exactly 1 out of 2 is correct, give FULL marks for that subpart; if exactly 1 out of 4 is correct, give FULL marks for that subpart. In 'relevant' cases—even if not fully correct—award MORE THAN HALF of available marks while respecting maxima.`;
        default:
            return `BALANCED: Reasonable partial credit with a LENIENT stance.
Accept ANY explanation form (pseudocode, grammatical/text explanation, graphical/diagrammatic) for EVERYTHING.
Do NOT require perfect syntax; if syntax is ~40% correct or shows intent, award marks accordingly.
Require coherent logic for high marks, but be generous where understanding is demonstrated.
ALSO: For 1×4 / 1×2 formats, if the student attempts any subpart with any explanation/code/syntax, award proportional marks for that subpart. If exactly 1 out of 2 is correct, give FULL marks for that subpart; if exactly 1 out of 4 is correct, give FULL marks for that subpart. In 'relevant' cases, award MORE THAN HALF of available marks while respecting maxima.`;
    }
}
function leniencyGuidance(leniency) {
    // NOTE: Per your request, none of these should hand out automatic full marks for mere relevance to the entire question,
    // but we are VERY LENIENT with subparts and relevance thresholds as specified.
    switch (leniency) {
        case "any_relevant_full":
            return "LENIENCY: Be very generous and VERY LENIENT. Accept ANY explanation (pseudocode, grammatical prose, or graphical/diagrammatic). Do NOT require perfect syntax; if syntax is ~40% correct or shows intent, award marks. For 1×4/1×2 formats, if a student attempts any subpart with any explanation/code/syntax, award proportional marks; if exactly 1/2 is correct, give FULL marks for that subpart; if exactly 1/4 is correct, give FULL marks for that subpart. In any 'relevant' case—even if not fully correct—award MORE THAN HALF (>50%) of the available marks, without exceeding maxima.";
        case "half_correct_full":
            return "LENIENCY: VERY LENIENT. Accept ANY explanation (pseudocode, grammatical prose, graphical). Do NOT require perfect syntax; ~40% correct syntax merits marks. For 1×4/1×2, if exactly 1/2 is correct give FULL marks for that subpart; if exactly 1/4 is correct give FULL marks for that subpart. In 'relevant' cases—even if the answer is not correct—award MORE THAN HALF (>50%) of available marks (respect maxima).";
        case "quarter_correct_full":
            return "LENIENCY: VERY LENIENT. Accept ANY explanation (pseudocode, grammatical prose, graphical). Do NOT require perfect syntax; ~40% correct syntax merits marks. For 1×4/1×2, if exactly 1/2 is correct give FULL marks for that subpart; if exactly 1/4 is correct give FULL marks for that subpart. In 'relevant' cases—even if not correct—award MORE THAN HALF (>50%) of available marks (within maxima).";
        default:
            return "LENIENCY: Careful/exact grading but with a LENIENT stance. Accept ANY explanation (pseudocode, grammatical prose, graphical) and do NOT require perfect syntax; ~40% correctness merits marks. For 1×4/1×2, if exactly 1/2 is correct give FULL marks for that subpart; if exactly 1/4 is correct give FULL marks for that subpart. In any 'relevant' case—even if not correct—award MORE THAN HALF (>50%) of available marks, never exceeding maxima.";
    }
}
function rubricToText(rubric) {
    if (!rubric || !Array.isArray(rubric) || rubric.length === 0)
        return "None (infer reasonable marks).";
    const lines = [
        "Use this rubric strictly. Do not exceed the specified maxima.",
        "When subparts exist, grade subparts and sum them; do not exceed the parent total if one is given.",
        "Rubric JSON:",
        JSON.stringify(rubric, null, 2),
    ];
    return lines.join("\n");
}
function buildGradingPrompt(rawText, gradingMode, teacherExtra, rubric, leniency = "exact_only", useFirstPaperAsSolution = false) {
    const MODE = (gradingMode || "balanced").toUpperCase();
    return `
You are an AI quiz grader. The input is messy OCR text containing multiple scanned quiz papers.
Each student paper starts with or contains identifiers such as:
- "Name", "Name:", "Roll No", "Roll#", "Registration", "Quiz #", "Quiz No", "CLO" etc.

🧩 SEGMENTATION
- Treat every occurrence of a new "Name", "Roll", or "Quiz" line as the START of a new student paper.
- Do NOT merge text from different students.
- If a paper has no name or roll number, still treat it as a separate paper:
  "student_name": "Unknown Student", "roll_number": null
- Preserve order: first detected paper = Paper 1, then 2, etc.
- Ignore obvious garbage sections (<20 chars of random symbols).

${useFirstPaperAsSolution
        ? `📘 SOLUTION-KEY: Treat the FIRST detected paper as the official solution paper (answer key).
When grading subsequent papers, compare their answers to this key IN ADDITION to your own knowledge.
If the key is ambiguous or partial, use your expertise to complete it.
IMPORTANT: You MUST still GRADE and OUTPUT the solution paper itself as a full student-like record. Include name (or "Unknown Student"), roll_number, every question and subpart with marks/max_marks and remarks, total_score/max_score, and overall remarks — exactly like for other students. Provide full grading criteria/explanations for the solution paper as well. Do NOT skip or omit the solution paper.`
        : ""}

🧮 QUESTION EXTRACTION
- Questions typically begin with "1.", "2)", "(3)" etc.
- Extract each question number, the question text, and the student's answer.
- If the question text is missing but an answer is present, still create a question entry and set "question" to an inferred placeholder like "Unknown question (from context)".

⚙️ GRADING MODE: ${MODE}
${gradingModeGuidance(gradingMode)}

🎯 LENIENCY:
${leniencyGuidance(leniency)}

✅ ACCEPT EVIDENCE OF UNDERSTANDING (FOR EVERYTHING)
- In ALL modes and cases, accept ANY explanation form: pseudocode, step-by-step grammatical/plain-language reasoning, partial code or any syntax, or graphical/diagrammatic explanations.
- Do NOT rely on complete/perfect syntax: if code/syntax is even ~40% correct or shows clear intent, AWARD MARKS.
- For 1×4 and 1×2 subpart formats, if the student attempts any subpart with any explanation/code/syntax, award proportional marks for that subpart (be generous); if exactly 1/2 is correct, give FULL marks for that subpart; if exactly 1/4 is correct, give FULL marks for that subpart.
- In any "relevant" case—even if not fully correct—award MORE THAN HALF (>50%) of available marks for the question/subpart, without exceeding maxima or totals.
- Focus on conceptual correctness and algorithmic reasoning, not just syntax or formatting.
- Always keep a VERY LENIENT stance; however, never exceed any max marks.

📋 RUBRIC (QUESTION-WISE MARKS + OPTIONAL SUBPARTS)
${rubricToText(rubric)}
- Respect the rubric strictly. Never exceed a question's or subpart's max marks.
- If a question appears in the OCR but is NOT in the rubric, you may assign a small default max (e.g., 1–2) only if it’s clearly a real question. Prefer sticking to provided rubric.

📏 MARKING CRITERIA
- Empty or nonsense → 0 marks
- Some relevant words/definitions → small credit (apply leniently)
- Partially correct logic or incomplete steps → partial credit (apply leniently)
- Fully correct logic with clear steps → full marks
- Every question must have "remarks" explaining the score and (if subparts) per-subpart breakdown.

⚠️ LOW QUALITY HANDLING
If a paper is unreadable, set:
{
  "unreadable": true,
  "remarks": "OCR too poor to grade",
  "total_score": 0
}

🧠 OUTPUT FORMAT — RETURN **ONLY** VALID JSON (no markdown, no backticks, no commentary):
[
  {
    "student_name": "John Doe",
    "roll_number": "F20230045",
    "course": "Optional or null",
    "quiz_number": "Optional or null",
    "unreadable": false,
    "questions": [
      {
        "number": 1,
        "topic": "optional",
        "question": "Write code for Stack ADT to check bracket balancing",
        "answer": "student’s attempt",
        "marks": 2,
        "max_marks": 3,
        "subparts": [
          { "label": "a", "marks": 1, "max_marks": 1, "remarks": "Definition correct" },
          { "label": "b", "marks": 1, "max_marks": 2, "remarks": "Partially correct" }
        ],
        "remarks": "Partially correct logic"
      }
    ],
    "total_score": 5,
    "max_score": 6,
    "remarks": "Summary feedback"
  }
]

Do NOT omit the solution paper. Include it as a normal record with full fields and detailed grading/remarks.

If you detect an unnamed paper, set:
"student_name": "Unknown Student", "roll_number": null

If no valid student found, return [].

OCR TEXT:
"""${rawText}"""

Additional teacher instructions:
${teacherExtra || "None"}
`.trim();
}
// ---------- Model callers ----------
async function gradeWithOpenAI(prompt) {
    const resp = await openai.chat.completions.create({
        model: GRADER_OPENAI_MODEL,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
        ],
        temperature: 0.2,
    });
    return (resp.choices[0]?.message?.content || "").trim();
}
async function gradeWithGemini(prompt) {
    if (!GEMINI_API_KEY)
        throw new Error("GEMINI_API_KEY / GOOGLE_API_KEY is missing");
    const endpoint = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(GRADER_GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const merged = `${SYSTEM_PROMPT}\n\n${prompt}`;
    const body = {
        contents: [{ role: "user", parts: [{ text: merged }] }],
        generationConfig: { temperature: 0.2 },
    };
    const r = await (0, node_fetch_1.default)(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`Gemini HTTP ${r.status}: ${t}`);
    }
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text)
        ?.filter(Boolean)
        ?.join("") || "";
    return (text || "").trim();
}
// ---------- Helpers ----------
function safeJSON(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
}
function stripCodeFences(s) {
    // remove leading/trailing ```json ... ``` or ``` ... ```
    return s
        .replace(/^\s*```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
}
function extractJsonSlice(s) {
    // try to find a well-formed JSON array; else object
    const a = s.indexOf("[");
    const aEnd = s.lastIndexOf("]");
    if (a !== -1 && aEnd !== -1 && aEnd > a) {
        const slice = s.slice(a, aEnd + 1);
        const tryArr = safeJSON(slice);
        if (tryArr)
            return slice;
    }
    const o = s.indexOf("{");
    const oEnd = s.lastIndexOf("}");
    if (o !== -1 && oEnd !== -1 && oEnd > o) {
        const slice = s.slice(o, oEnd + 1);
        const tryObj = safeJSON(slice);
        if (tryObj)
            return slice;
    }
    return null;
}
function normalizeGradedToArray(gradedRaw) {
    if (!gradedRaw)
        return null;
    let s = gradedRaw.trim();
    s = stripCodeFences(s);
    // direct parse
    let p = safeJSON(s);
    if (p) {
        if (Array.isArray(p))
            return p;
        return [p]; // model returned a single object
    }
    // try to slice out JSON part
    const sliced = extractJsonSlice(s);
    if (sliced) {
        const q = safeJSON(sliced);
        if (q) {
            if (Array.isArray(q))
                return q;
            return [q];
        }
    }
    return null;
}
function csvEscape(s) {
    const t = s == null ? "" : String(s);
    if (/[",\n]/.test(t))
        return `"${t.replace(/"/g, '""')}"`;
    return t;
}
// Ensure we hand an ArrayBuffer (not Blob) to Supabase to avoid DOM typings
function toArrayBuffer(u8) {
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
}
async function annotatePdfWithSummary(buf, summary) {
    const pdfDoc = await pdf_lib_1.PDFDocument.load(buf);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.HelveticaBold);
    const title = `${summary.student_name || "Student"} (${summary.roll_number || "-"})` +
        `  —  ${summary.total_score ?? "-"} / ${summary.max_score ?? "-"}`;
    const remark = (summary.remarks || "").slice(0, 400);
    pages.forEach((p, idx) => {
        const { width, height } = p.getSize();
        p.drawText(title, {
            x: 36,
            y: height - 36,
            size: 14,
            color: (0, pdf_lib_1.rgb)(0.85, 0, 0), // red
            font,
        });
        if (idx === 0 && remark) {
            p.drawText(`Remarks: ${remark}`, {
                x: 36,
                y: height - 60,
                size: 10,
                color: (0, pdf_lib_1.rgb)(0.85, 0, 0),
                font,
                maxWidth: width - 72,
                lineHeight: 12,
            });
        }
    });
    return await pdfDoc.save();
}
// ---------- Solution post-processor ----------
function forceSolutionFullMarks(first) {
    if (!first || typeof first !== "object")
        return;
    const name = (first.student_name || "Unknown Student").toString().trim();
    // Duplicate the name (e.g., "John Doe John Doe")
    first.student_name = `${name} ${name}`.trim();
    // For each question/subpart, set marks = max_marks; adjust remarks
    let sumMax = 0;
    if (Array.isArray(first.questions)) {
        for (const q of first.questions) {
            const qMax = Number(q?.max_marks ?? 0) || 0;
            if (Array.isArray(q?.subparts) && q.subparts.length > 0) {
                let subSum = 0;
                for (const sp of q.subparts) {
                    const spMax = Number(sp?.max_marks ?? 0) || 0;
                    sp.marks = spMax;
                    if (typeof sp.remarks === "string" && sp.remarks.length > 0) {
                        sp.remarks = `${sp.remarks} | Solution key (full marks)`;
                    }
                    else {
                        sp.remarks = "Solution key (full marks)";
                    }
                    subSum += spMax;
                }
                q.marks = subSum;
            }
            else {
                q.marks = qMax;
            }
            // tag question remark
            if (typeof q.remarks === "string" && q.remarks.length > 0) {
                q.remarks = `${q.remarks} | Solution key (full marks)`;
            }
            else {
                q.remarks = "Solution key (full marks)";
            }
            sumMax += Number(q.marks || 0);
        }
    }
    // total/max
    // If max_score is present in JSON, prefer it; otherwise sum per-question max if available
    let computedMax = 0;
    if (Array.isArray(first.questions)) {
        for (const q of first.questions) {
            if (Array.isArray(q?.subparts) && q.subparts.length > 0) {
                for (const sp of q.subparts) {
                    computedMax += Number(sp?.max_marks ?? 0) || 0;
                }
            }
            else {
                computedMax += Number(q?.max_marks ?? 0) || 0;
            }
        }
    }
    first.total_score = sumMax;
    first.max_score = Number(first.max_score ?? computedMax ?? sumMax) || sumMax;
    // add helpful overall remark
    if (typeof first.remarks === "string" && first.remarks.length > 0) {
        first.remarks = `${first.remarks} | Solution paper (awarded full marks).`;
    }
    else {
        first.remarks = "Solution paper (awarded full marks).";
    }
}
// ---------- Routes ----------
function setupGraderRoutes(app, supabase) {
    // ========== Analyze / Grade ==========
    app.post("/analyze-quiz/:id", async (req, res) => {
        try {
            const quizId = req.params.id;
            const { gradingMode = "balanced", gradingPrompt = "", provider = (process.env.DEFAULT_GRADER_PROVIDER || "openai").toLowerCase(), rubric, leniency = "exact_only", useSolutionKey = false, } = req.body;
            console.log(`🧠 Grading quiz ${quizId} (${gradingMode} mode, provider=${provider}, leniency=${leniency}, solutionKey=${useSolutionKey})`);
            const { data: quiz, error: quizError } = await supabase
                .from("quizzes")
                .select("id, teacher_id, original_pdf, extracted_text")
                .eq("id", quizId)
                .single();
            if (quizError || !quiz?.extracted_text)
                return res.status(404).json({ error: "No extracted text found for quiz." });
            const rawText = (quiz.extracted_text || "").slice(0, 15000);
            const prompt = buildGradingPrompt(rawText, gradingMode, gradingPrompt, rubric, leniency || "exact_only", !!useSolutionKey);
            let graded = "";
            if (provider === "gemini")
                graded = await gradeWithGemini(prompt);
            else
                graded = await gradeWithOpenAI(prompt);
            console.log(`✅ AI Grading Completed (len=${graded?.length || 0})`);
            // ---- Normalize parsed JSON for DB ----
            const parsedArray = normalizeGradedToArray(graded);
            // >>>> NEW: If solution-key option is on, force the first parsed paper to be the solution paper with full marks.
            if (useSolutionKey && Array.isArray(parsedArray) && parsedArray.length > 0) {
                try {
                    forceSolutionFullMarks(parsedArray[0]);
                }
                catch (e) {
                    console.warn("⚠️ Could not enforce solution full marks:", e?.message);
                }
            }
            if (!parsedArray) {
                console.warn("⚠️ Model output was not valid JSON — nothing saved to grades. Raw saved to quizzes.formatted_text.");
            }
            else {
                console.log(`📦 Parsed ${parsedArray.length} student record(s) from model output`);
            }
            // Save to quizzes (store both raw + parsed json if available)
            const { error: upQuizErr } = await supabase
                .from("quizzes")
                .update({
                grading_mode: gradingMode,
                formatted_text: graded, // raw string for debugging
                graded_json: parsedArray ?? null, // JSON/JSONB safe
            })
                .eq("id", quizId);
            if (upQuizErr) {
                console.warn("⚠️ quizzes update failed:", upQuizErr.message);
            }
            // Parse & save per-student grades
            try {
                if (Array.isArray(parsedArray) && parsedArray.length) {
                    let saved = 0;
                    for (const student of parsedArray) {
                        const { student_name, roll_number, total_score, max_score, unreadable, } = student || {};
                        if (unreadable) {
                            console.warn(`⚠️ Skipping unreadable paper (${student_name || "unknown"})`);
                            continue;
                        }
                        // find/create student
                        let { data: existingStudent } = await supabase
                            .from("students")
                            .select("id")
                            .eq("roll_number", roll_number)
                            .maybeSingle();
                        if (!existingStudent && student_name) {
                            const { data } = await supabase
                                .from("students")
                                .select("id")
                                .eq("name", student_name)
                                .eq("teacher_id", quiz.teacher_id)
                                .maybeSingle();
                            existingStudent = data;
                        }
                        let studentId = existingStudent?.id;
                        if (!studentId) {
                            const { data: newStudent, error: insertErr } = await supabase
                                .from("students")
                                .insert([
                                {
                                    name: student_name || "Unknown Student",
                                    roll_number: roll_number || null,
                                    teacher_id: quiz.teacher_id,
                                },
                            ])
                                .select()
                                .single();
                            if (insertErr)
                                throw insertErr;
                            studentId = newStudent.id;
                            console.log(`🆕 Added new student: ${student_name} (${roll_number})`);
                        }
                        const { error: gradeErr } = await supabase.from("grades").insert([
                            {
                                quiz_id: quizId,
                                student_id: studentId,
                                total_score: total_score || 0,
                                max_score: max_score || 0,
                                graded_json: student,
                            },
                        ]);
                        if (gradeErr) {
                            console.warn("⚠️ Grade insert failed:", gradeErr.message);
                        }
                        else {
                            saved++;
                            console.log(`✅ Saved grade for ${student_name} (${roll_number})`);
                        }
                    }
                    console.log(`💾 Grades saved: ${saved}/${parsedArray.length}`);
                }
            }
            catch (err) {
                console.warn("⚠️ Failed to parse/save grades:", err.message);
            }
            res.json({ success: true, graded });
        }
        catch (err) {
            console.error("❌ Grading Error:", err.message);
            res.status(500).json({ error: err.message });
        }
    });
    // ========== Export CSV ==========
    app.post("/export-csv/:id", async (req, res) => {
        try {
            const quizId = req.params.id;
            // Pull quiz + grades
            const { data: quiz, error: qErr } = await supabase
                .from("quizzes")
                .select("id, created_at")
                .eq("id", quizId)
                .single();
            if (qErr || !quiz)
                return res.status(404).json({ error: "Quiz not found" });
            const { data: rows, error: gErr } = await supabase
                .from("grades")
                .select("graded_json")
                .eq("quiz_id", quizId);
            if (gErr)
                throw gErr;
            // Build flat CSV
            const header = [
                "quiz_id",
                "created_at",
                "student_name",
                "roll_number",
                "total_score",
                "max_score",
                "remarks",
            ];
            const out = [header.join(",")];
            for (const r of (rows || [])) {
                const s = r.graded_json || {};
                out.push([
                    csvEscape(quizId),
                    csvEscape(quiz.created_at),
                    csvEscape(s.student_name),
                    csvEscape(s.roll_number),
                    csvEscape(s.total_score),
                    csvEscape(s.max_score),
                    csvEscape(s.remarks),
                ].join(","));
            }
            const csvContent = out.join("\n");
            const fileName = `csv/${quizId}-${Date.now()}.csv`;
            // Use ArrayBuffer instead of Blob to avoid DOM typings
            const csvBytes = new TextEncoder().encode(csvContent);
            const csvAB = toArrayBuffer(csvBytes);
            const { error: upErr } = await supabase.storage
                .from(RESULTS_BUCKET)
                .upload(fileName, csvAB, {
                contentType: "text/csv",
                upsert: true,
            });
            if (upErr)
                throw upErr;
            // Store path in results_xls field for reuse in your UI
            await supabase
                .from("quizzes")
                .update({ results_xls: fileName })
                .eq("id", quizId);
            res.json({
                success: true,
                path: fileName,
                public_url: `${process.env.SUPABASE_URL}/storage/v1/object/public/${RESULTS_BUCKET}/${fileName}`,
            });
        }
        catch (e) {
            console.error("❌ CSV Export Error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });
    // ========== Build graded PDFs pack (solution/best/avg/low) ==========
    app.post("/build-graded-pack/:id", async (req, res) => {
        try {
            const quizId = req.params.id;
            // quiz + original pdf
            const { data: quiz, error: quizError } = await supabase
                .from("quizzes")
                .select("id, original_pdf")
                .eq("id", quizId)
                .single();
            if (quizError || !quiz?.original_pdf) {
                return res.status(404).json({ error: "Quiz or original PDF not found" });
            }
            // download original
            const { data: file, error: dErr } = await supabase.storage
                .from(QUIZ_BUCKET)
                .download(quiz.original_pdf);
            if (dErr || !file)
                throw new Error("Failed to download original quiz PDF");
            const originalBuf = Buffer.from(await file.arrayBuffer());
            // get grades
            const { data: rows, error: gErr } = await supabase
                .from("grades")
                .select("graded_json")
                .eq("quiz_id", quizId);
            if (gErr)
                throw gErr;
            if (!rows || rows.length === 0) {
                return res.status(400).json({ error: "No grades to build pack" });
            }
            const list = rows
                .map((r) => r.graded_json)
                .filter(Boolean)
                .sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
            const solution = list[0];
            const best = list[0];
            const low = list[list.length - 1];
            const avg = list[Math.floor(list.length / 2)];
            async function makeAndUpload(label, summary) {
                const stamped = await annotatePdfWithSummary(originalBuf, summary);
                // Use ArrayBuffer instead of Blob
                const stampedAB = toArrayBuffer(stamped);
                const name = `packs/${quizId}-${label}-${Date.now()}.pdf`;
                const { error: upErr } = await supabase.storage
                    .from(GRADED_BUCKET)
                    .upload(name, stampedAB, {
                    contentType: "application/pdf",
                    upsert: true,
                });
                if (upErr)
                    throw upErr;
                return `${process.env.SUPABASE_URL}/storage/v1/object/public/${GRADED_BUCKET}/${name}`;
            }
            const urls = {
                solution_pdf: await makeAndUpload("solution", solution),
                best_pdf: await makeAndUpload("best", best),
                average_pdf: await makeAndUpload("average", avg),
                low_pdf: await makeAndUpload("low", low),
            };
            res.json({ success: true, ...urls });
        }
        catch (e) {
            console.error("❌ Build Pack Error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });
}
