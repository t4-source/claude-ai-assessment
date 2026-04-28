import { getAuth } from "firebase-admin/auth";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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
    credentials: { accessKeyId, secretAccessKey },
  });
}

function parseOwnerFromKey(key) {
  const parts = String(key || "").split("/");
  if (parts.length < 4) return null;
  if (parts[0] !== "task_submissions") return null;
  return { taskId: parts[1], userId: parts[2] };
}

async function isAdminUid(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists && snap.data()?.role === "admin";
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

    const { key } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "Missing key" });

    const owner = parseOwnerFromKey(key);
    if (!owner) return res.status(400).json({ error: "Invalid key" });

    const db = getFirestore();
    const uid = decoded.uid;

    const admin = await isAdminUid(db, uid);
    if (!admin && uid !== owner.userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const bucket = cleanEnv(process.env.R2_BUCKET);
    if (!bucket) return res.status(500).json({ error: "Missing R2_BUCKET" });

    const client = r2Client();
    const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const signedUrl = await getSignedUrl(client, getCmd, { expiresIn: 60 * 5 });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ url: signedUrl, expiresIn: 300 });
  } catch (error) {
    console.error("/api/r2-get-url failed", error);
    const message = error?.message || "Server error";
    return res.status(500).json({ error: message });
  }
}
