import OpenAI from "openai";
import { getAuth } from "firebase-admin/auth";
import { initializeApp, getApps, cert } from "firebase-admin/app";

// ── Firebase Admin bootstrap (safe to call multiple times on Vercel) ──────────
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel escapes newlines in env vars – restore them
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const EVALUATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "totalScore", "skillLevel", "flags", "feedback", "qualitySignals"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: ["promptScore", "taskScore", "evaluationScore"],
      properties: {
        promptScore: { type: "integer", minimum: 0, maximum: 10 },
        taskScore: { type: "integer", minimum: 0, maximum: 20 },
        evaluationScore: { type: "integer", minimum: 0, maximum: 10 },
      },
    },
    totalScore: { type: "integer", minimum: 0, maximum: 40 },
    skillLevel: { type: "string", enum: ["Beginner", "Intermediate", "Advanced"] },
    flags: { type: "array", items: { type: "string" } },
    feedback: { type: "array", items: { type: "string" } },
    qualitySignals: {
      type: "object",
      additionalProperties: false,
      required: ["structuredPrompt", "domainSpecific", "actionableEvaluation", "formatSpecified"],
      properties: {
        structuredPrompt: { type: "boolean" },
        domainSpecific: { type: "boolean" },
        actionableEvaluation: { type: "boolean" },
        formatSpecified: { type: "boolean" },
      },
    },
  },
};

const RUBRIC = `
Score an AI skills assessment for Chartered Accountants.

Rubric:
- Prompt Engineering, 10 points: clear CA role, source documents, materiality, audit/tax checks, constraints, expected output format, and measurable criteria.
- Task Submission, 20 points: practical Excel/CSV/file workflow quality, reconciliation logic, formula validation, exception thresholds, output usability, and professional applicability.
- Output Evaluation, 10 points: identifies missing source evidence, formula risks, verification gaps, materiality, limitations, and actionable follow-up instructions.

Reward answers that show realistic CA judgment, AI quality control, file-format awareness, Excel-ready output, and safe reliance standards. Flag weak submissions, likely copied content, generic/vague answers, hallucinated claims, or missing sections. Keep feedback concise and actionable.
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── 1. Firebase Auth: verify Bearer token ─────────────────────────────────
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }
  try {
    await getAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return res.status(403).json({ error: "Invalid or expired Firebase ID token" });
  }

  // ── 2. Validate env + body ────────────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OPENAI_API_KEY is not configured" });
  }

  const answers = req.body?.answers;
  if (!answers || typeof answers !== "object") {
    return res.status(400).json({ error: "Missing answers payload" });
  }

  // ── 3. Call OpenAI with the correct chat completions API ─────────────────
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // FIX 1: openai.responses.create() does not exist →
    //         use openai.chat.completions.create()
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_EVAL_MODEL || "gpt-4o-mini",
      // Structured JSON output – equivalent to your json_schema format
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "assessment_evaluation",
          strict: true,
          schema: EVALUATION_SCHEMA,
        },
      },
      messages: [
        {
          role: "system",
          content: `${RUBRIC}\nReturn only JSON that matches the supplied schema.`,
        },
        {
          role: "user",
          content: JSON.stringify({ answers }),
        },
      ],
    });

    // FIX 2: response.output_text does not exist on chat completions →
    //         the content lives at response.choices[0].message.content
    const rawContent = response.choices[0]?.message?.content;
    if (!rawContent) throw new Error("OpenAI returned no structured output");

    // FIX 3: response_format with json_schema still returns a string →
    //         always parse it explicitly
    return res.status(200).json({ ...JSON.parse(rawContent), source: "openai" });
  } catch (error) {
    console.error("AI evaluation failed", error);
    return res.status(500).json({ error: "AI evaluation failed" });
  }
}