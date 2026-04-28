import { getAuth } from "firebase-admin/auth";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  return h.slice(7);
}

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [
  "mp4","mov","avi","mkv","webm","wmv",
  "jpg","jpeg","png","gif","webp","heic","heif",
  "pdf","doc","docx","xls","xlsx","ppt","pptx",
];

function getExt(name) {
  return String(name || "").split(".").pop()?.toLowerCase() || "";
}

function sanitizeFilename(name) {
  const base = String(name || "file").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return base.slice(0, 160) || "file";
}

function r2Client() {
  const accountId = cleanEnv(process.env.R2_ACCOUNT_ID);
  const accessKeyId = cleanEnv(process.env.R2_ACCESS_KEY_ID);
  const secretAccessKey = cleanEnv(process.env.R2_SECRET_ACCESS_KEY);
  const region = cleanEnv(process.env.R2_REGION) || "auto";

  const missing = [
    !accountId && "R2_ACCOUNT_ID",
    !accessKeyId && "R2_ACCESS_KEY_ID",
    !secretAccessKey && "R2_SECRET_ACCESS_KEY",
  ].filter(Boolean);

  if (missing.length) {
    const err = new Error(`Missing R2 env vars: ${missing.join(", ")}`);
    err.code = "R2_ENV_MISSING";
    throw err;
  }

  return new S3Client({
    region,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
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

    const { taskId, name, size, contentType } = req.body || {};
    if (!taskId || typeof taskId !== "string") return res.status(400).json({ error: "Missing taskId" });
    if (!name || typeof name !== "string") return res.status(400).json({ error: "Missing name" });
    if (!size || typeof size !== "number") return res.status(400).json({ error: "Missing size" });
    if (size <= 0 || size > MAX_FILE_BYTES) return res.status(400).json({ error: `${name} exceeds 200 MB limit` });

    const ext = getExt(name);
    if (!ALLOWED_EXTENSIONS.includes(ext)) return res.status(400).json({ error: `${name} — unsupported file type` });

    const db = getFirestore();
    const taskSnap = await db.collection("tasks").doc(taskId).get();
    if (!taskSnap.exists) return res.status(404).json({ error: "Task not found" });

    const uid = decoded.uid;

    // Build object key
    const safeName = sanitizeFilename(name);
    const objectKey = `task_submissions/${taskId}/${uid}/${Date.now()}_${safeName}`;

    const bucket = cleanEnv(process.env.R2_BUCKET);
    if (!bucket) return res.status(500).json({ error: "Missing R2_BUCKET" });

    const client = r2Client();
    const putCmd = new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: typeof contentType === "string" ? contentType : undefined,
      // Enforce size indirectly via client validation; R2 doesn't support max-size in signed URL.
    });

    const uploadUrl = await getSignedUrl(client, putCmd, { expiresIn: 60 * 10 }); // 10 minutes

    return res.status(200).json({
      uploadUrl,
      objectKey,
      bucket,
      expiresIn: 600,
    });
  } catch (error) {
    console.error("/api/r2-upload-init failed", error);
    const message = error?.message || "Server error";
    return res.status(500).json({ error: message });
  }
}
