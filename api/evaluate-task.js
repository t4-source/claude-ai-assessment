import OpenAI from "openai";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { initializeApp, getApps, cert } from "firebase-admin/app";

function cleanEnv(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  if (str === "undefined" || str === "null") return null;
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    const inner = str.slice(1, -1).trim();
    if (!inner || inner === "undefined" || inner === "null") return null;
    return inner;
  }
  return str;
}

function ensureFirebaseAdminInit() {
  if (getApps().length) return;

  const projectId = cleanEnv(process.env.FIREBASE_PROJECT_ID) || cleanEnv(process.env.GOOGLE_CLOUD_PROJECT) || cleanEnv(process.env.GCLOUD_PROJECT);
  const clientEmail = cleanEnv(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKeyRaw = cleanEnv(process.env.FIREBASE_PRIVATE_KEY);
  const privateKey = privateKeyRaw?.replace(/\\n/g, "\n");

  const missing = [
    !projectId && "FIREBASE_PROJECT_ID",
    !clientEmail && "FIREBASE_CLIENT_EMAIL",
    !privateKey && "FIREBASE_PRIVATE_KEY",
  ].filter(Boolean);

  if (missing.length) {
    const err = new Error(`Missing Firebase Admin env vars: ${missing.join(", ")}`);
    err.code = "FIREBASE_ADMIN_ENV_MISSING";
    throw err;
  }

  initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

const TASK_EVALUATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "totalScore", "skillLevel", "flags", "feedback"],
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
  },
};

function assertJsonRequest(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return false;
  }
  return true;
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function coerceDate(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) ? null : d;
  }
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function getSkillLevel(totalScore) {
  if (totalScore < 16) return "Beginner";
  if (totalScore < 28) return "Intermediate";
  return "Advanced";
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value) || 0);
  return Math.max(min, Math.min(max, n));
}

function normalizeEvaluation(raw) {
  const promptScore = clampInt(raw?.scores?.promptScore, 0, 10);
  const taskScore = clampInt(raw?.scores?.taskScore, 0, 20);
  const evaluationScore = clampInt(raw?.scores?.evaluationScore, 0, 10);
  const totalScore = clampInt(raw?.totalScore ?? promptScore + taskScore + evaluationScore, 0, 40);

  return {
    scores: { promptScore, taskScore, evaluationScore },
    totalScore,
    skillLevel: raw?.skillLevel || getSkillLevel(totalScore),
    flags: Array.isArray(raw?.flags) ? raw.flags : [],
    feedback: Array.isArray(raw?.feedback) ? raw.feedback.slice(0, 8) : [],
  };
}

function heuristicEvaluateTask({ taskTitle, taskDescription, answer }) {
  const text = String(answer || "");
  const lower = text.toLowerCase();
  const len = text.trim().length;

  const hasSteps = /\b(step\s*\d+|1\.|2\.|3\.|\-\s|•\s)/i.test(text);
  const hasTables = /\b(table|pivot|vlookup|xlookup|sumifs|filter|power query)\b/i.test(text);
  const hasChecks = /\b(check|reconcile|tie\s*out|cross[- ]check|validate|verify|control|audit\s+trail)\b/i.test(text);
  const hasNumbers = /\d{2,}/.test(text);
  const hasDomain = /\b(gst|gstr-?1|gstr-?3b|itc|ind\s*as|audit|vouching|sampling|materiality|reconciliation|ledger)\b/i.test(text);

  const promptScore = clampInt(
    (len > 700 ? 6 : len > 350 ? 4 : len > 120 ? 2 : 1) + (hasSteps ? 2 : 0) + (hasTables ? 2 : 0),
    0,
    10
  );

  const taskScore = clampInt(
    (hasDomain ? 10 : 6) + (hasTables ? 4 : 0) + (hasNumbers ? 2 : 0) + (hasSteps ? 3 : 0),
    0,
    20
  );

  const evaluationScore = clampInt((hasChecks ? 6 : 3) + (lower.includes("risk") ? 2 : 0) + (lower.includes("limitation") ? 2 : 0), 0, 10);
  const totalScore = clampInt(promptScore + taskScore + evaluationScore, 0, 40);

  const flags = [];
  if (len < 120) flags.push("generic_answer");
  if (!hasChecks) flags.push("no_checks");
  if (!hasNumbers) flags.push("missing_numbers");

  const feedback = [
    hasSteps ? "Good: You outlined a clear step-by-step approach." : "Add a step-by-step approach (numbered steps) for clarity.",
    hasTables ? "Good: You suggested Excel-ready techniques (e.g., Pivot/VLOOKUP/SUMIFS/Power Query)." : "Include Excel-ready steps (Pivot/SUMIFS/Power Query) for practical execution.",
    hasChecks ? "Good: You included verification/reconciliation checks." : "Add verification checks (tie-outs, cross-checks, control checks) before concluding.",
    hasNumbers ? "Good: You referenced quantitative elements." : "Add example thresholds, tolerances, or sample calculations to demonstrate professional judgement.",
  ].slice(0, 6);

  return {
    scores: { promptScore, taskScore, evaluationScore },
    totalScore,
    skillLevel: getSkillLevel(totalScore),
    flags,
    feedback,
    meta: {
      taskTitle: String(taskTitle || "").slice(0, 160),
      taskDescriptionHint: String(taskDescription || "").slice(0, 240),
    },
  };
}

