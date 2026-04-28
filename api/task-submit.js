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
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

function assertPost(req, res) {
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

export default async function handler(req, res) {
  try {
    if (!assertPost(req, res)) return;

    ensureFirebaseAdminInit();

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing or malformed Authorization header" });

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch {
      return res.status(403).json({ error: "Invalid or expired Firebase ID token" });
    }

    const { taskId, textAnswer, files } = req.body ?? {};
    if (!taskId || typeof taskId !== "string") return res.status(400).json({ error: "Missing taskId" });

    const uid = decoded.uid;

    const db = getFirestore();
    const taskRef = db.collection("tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) return res.status(404).json({ error: "Task not found" });

    const task = taskSnap.data() || {};
    const deadline = coerceDate(task.deadline);
    if (!deadline) return res.status(400).json({ error: "Task deadline is invalid" });
    if (Date.now() > deadline.getTime()) return res.status(409).json({ error: "Task deadline has passed" });

    const safeText = typeof textAnswer === "string" ? textAnswer.trim() : "";
    const safeFiles = Array.isArray(files) ? files : [];
    if (!safeText && safeFiles.length === 0) return res.status(400).json({ error: "Empty submission" });

    const existingQuery = await db
      .collection("task_submissions")
      .where("taskId", "==", taskId)
      .where("userId", "==", uid)
      .limit(1)
      .get();

    if (!existingQuery.empty) return res.status(409).json({ error: "You have already submitted for this task" });

    const userSnap = await db.collection("users").doc(uid).get();
    const userProfile = userSnap.exists ? userSnap.data() : {};
    const candidateName = userProfile?.name || decoded.name || decoded.email?.split("@")[0] || "Candidate";

    const now = new Date();
    const submissionRef = db.collection("task_submissions").doc();
    const leaderboardRef = db.collection("task_leaderboards").doc(taskId).collection("entries").doc(uid);

    await db.runTransaction(async tx => {
      const dupe = await tx.get(
        db.collection("task_submissions").where("taskId", "==", taskId).where("userId", "==", uid).limit(1)
      );
      if (!dupe.empty) {
        const err = new Error("duplicate");
        err.code = "DUP";
        throw err;
      }

      tx.set(submissionRef, {
        taskId,
        userId: uid,
        textAnswer: safeText,
        files: safeFiles,
        scores: { promptScore: 0, taskScore: 0, evaluationScore: 0 },
        totalScore: 0,
        skillLevel: "Pending",
        flags: [],
        feedback: [],
        evaluationSource: "pending",
        submittedAt: now,
        submittedAtIso: now.toISOString(),
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
          totalScore: 0,
          skillLevel: "Pending",
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

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("/api/task-submit failed", error);
    if (error?.code === "DUP") return res.status(409).json({ error: "You have already submitted for this task" });
    const message = error?.message || "Server error";
    return res.status(500).json({ error: message });
  }
}
