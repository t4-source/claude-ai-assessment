import OpenAI from "openai";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { initializeApp, getApps, cert } from "firebase-admin/app";

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
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
  if (!assertJsonRequest(req, res)) return;

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

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OPENAI_API_KEY is not configured" });
  }

  let evaluation;
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
    return res.status(500).json({ error: "AI evaluation failed" });
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

  return res.status(200).json({ ...evaluation, source: "openai" });
}