const TASK_RUBRIC = `
You are scoring a DAILY SKILL TASK submission for a Chartered Accountant (CA).

You will receive:
- task.title
- task.description (case-based: audit/GST/reconciliation/Ind AS)
- candidate.answer (plain text)

Return STRICT JSON per schema.

Scoring rubric:
- promptScore (0-10): clarity/structure, assumptions, evidence references, materiality/thresholds, output format, controls.
- taskScore (0-20): domain correctness (GST/audit), reconciliation logic, steps, edge cases, practicality (Excel-ready), professional judgement.
- evaluationScore (0-10): self-checks, limitations, verification steps, risk flags, follow-up actions.

Feedback must be short and actionable (bullets). Flags are optional warnings like: generic_answer, missing_numbers, no_checks, late_submission_attempt, copied_sounding.
`;

export default async function handler(req, res) {
  try {
    if (!assertJsonRequest(req, res)) return;

    ensureFirebaseAdminInit();

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing or malformed Authorization header" });

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch {
      return res.status(403).json({ error: "Invalid or expired Firebase ID token" });
    }

    const { taskId, answers } = req.body ?? {};
    if (!taskId || typeof taskId !== "string") {
      return res.status(400).json({ error: "Missing taskId" });
    }
    if (!answers || typeof answers !== "string") {
      return res.status(400).json({ error: "Missing answers" });
    }

    const db = getFirestore();
    const uid = decoded.uid;

    const taskRef = db.collection("tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) return res.status(404).json({ error: "Task not found" });

    const task = taskSnap.data() || {};
    if (!task.active) return res.status(409).json({ error: "Task is not active" });

    const deadline = coerceDate(task.deadline);
    if (!deadline) return res.status(400).json({ error: "Task deadline is invalid" });
    if (Date.now() > deadline.getTime()) return res.status(409).json({ error: "Task deadline has passed" });

    const existingQuery = await db
      .collection("task_submissions")
      .where("taskId", "==", taskId)
      .where("userId", "==", uid)
      .limit(1)
      .get();

    if (!existingQuery.empty) return res.status(409).json({ error: "You have already submitted for this task" });

    let evaluation;
    let evaluationSource = "openai";
    let fallbackReason = null;

    if (!process.env.OPENAI_API_KEY) {
      evaluation = heuristicEvaluateTask({ taskTitle: task.title, taskDescription: task.description, answer: answers });
      evaluationSource = "openai_key_missing_fallback";
      fallbackReason = "OPENAI_API_KEY is not configured";
    } else {
      try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await openai.chat.completions.create({
          model: process.env.OPENAI_EVAL_MODEL || "gpt-4o-mini",
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "task_evaluation",
              strict: true,
              schema: TASK_EVALUATION_SCHEMA,
            },
          },
          messages: [
            { role: "system", content: `${TASK_RUBRIC}\nReturn only JSON that matches the supplied schema.` },
            {
              role: "user",
              content: JSON.stringify({
                task: { id: taskId, title: task.title || "", description: task.description || "", deadline: deadline.toISOString() },
                candidate: { uid },
                answer: answers,
              }),
            },
          ],
        });

        const raw = response.choices[0]?.message?.content;
        if (!raw) throw new Error("OpenAI returned no output");
        evaluation = normalizeEvaluation(JSON.parse(raw));
      } catch (error) {
        console.error("Task AI evaluation failed", error);
        evaluation = heuristicEvaluateTask({ taskTitle: task.title, taskDescription: task.description, answer: answers });
        evaluationSource = "openai_error_fallback";
        fallbackReason = error?.message || "OpenAI request failed";
      }
    }

    const userSnap = await db.collection("users").doc(uid).get();
    const userProfile = userSnap.exists ? userSnap.data() : {};
    const candidateName = userProfile?.name || decoded.name || decoded.email?.split("@")[0] || "Candidate";

    const submissionRef = db.collection("task_submissions").doc();
    const leaderboardRef = db.collection("task_leaderboards").doc(taskId).collection("entries").doc(uid);

    const now = new Date();

    await db.runTransaction(async tx => {
      const existing = await tx.get(
        db
          .collection("task_submissions")
          .where("taskId", "==", taskId)
          .where("userId", "==", uid)
          .limit(1)
      );

      if (!existing.empty) {
        const err = new Error("duplicate");
        err.code = "DUP";
        throw err;
      }

      tx.set(submissionRef, {
        taskId,
        userId: uid,
        answers,
        scores: evaluation.scores,
        totalScore: evaluation.totalScore,
        skillLevel: evaluation.skillLevel,
        flags: evaluation.flags,
        feedback: evaluation.feedback,
        evaluationSource,
        submittedAt: now,
        createdAt: now,
      });

      tx.set(
        taskRef,
        {
          submissionCount: FieldValue.increment(1),
          lastSubmissionAt: now,
        },
        { merge: true }
      );

      tx.set(
        leaderboardRef,
        {
          taskId,
          userId: uid,
          candidateName,
          totalScore: evaluation.totalScore,
          skillLevel: evaluation.skillLevel,
          submittedAt: now,
        },
        { merge: true }
      );

      tx.set(
        db.collection("task_leaderboards").doc(taskId),
        {
          taskId,
          updatedAt: now,
          title: task.title || "",
        },
        { merge: true }
      );
    });

    return res.status(200).json({
      ...evaluation,
      source: evaluationSource,
      ...(fallbackReason ? { fallbackReason } : {}),
    });
  } catch (error) {
    console.error("/api/evaluate-task failed", error);
    if (res.headersSent) return;
    const message = error?.message || "Server error";
    const status = error?.code === "FIREBASE_ADMIN_ENV_MISSING" ? 500 : 500;
    return res.status(status).json({ error: message });
  }
}
