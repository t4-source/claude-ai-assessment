import { useState, useEffect, useCallback, useRef } from "react";
import { initializeApp, getApps } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  where,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  addDoc,
} from "firebase/firestore";
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "firebase/storage";

// ─── Firebase bootstrap ────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const firebaseReady = Boolean(
  FIREBASE_CONFIG.apiKey &&
  FIREBASE_CONFIG.authDomain &&
  FIREBASE_CONFIG.projectId &&
  FIREBASE_CONFIG.storageBucket &&
  FIREBASE_CONFIG.appId
);

const firebaseApp = firebaseReady ? getApps()[0] || initializeApp(FIREBASE_CONFIG) : null;
const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;
const firestore = firebaseApp ? getFirestore(firebaseApp) : null;
const storage = firebaseApp ? getStorage(firebaseApp) : null;

// Increase retry time for large file uploads on potentially unstable or slow connections
if (storage) {
  storage.maxUploadRetryTime = 600000; // 10 minutes
}

// ─── Constants ─────────────────────────────────────────────────────────────
const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB
const ALLOWED_MIME_PREFIXES = ["video/", "image/", "application/pdf", "application/"];
const ALLOWED_EXTENSIONS = [
  "mp4","mov","avi","mkv","webm","wmv",          // video
  "jpg","jpeg","png","gif","webp","heic","heif",  // image
  "pdf","doc","docx","xls","xlsx","ppt","pptx",  // document
];

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function getFileType(name = "") {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["mp4","mov","avi","mkv","webm","wmv"].includes(ext)) return "video";
  if (["jpg","jpeg","png","gif","webp","heic","heif"].includes(ext)) return "image";
  return "document";
}

function getIsoDate(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return "";
}

function getSkillLevel(totalScore) {
  if (totalScore < 16) return "Beginner";
  if (totalScore < 28) return "Intermediate";
  return "Advanced";
}

function clampScore(value, max) {
  return Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
}

// ─── Normalizers ──────────────────────────────────────────────────────────
function normalizeUser(id, data = {}, authUser = null) {
  const email = data.email || authUser?.email || "";
  return {
    id,
    name: data.name || authUser?.displayName || email.split("@")[0] || "User",
    email,
    role: data.role || "candidate",
    domain: data.domain || "N/A",
    experience: data.experience || "N/A",
    aiUsage: data.aiUsage || "N/A",
    createdAt: getIsoDate(data.createdAt),
  };
}

function normalizeTask(id, data = {}) {
  return {
    id,
    title: data.title || "",
    description: data.description || "",
    createdBy: data.createdBy || "",
    createdAt: getIsoDate(data.createdAt),
    deadline: getIsoDate(data.deadline),
    active: Boolean(data.active),
    submissionCount: Number(data.submissionCount || 0),
  };
}

function normalizeTaskSubmission(id, data = {}) {
  const scores = {
    promptScore: Number(data.scores?.promptScore || 0),
    taskScore: Number(data.scores?.taskScore || 0),
    evaluationScore: Number(data.scores?.evaluationScore || 0),
  };
  const totalScore = Number.isFinite(data.totalScore)
    ? data.totalScore
    : scores.promptScore + scores.taskScore + scores.evaluationScore;

  return {
    id,
    taskId: data.taskId || "",
    userId: data.userId || "",
    textAnswer: typeof data.textAnswer === "string" ? data.textAnswer : "",
    files: Array.isArray(data.files) ? data.files : [],
    scores,
    totalScore,
    skillLevel: data.skillLevel || (data.evaluationSource === "pending" ? "Pending" : getSkillLevel(totalScore)),
    flags: Array.isArray(data.flags) ? data.flags : [],
    feedback: Array.isArray(data.feedback) ? data.feedback : [],
    submittedAt: getIsoDate(data.submittedAt) || data.submittedAtIso || "",
    scoredAt: getIsoDate(data.scoredAt) || "",
    submittedAtMs: data.submittedAt?.toMillis?.() || (data.submittedAtIso ? new Date(data.submittedAtIso).getTime() : 0),
    evaluationSource: data.evaluationSource || "pending",
  };
}

// ─── App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [users, setUsers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [taskSubmissions, setTaskSubmissions] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [view, setView] = useState("login");
  const [notification, setNotification] = useState(null);
  const [centerMessage, setCenterMessage] = useState(null); // { msg, type }
  const [authReady, setAuthReady] = useState(!firebaseReady);
  const db = { users, tasks, taskSubmissions };

  const notify = useCallback((msg, type = "success") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 4000);

    // Escalate important upload/validation errors to a centered modal for clarity
    if (type === "error") {
      const m = String(msg || "");
      if (
        /exceeds\s+200\s*mb/i.test(m) ||
        /unsupported file type/i.test(m) ||
        /upload/i.test(m) ||
        /stalled/i.test(m)
      ) {
        setCenterMessage({ msg, type });
      }
    }
  }, []);

  // Auth listener
  useEffect(() => {
    if (!firebaseAuth || !firestore) return;
    let unsubProfile = () => {};
    const unsubAuth = onAuthStateChanged(firebaseAuth, authUser => {
      unsubProfile();
      if (!authUser) {
        setCurrentUser(null);
        setAuthReady(true);
        setView("login");
        return;
      }
      unsubProfile = onSnapshot(doc(firestore, "users", authUser.uid), snap => {
        const profile = normalizeUser(authUser.uid, snap.exists() ? snap.data() : {}, authUser);
        setCurrentUser(profile);
        setAuthReady(true);
        setView(v => {
          if (v !== "login" && v !== "signup") return v;
          return profile.role === "admin" ? "admin" : "daily_tasks";
        });
      }, err => {
        notify(`Profile error: ${err.message}`, "error");
        setAuthReady(true);
      });
    });
    return () => { unsubProfile(); unsubAuth(); };
  }, [notify]);

  // Firestore listeners
  useEffect(() => {
    if (!firestore || !currentUser) {
      setUsers([]); setTasks([]); setTaskSubmissions([]);
      return;
    }

    const unsubUsers = currentUser.role === "admin"
      ? onSnapshot(collection(firestore, "users"),
          snap => setUsers(snap.docs.map(d => normalizeUser(d.id, d.data()))),
          err => notify(`Users error: ${err.message}`, "error"))
      : () => {};

    if (currentUser.role !== "admin") setUsers([currentUser]);

    const unsubTasks = onSnapshot(
      query(collection(firestore, "tasks"), orderBy("deadline", "desc")),
      snap => setTasks(snap.docs.map(d => normalizeTask(d.id, d.data()))),
      err => notify(`Tasks error: ${err.message}`, "error")
    );

    const subsQuery = currentUser.role === "admin"
      ? query(collection(firestore, "task_submissions"), orderBy("submittedAt", "desc"))
      : query(collection(firestore, "task_submissions"), where("userId", "==", currentUser.id));

    const unsubSubs = onSnapshot(subsQuery,
      snap => {
        const rows = snap.docs.map(d => normalizeTaskSubmission(d.id, d.data()));
        rows.sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
        setTaskSubmissions(rows);
      },
      err => notify(`Submissions error: ${err.message}`, "error")
    );

    return () => { unsubUsers(); unsubTasks(); unsubSubs(); };
  }, [currentUser, notify]);

  const logout = useCallback(async () => {
    if (firebaseAuth) await signOut(firebaseAuth);
    setCurrentUser(null);
    setView("login");
  }, []);

  if (!firebaseReady) return (
    <div className="app-root"><style>{CSS()}</style><FirebaseSetupNotice /></div>
  );

  if (!authReady) return (
    <div className="app-root"><style>{CSS()}</style>
      <div className="auth-page">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <span className="spinner dark" />
          <h1 className="auth-title" style={{ marginTop: 16 }}>Loading…</h1>
          <p className="auth-sub">Connecting to Firebase.</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="app-root">
      <style>{CSS()}</style>
      {centerMessage && (
        <div className="modal-overlay" onClick={() => setCenterMessage(null)}>
          <div className="modal modal-centered" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>{centerMessage.type === "error" ? "Upload Error" : "Message"}</h3>
                <div className="modal-sub">Please fix the issue and try again.</div>
              </div>
              <button className="close-btn" onClick={() => setCenterMessage(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="center-msg">{centerMessage.msg}</div>
            </div>
            <div className="modal-footer">
              <button className="btn-primary" onClick={() => setCenterMessage(null)}>OK</button>
            </div>
          </div>
        </div>
      )}
      {notification && (
        <div className={`toast toast-${notification.type}`}>
          <span>{notification.type === "success" ? "✓" : notification.type === "error" ? "✗" : "ℹ"}</span>
          {notification.msg}
        </div>
      )}
      {view === "login" && <LoginPage setView={setView} notify={notify} />}
      {view === "signup" && <SignupPage setView={setView} notify={notify} />}
      {view === "daily_tasks" && currentUser?.role === "candidate" && (
        <DailyTasksPage db={db} currentUser={currentUser} setView={setView} logout={logout} notify={notify} />
      )}
      {view === "leaderboards" && currentUser?.role === "candidate" && (
        <LeaderboardsPage db={db} currentUser={currentUser} setView={setView} logout={logout} />
      )}
      {view === "admin" && currentUser?.role === "admin" && (
        <AdminDashboard db={db} currentUser={currentUser} logout={logout} notify={notify} />
      )}
    </div>
  );
}

// ─── Firebase setup notice ─────────────────────────────────────────────────
function FirebaseSetupNotice() {
  return (
    <div className="auth-page">
      <div className="auth-card wide">
        <div className="auth-logo">
          <div className="logo-icon">CA</div>
          <div>
            <h1 className="auth-title">Firebase Setup Required</h1>
            <p className="auth-sub">Add env vars + enable Firebase Storage.</p>
          </div>
        </div>
        <div className="setup-box">
          {["VITE_FIREBASE_API_KEY","VITE_FIREBASE_AUTH_DOMAIN","VITE_FIREBASE_PROJECT_ID",
            "VITE_FIREBASE_STORAGE_BUCKET","VITE_FIREBASE_MESSAGING_SENDER_ID","VITE_FIREBASE_APP_ID"]
            .map(v => <code key={v}>{v}</code>)}
        </div>
      </div>
    </div>
  );
}

// ─── Login ─────────────────────────────────────────────────────────────────
function LoginPage({ setView, notify }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password) return notify("Email and password are required.", "error");
    setLoading(true);
    try {
      await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
    } catch (err) {
      notify(err.message || "Invalid credentials.", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <div className="logo-icon">CA</div>
          <div>
            <h1 className="auth-title">Daily Task Platform</h1>
            <p className="auth-sub">Chartered Accountant • AI Task Submissions</p>
          </div>
        </div>
        <div className="form-group">
          <label>Email</label>
          <input className="form-input" type="email" value={email}
            onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
            onKeyDown={e => e.key === "Enter" && handleLogin()} />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input className="form-input" type="password" value={password}
            onChange={e => setPassword(e.target.value)} placeholder="••••••••"
            onKeyDown={e => e.key === "Enter" && handleLogin()} />
        </div>
        <button className="btn-primary" onClick={handleLogin} disabled={loading}>
          {loading ? <span className="spinner" /> : "Sign In"}
        </button>
        <p className="auth-link">No account? <button onClick={() => setView("signup")}>Create one</button></p>
      </div>
      <div className="auth-hero">
        <h2 className="hero-heading">Submit. Record. Get Ranked.</h2>
        <p className="hero-body">Complete real CA case tasks, upload your screen recording or supporting documents, and get ranked by the admin panel. Track your performance across every task.</p>
        <div className="hero-tags">
          {["Screen Recordings","GST Reconciliation","Audit Tasks","Real-Time Leaderboard","Admin Scoring"].map(t => (
            <span key={t} className="hero-tag">{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Signup ────────────────────────────────────────────────────────────────
function SignupPage({ setView, notify }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", domain: "Audit", experience: "1-3 years", aiUsage: "Beginner" });
  const [loading, setLoading] = useState(false);

  const handleSignup = async () => {
    if (!form.name || !form.email || !form.password) return notify("All fields required.", "error");
    if (form.password.length < 6) return notify("Password must be at least 6 characters.", "error");
    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(firebaseAuth, form.email.trim(), form.password);
      await updateProfile(cred.user, { displayName: form.name.trim() });
      await setDoc(doc(firestore, "users", cred.user.uid), {
        id: cred.user.uid,
        name: form.name.trim(),
        email: form.email.trim(),
        role: "candidate",
        domain: form.domain,
        experience: form.experience,
        aiUsage: form.aiUsage,
        createdAt: serverTimestamp(),
      });
      notify("Account created!");
    } catch (err) {
      notify(err.message || "Could not create account.", "error");
    } finally {
      setLoading(false);
    }
  };

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="auth-page">
      <div className="auth-card wide">
        <button className="back-btn" onClick={() => setView("login")}>← Back</button>
        <div className="auth-logo">
          <div className="logo-icon">CA</div>
          <div><h1 className="auth-title">Create Account</h1><p className="auth-sub">Join the platform</p></div>
        </div>
        {[["Full Name","name","text","Priya Sharma"],["Email","email","email","priya@example.com"],["Password","password","password","••••••••"]]
          .map(([lbl,key,type,ph]) => (
            <div className="form-group" key={key}>
              <label>{lbl}</label>
              <input className="form-input" type={type} value={form[key]} onChange={set(key)} placeholder={ph} />
            </div>
          ))}
        <div className="form-row">
          <div className="form-group"><label>Domain</label>
            <select className="form-input" value={form.domain} onChange={set("domain")}>
              <option>Audit</option><option>Tax</option><option>Advisory</option>
            </select>
          </div>
          <div className="form-group"><label>Experience</label>
            <select className="form-input" value={form.experience} onChange={set("experience")}>
              <option>{"< 1 year"}</option><option>1-3 years</option><option>3-5 years</option><option>5+ years</option>
            </select>
          </div>
          <div className="form-group"><label>AI Usage</label>
            <select className="form-input" value={form.aiUsage} onChange={set("aiUsage")}>
              <option>Beginner</option><option>Intermediate</option><option>Advanced</option>
            </select>
          </div>
        </div>
        <button className="btn-primary" onClick={handleSignup} disabled={loading}>
          {loading ? <span className="spinner" /> : "Create Account"}
        </button>
      </div>
    </div>
  );
}

// ─── File Upload Hook ──────────────────────────────────────────────────────
function useFileUpload({ userId, taskId, notify }) {
  const [files, setFiles] = useState([]);  // { file, name, size, type, progress, url, error, storagePath }
  const [uploading, setUploading] = useState(false);

  const validateFile = (file) => {
    if (file.size > MAX_FILE_BYTES) return `${file.name} exceeds 200 MB limit`;
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!ALLOWED_EXTENSIONS.includes(ext)) return `${file.name} — unsupported file type`;
    return null;
  };

  const addFiles = useCallback((incoming) => {
    const newEntries = [];
    for (const file of incoming) {
      const err = validateFile(file);
      if (err) { notify(err, "error"); continue; }
      newEntries.push({ file, name: file.name, size: file.size, type: getFileType(file.name), progress: 0, url: null, error: null, storagePath: null });
    }
    setFiles(prev => [...prev, ...newEntries]);
  }, [notify]);

  const removeFile = useCallback((index) => {
    setFiles(prev => {
      const entry = prev[index];
      // Delete from Storage if already uploaded
      if (entry?.storagePath && storage) {
        deleteObject(storageRef(storage, entry.storagePath)).catch(() => {});
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const uploadAll = useCallback(async () => {
    if (!storage || !userId || !taskId) throw new Error("Storage not configured");
    const pending = files.filter(f => !f.url && !f.error);
    if (!pending.length) return files.filter(f => f.url).map(f => ({ name: f.name, url: f.url, size: f.size, type: f.type, storagePath: f.storagePath }));

    setUploading(true);

    // Use Firebase SDK resumable uploads for better performance + reliable progress events
    const performResumableUpload = async (file, path, index) => {
      const refObj = storageRef(storage, path);
      const uploadTask = uploadBytesResumable(refObj, file, {
        contentType: file.type || undefined,
      });

      await new Promise((resolve, reject) => {
        uploadTask.on(
          "state_changed",
          (snap) => {
            const progress = snap.totalBytes ? Math.round((snap.bytesTransferred / snap.totalBytes) * 100) : 0;
            setFiles(prev => prev.map((f, idx) => idx === index ? { ...f, progress } : f));
          },
          (err) => {
            reject(err);
          },
          () => resolve()
        );
      });

      const url = await getDownloadURL(refObj);
      return { url, storagePath: path };
    };

    const finalResults = [];
    for (let i = 0; i < files.length; i++) {
      const entry = files[i];
      if (entry.url) {
        finalResults.push(entry);
        continue;
      }

      try {
        const path = `task_submissions/${taskId}/${userId}/${Date.now()}_${entry.name}`;
        const { url, storagePath } = await performResumableUpload(entry.file, path, i);
        const successEntry = { ...entry, url, storagePath, progress: 100 };
        setFiles(prev => prev.map((f, idx) => idx === i ? successEntry : f));
        finalResults.push(successEntry);
      } catch (err) {
        const msg = err?.message || "Upload failed. Please try again.";
        notify(msg, "error");
        setFiles(prev => prev.map((f, idx) => idx === i ? { ...f, error: msg } : f));
        finalResults.push({ ...entry, error: msg });
      }
    }

    setUploading(false);
    return finalResults.filter(f => f.url).map(f => ({ name: f.name, url: f.url, size: f.size, type: f.type, storagePath: f.storagePath }));
  }, [files, userId, taskId]);

  return { files, addFiles, removeFile, uploadAll, uploading, setFiles };
}

// ─── File Preview Component ────────────────────────────────────────────────
function FilePreview({ files }) {
  if (!files?.length) return null;
  return (
    <div className="preview-container">
      {files.map((f, i) => (
        <div key={i} className="preview-item">
          <div className="preview-label">{f.name}</div>
          {f.type === "video" ? (
            <video controls playsInline preload="metadata" className="video-player">
              <source src={f.url} />
              Your browser does not support the video tag.
            </video>
          ) : f.type === "document" && f.name.toLowerCase().endsWith(".pdf") ? (
            <iframe src={`${f.url}#toolbar=0`} className="doc-viewer" title={f.name} />
          ) : f.type === "document" && /\.(doc|docx|ppt|pptx|xls|xlsx)$/i.test(f.name || "") ? (
            <iframe
              src={`https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(f.url)}`}
              className="doc-viewer"
              title={f.name}
            />
          ) : f.type === "image" ? (
            <img src={f.url} alt={f.name} className="img-preview" />
          ) : (
            <div className="no-preview">Preview not available for this file type. <a href={f.url} target="_blank" rel="noreferrer">Download to view ↗</a></div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── File Drop Zone ────────────────────────────────────────────────────────
function FileDropZone({ onFiles, disabled }) {
  const inputRef = useRef();
  const [dragging, setDragging] = useState(false);

  const handle = (fileList) => {
    if (disabled) return;
    onFiles(Array.from(fileList));
  };

  return (
    <div
      className={`drop-zone ${dragging ? "dragging" : ""} ${disabled ? "disabled" : ""}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files); }}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" multiple hidden
        accept=".mp4,.mov,.avi,.mkv,.webm,.wmv,.jpg,.jpeg,.png,.gif,.webp,.heic,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
        onChange={e => handle(e.target.files)} />
      <div className="drop-icon">📎</div>
      <div className="drop-label">{dragging ? "Drop files here" : "Click or drag files here"}</div>
      <div className="drop-hint">Screen recordings (MP4, MOV), images, or documents • Max 200 MB per file</div>
    </div>
  );
}

function FileList({ files, onRemove, disabled }) {
  if (!files.length) return null;
  return (
    <div className="file-list">
      {files.map((f, i) => (
        <div key={i} className={`file-item ${f.error ? "file-error" : f.url ? "file-done" : ""}`}>
          <div className="file-icon">{f.type === "video" ? "🎥" : f.type === "image" ? "🖼" : "📄"}</div>
          <div className="file-info">
            <div className="file-name">{f.name}</div>
            <div className="file-meta">
              {formatBytes(f.size)}
              {f.error && <span className="file-err-label"> • {f.error}</span>}
              {f.url && <span className="file-ok-label"> • Uploaded ✓</span>}
              {!f.url && !f.error && f.progress > 0 && <span> • {f.progress}%</span>}
            </div>
            {!f.url && !f.error && f.progress > 0 && (
              <div className="file-progress-track"><div className="file-progress-bar" style={{ width: `${f.progress}%` }} /></div>
            )}
          </div>
          {!disabled && !f.url && (
            <button className="file-remove" onClick={() => onRemove(i)}>✕</button>
          )}
          {f.url && (
            <a href={f.url} target="_blank" rel="noreferrer" className="file-view-btn">View</a>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Daily Tasks (Candidate) ───────────────────────────────────────────────
function DailyTasksPage({ db, currentUser, setView, logout, notify }) {
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [textDraft, setTextDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const mySubsByTask = new Map(
    db.taskSubmissions.filter(s => s.userId === currentUser.id).map(s => [s.taskId, s])
  );
  const activeTasks = db.tasks.filter(t => t.active)
    .sort((a, b) => (a.deadline || "").localeCompare(b.deadline || ""));
  const selectedTask = selectedTaskId ? db.tasks.find(t => t.id === selectedTaskId) : null;
  const mySubmission = selectedTask ? mySubsByTask.get(selectedTask.id) : null;
  const deadlineMs = selectedTask?.deadline ? new Date(selectedTask.deadline).getTime() : 0;
  const isLate = deadlineMs ? Date.now() > deadlineMs : false;
  const canSubmit = Boolean(selectedTask && !mySubmission && !isLate);

  // Per-task file upload state
  const { files, addFiles, removeFile, uploadAll, uploading } = useFileUpload({
    userId: currentUser.id,
    taskId: selectedTaskId,
    notify,
  });

  // Restore text draft from localStorage
  useEffect(() => {
    if (!selectedTaskId) return;
    const saved = localStorage.getItem(`task_draft_${currentUser.id}_${selectedTaskId}`);
    setTextDraft(saved || "");
  }, [selectedTaskId, currentUser.id]);

  useEffect(() => {
    if (!selectedTaskId) return;
    localStorage.setItem(`task_draft_${currentUser.id}_${selectedTaskId}`, textDraft);
  }, [textDraft, selectedTaskId, currentUser.id]);

  const submit = async () => {
    if (!selectedTask || !canSubmit) return;
    if (!textDraft.trim() && files.length === 0)
      return notify("Add a written response or at least one file before submitting.", "error");

    setSubmitting(true);
    try {
      // Upload files first
      let uploadedFiles = [];
      if (files.length > 0) {
        notify("Uploading files…", "info");
        uploadedFiles = await uploadAll();
        if (uploadedFiles.length < files.filter(f => !f.error).length)
          notify("Some files failed to upload but submission will proceed.", "error");
      }

      // Write submission document (no AI evaluation — admin scores manually)
      const subRef = await addDoc(collection(firestore, "task_submissions"), {
        taskId: selectedTask.id,
        userId: currentUser.id,
        textAnswer: textDraft.trim(),
        files: uploadedFiles,
        scores: { promptScore: 0, taskScore: 0, evaluationScore: 0 },
        totalScore: 0,
        skillLevel: "Pending",
        flags: [],
        feedback: [],
        evaluationSource: "pending",
        submittedAt: serverTimestamp(),
        submittedAtIso: new Date().toISOString(),
      });

      // Placeholder leaderboard entry so admin can see it
      await setDoc(
        doc(firestore, "task_leaderboards", selectedTask.id, "entries", currentUser.id),
        {
          taskId: selectedTask.id,
          userId: currentUser.id,
          candidateName: currentUser.name,
          totalScore: 0,
          skillLevel: "Pending",
          submittedAt: new Date().toISOString(),
        },
        { merge: true }
      );

      localStorage.removeItem(`task_draft_${currentUser.id}_${selectedTask.id}`);
      notify("Task submitted! Awaiting admin review.");
    } catch (err) {
      notify(err.message || "Could not submit task.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="main-layout">
      <Sidebar role="candidate" current="daily_tasks" setView={setView} logout={logout} user={currentUser} />
      <div className="content-area">
        <div className="page-header">
          <div>
            <h2 className="page-title">Daily Tasks</h2>
            <p className="page-sub">Complete tasks and upload your screen recording or supporting files.</p>
          </div>
        </div>

        {activeTasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🗓</div>
            <h3>No active tasks</h3>
            <p>Check back soon for new case-based tasks from your admin.</p>
          </div>
        ) : (
          <div className="tasks-layout">
            {/* Task list */}
            <div className="task-list">
              {activeTasks.map(task => {
                const submitted = mySubsByTask.has(task.id);
                const deadline = task.deadline ? new Date(task.deadline) : null;
                const expired = deadline ? Date.now() > deadline.getTime() : false;
                return (
                  <button key={task.id}
                    className={`task-card ${selectedTaskId === task.id ? "active" : ""}`}
                    onClick={() => setSelectedTaskId(task.id)}>
                    <div className="task-card-top">
                      <div className="task-title">{task.title}</div>
                      <div className={`task-status ${submitted ? "submitted" : expired ? "expired" : "open"}`}>
                        {submitted ? "Submitted" : expired ? "Expired" : "Open"}
                      </div>
                    </div>
                    <div className="task-desc">{task.description}</div>
                    <div className="task-meta">Deadline: {deadline ? deadline.toLocaleString() : "N/A"}</div>
                  </button>
                );
              })}
            </div>

            {/* Task detail */}
            <div className="task-detail">
              {!selectedTask ? (
                <div className="card">
                  <h3 className="card-title">Select a task</h3>
                  <p className="muted">Pick a task from the list to submit your response.</p>
                </div>
              ) : (
                <>
                  <div className="card">
                    <div className="task-detail-head">
                      <div>
                        <h3 className="task-detail-title">{selectedTask.title}</h3>
                        <div className="task-detail-sub">
                          Deadline: {selectedTask.deadline ? new Date(selectedTask.deadline).toLocaleString() : "N/A"}
                        </div>
                      </div>
                      <div className={`task-status ${mySubmission ? "submitted" : isLate ? "expired" : "open"}`}>
                        {mySubmission ? "Submitted" : isLate ? "Expired" : "Open"}
                      </div>
                    </div>
                    <div className="task-full-desc">{selectedTask.description}</div>
                  </div>

                  {/* Submission area */}
                  <div className="card">
                    <h3 className="card-title">
                      {mySubmission ? "Your Submission" : "Submit Your Response"}
                    </h3>

                    {mySubmission ? (
                      /* ── Already submitted ── */
                      <div>
                        <div className="score-chips-row" style={{ marginBottom: 14 }}>
                          {mySubmission.evaluationSource === "pending" ? (
                            <span className="pending-chip">⏳ Awaiting admin review</span>
                          ) : (
                            <>
                              <span>Task: {mySubmission.scores.taskScore}/20</span>
                              <span>Eval: {mySubmission.scores.evaluationScore}/10</span>
                              <span className="total-chip">Total: {mySubmission.totalScore}/40</span>
                              <span className={`skill-badge skill-${mySubmission.skillLevel.toLowerCase()}`}>
                                {mySubmission.skillLevel}
                              </span>
                            </>
                          )}
                        </div>

                        {mySubmission.feedback?.length > 0 && (
                          <div className="feedback-list" style={{ marginBottom: 16 }}>
                            {mySubmission.feedback.map((item, i) => (
                              <div key={i} className="feedback-item">{item}</div>
                            ))}
                          </div>
                        )}

                        {mySubmission.textAnswer && (
                          <div className="answer-item">
                            <div className="answer-label">Written Response</div>
                            <div className="answer-text">{mySubmission.textAnswer}</div>
                          </div>
                        )}

                        {mySubmission.files?.length > 0 && (
                          <div style={{ marginTop: 16 }}>
                            <div className="answer-label" style={{ marginBottom: 8 }}>Uploaded Files</div>
                            <div className="file-list">
                              {mySubmission.files.map((f, i) => (
                                <div key={i} className="file-item file-done">
                                  <div className="file-icon">
                                    {f.type === "video" ? "🎥" : f.type === "image" ? "🖼" : "📄"}
                                  </div>
                                  <div className="file-info">
                                    <div className="file-name">{f.name}</div>
                                    <div className="file-meta">{formatBytes(f.size)}</div>
                                  </div>
                                  <a href={f.url} target="_blank" rel="noreferrer" className="file-view-btn">
                                    View
                                  </a>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      /* ── Not yet submitted ── */
                      <div>
                        {isLate ? (
                          <div className="flag-alert">The deadline has passed. Submissions are no longer accepted.</div>
                        ) : (
                          <>
                            <div className="form-group" style={{ marginBottom: 16 }}>
                              <label>Written Response (optional if uploading a recording)</label>
                              <textarea
                                className="form-textarea task-answer"
                                rows={6}
                                value={textDraft}
                                onChange={e => setTextDraft(e.target.value)}
                                placeholder="Describe your approach, tools used, checks performed, findings, and recommendations…"
                              />
                            </div>

                            <div className="upload-section">
                              <div className="upload-section-header">
                                <span className="upload-section-title">📹 Screen Recording &amp; Files</span>
                                <span className="upload-section-hint">Max 200 MB per file • {files.length} file{files.length !== 1 ? "s" : ""} added</span>
                              </div>
                              <FileDropZone onFiles={addFiles} disabled={submitting || uploading} />
                              <FileList files={files} onRemove={removeFile} disabled={submitting || uploading} />
                            </div>

                            <div className="task-actions">
                              <div className="upload-tips">
                                <strong>Tip:</strong> Record your screen while solving the task using OBS, Loom, or QuickTime, then upload the video file directly.
                              </div>
                              <button
                                className="btn-submit"
                                onClick={submit}
                                disabled={!canSubmit || submitting || uploading}
                              >
                                {submitting || uploading ? "Uploading & Submitting…" : "Submit Task ✓"}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Leaderboards (Candidate) ──────────────────────────────────────────────
function LeaderboardsPage({ db, currentUser, setView, logout }) {
  const [selectedTaskId, setSelectedTaskId] = useState("");

  const submittedTaskIds = new Set(
    db.taskSubmissions.filter(s => s.userId === currentUser.id).map(s => s.taskId)
  );
  const visibleTasks = db.tasks
    .filter(t => t.active || submittedTaskIds.has(t.id))
    .sort((a, b) => (b.deadline || "").localeCompare(a.deadline || ""));

  useEffect(() => {
    if (!selectedTaskId && visibleTasks.length) setSelectedTaskId(visibleTasks[0].id);
  }, [visibleTasks.length]);

  return (
    <div className="main-layout">
      <Sidebar role="candidate" current="leaderboards" setView={setView} logout={logout} user={currentUser} />
      <div className="content-area">
        <div className="page-header">
          <div><h2 className="page-title">Task Leaderboards</h2>
            <p className="page-sub">Admin-scored rankings update in real time.</p></div>
        </div>
        {visibleTasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🏆</div>
            <h3>No tasks yet</h3>
            <p>Leaderboards appear once tasks are active and submissions are scored.</p>
          </div>
        ) : (
          <div className="tasks-layout">
            <div className="task-list">
              {visibleTasks.map(task => (
                <button key={task.id}
                  className={`task-card ${selectedTaskId === task.id ? "active" : ""}`}
                  onClick={() => setSelectedTaskId(task.id)}>
                  <div className="task-card-top">
                    <div className="task-title">{task.title}</div>
                    <div className={`task-status ${task.active ? "open" : "expired"}`}>
                      {task.active ? "Live" : "Closed"}
                    </div>
                  </div>
                  <div className="task-meta">
                    {task.deadline ? new Date(task.deadline).toLocaleString() : "N/A"}
                  </div>
                </button>
              ))}
            </div>
            <div className="task-detail">
              {selectedTaskId
                ? <TaskLeaderboard taskId={selectedTaskId} currentUser={currentUser} db={db} />
                : <div className="card"><h3 className="card-title">Select a task</h3></div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Task Leaderboard component ────────────────────────────────────────────
function TaskLeaderboard({ taskId, currentUser, db }) {
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    if (!firestore || !taskId) return;
    const q = query(
      collection(firestore, "task_leaderboards", taskId, "entries"),
      orderBy("totalScore", "desc")
    );
    return onSnapshot(q,
      snap => setEntries(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setEntries([])
    );
  }, [taskId]);

  const ranked = entries
    .map(e => ({
      userId: e.userId || e.id,
      candidateName: e.candidateName || "Candidate",
      totalScore: Number(e.totalScore || 0),
      skillLevel: e.skillLevel || "Pending",
    }))
    .sort((a, b) => b.totalScore - a.totalScore);

  const topN = ranked.length ? Math.max(1, Math.ceil(ranked.length * 0.1)) : 0;
  const myRank = ranked.findIndex(r => r.userId === currentUser.id) + 1;

  const exportCSV = () => {
    if (!ranked.length) return;
    const task = db?.tasks?.find(t => t.id === taskId);
    const headers = ["Rank", "Candidate Name", "Skill Level", "Score"];
    const rows = ranked.map((r, i) => [
      `#${i + 1}`,
      `"${r.candidateName.replace(/"/g, '""')}"`,
      r.skillLevel,
      `${r.totalScore}/40`
    ]);

    const csvContent = [
      `Leaderboard Report: ${task?.title || taskId}`,
      `Exported on: ${new Date().toLocaleString()}`,
      "",
      headers.join(","),
      ...rows.map(e => e.join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Leaderboard_${(task?.title || taskId).replace(/\s+/g, '_')}.csv`);
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card">
      <div className="card-header-flex">
        <h3 className="card-title">Leaderboard</h3>
        {ranked.length > 0 && currentUser.role === "admin" && (
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="btn-outline sm" onClick={exportCSV}>📊 Excel</button>
            <button className="btn-outline sm" onClick={() => window.print()}>📄 PDF</button>
          </div>
        )}
      </div>
      <p className="muted" style={{ marginBottom: 14 }}>Admin-scored • Top 10% highlighted</p>
      {!ranked.length ? (
        <div className="empty-chart">No scored submissions yet</div>
      ) : (
        <div className="task-leaderboard">
          <div className="task-lb-head">
            <div>Rank</div><div>Candidate</div><div>Skill</div><div style={{ textAlign:"right" }}>Score</div>
          </div>
          {ranked.map((r, i) => (
            <div key={r.userId}
              className={`task-lb-row ${i < topN ? "top-ten" : ""} ${r.userId === currentUser.id ? "me" : ""}`}>
              <div className="task-lb-rank">{i < 3 ? ["🥇","🥈","🥉"][i] : `#${i+1}`}</div>
              <div className="task-lb-name">{r.candidateName}{r.userId === currentUser.id ? " (You)" : ""}</div>
              <div className={`skill-badge skill-${r.skillLevel.toLowerCase()}`}>{r.skillLevel}</div>
              <div className="task-lb-score">{r.totalScore}/40</div>
            </div>
          ))}
          {myRank > 0 && <p className="muted" style={{ marginTop: 12 }}>Your rank: #{myRank} of {ranked.length}</p>}
        </div>
      )}
    </div>
  );
}

// ─── Admin Dashboard ────────────────────────────────────────────────────────
function AdminDashboard({ db, currentUser, logout, notify }) {
  const [tab, setTab] = useState("overview");
  const [taskForm, setTaskForm] = useState({ title: "", description: "", deadline: "" });
  const [scoringModal, setScoringModal] = useState(null);   // task_submission doc
  const [detailModal, setDetailModal] = useState(null);     // task_submission doc
  const [taskViewer, setTaskViewer] = useState(null);       // task doc
  const [lbTaskId, setLbTaskId] = useState("");

  // Navigation logic for 100+ candidates
  const currentSubsList = tab === "submissions" ? allSubs : allSubs.filter(s => s.evaluationSource === "pending");
  
  const navigateSub = (direction) => {
    const current = scoringModal || detailModal;
    if (!current) return;
    const idx = currentSubsList.findIndex(s => s.id === current.id);
    const nextIdx = idx + direction;
    if (nextIdx >= 0 && nextIdx < currentSubsList.length) {
      const nextSub = currentSubsList[nextIdx];
      if (scoringModal) setScoringModal(nextSub);
      if (detailModal) setDetailModal(nextSub);
    } else {
      notify("No more submissions in this direction.");
    }
  };

  const getNavMeta = (currentSub) => {
    if (!currentSub) return "";
    const idx = currentSubsList.findIndex(s => s.id === currentSub.id);
    return `${idx + 1} of ${currentSubsList.length}`;
  };

  const candidates = db.users.filter(u => u.role === "candidate");
  const allSubs = db.taskSubmissions;
  const scoredSubs = allSubs.filter(s => s.evaluationSource !== "pending");
  const avgScore = scoredSubs.length
    ? Math.round(scoredSubs.reduce((a, s) => a + s.totalScore, 0) / scoredSubs.length) : 0;

  const skillDist = { Beginner: 0, Intermediate: 0, Advanced: 0, Pending: 0 };
  allSubs.forEach(s => { if (s.skillLevel in skillDist) skillDist[s.skillLevel]++; });

  const saveScores = async (submission, scores, feedback) => {
    const total = scores.taskScore + scores.evaluationScore;
    const skillLevel = getSkillLevel(total);
    const user = db.users.find(u => u.id === submission.userId);

    try {
      await updateDoc(doc(firestore, "task_submissions", submission.id), {
        scores: { promptScore: 0, ...scores },
        totalScore: total,
        skillLevel,
        feedback: feedback ? [feedback] : [],
        evaluationSource: "admin",
        scoredAt: serverTimestamp(),
      });

      // Update leaderboard entry
      await setDoc(
        doc(firestore, "task_leaderboards", submission.taskId, "entries", submission.userId),
        {
          taskId: submission.taskId,
          userId: submission.userId,
          candidateName: user?.name || "Candidate",
          totalScore: total,
          skillLevel,
          submittedAt: submission.submittedAt,
          scoredAt: new Date().toISOString(),
        },
        { merge: true }
      );

      notify("Scores saved and leaderboard updated.");
      setScoringModal(null);
    } catch (err) {
      notify(err.message || "Could not save scores.", "error");
    }
  };

  return (
    <div className="main-layout">
      <Sidebar role="admin" current={tab} setView={setTab} logout={logout} user={currentUser} />
      <div className="content-area">

        {scoringModal && (
          <AdminScoringModal
            submission={scoringModal}
            user={db.users.find(u => u.id === scoringModal.userId)}
            task={db.tasks.find(t => t.id === scoringModal.taskId)}
            onSave={saveScores}
            onClose={() => setScoringModal(null)}
            onNavigate={navigateSub}
            navMeta={getNavMeta(scoringModal)}
          />
        )}

        {detailModal && (
          <SubmissionDetailModal
            submission={detailModal}
            user={db.users.find(u => u.id === detailModal.userId)}
            task={db.tasks.find(t => t.id === detailModal.taskId)}
            onScore={() => { setScoringModal(detailModal); setDetailModal(null); }}
            onClose={() => setDetailModal(null)}
            onNavigate={navigateSub}
            navMeta={getNavMeta(detailModal)}
          />
        )}

        {taskViewer && (
          <TaskSubmissionsViewer
            task={taskViewer}
            db={db}
            onOpenSubmission={s => { setDetailModal(s); setTaskViewer(null); }}
            onClose={() => setTaskViewer(null)}
          />
        )}

        {/* ── OVERVIEW ── */}
        {tab === "overview" && (
          <>
            <div className="page-header">
              <div><h2 className="page-title">Admin Dashboard</h2><p className="page-sub">Daily Task Management</p></div>
              <div className="header-badge">Admin</div>
            </div>
            <div className="stats-grid">
              {[
                { label: "Candidates", value: candidates.length, icon: "👥", color: "blue" },
                { label: "Total Submissions", value: allSubs.length, icon: "📋", color: "purple" },
                { label: "Pending Review", value: allSubs.filter(s => s.evaluationSource === "pending").length, icon: "⏳", color: "yellow" },
                { label: "Avg Score (scored)", value: scoredSubs.length ? avgScore + "/40" : "—", icon: "📊", color: "accent" },
              ].map(s => (
                <div key={s.label} className={`stat-card stat-${s.color}`}>
                  <div className="stat-icon">{s.icon}</div>
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value">{s.value}</div>
                </div>
              ))}
            </div>
            <div className="two-col">
              <div className="card">
                <h3 className="card-title">Skill Distribution (scored only)</h3>
                <PieChart data={[
                  { label: "Beginner", value: skillDist.Beginner, color: "#b42318" },
                  { label: "Intermediate", value: skillDist.Intermediate, color: "#a15c07" },
                  { label: "Advanced", value: skillDist.Advanced, color: "#1f7a4d" },
                ]} />
              </div>
              <div className="card">
                <h3 className="card-title">Pending Reviews</h3>
                <div className="pending-list">
                  {allSubs.filter(s => s.evaluationSource === "pending").slice(0, 8).map(s => {
                    const user = db.users.find(u => u.id === s.userId);
                    const task = db.tasks.find(t => t.id === s.taskId);
                    return (
                      <div key={s.id} className="pending-row" onClick={() => setDetailModal(s)}>
                        <div className="pending-info">
                          <div className="pending-name">{user?.name || "Unknown"}</div>
                          <div className="pending-task">{task?.title || "Task"}</div>
                        </div>
                        <button className="btn-score" onClick={e => { e.stopPropagation(); setScoringModal(s); }}>
                          Score
                        </button>
                      </div>
                    );
                  })}
                  {allSubs.filter(s => s.evaluationSource === "pending").length === 0 && (
                    <div className="empty-chart">All submissions reviewed ✓</div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── SUBMISSIONS ── */}
        {tab === "submissions" && (
          <>
            <div className="page-header">
              <div><h2 className="page-title">All Submissions</h2>
                <p className="page-sub">{allSubs.length} total • {allSubs.filter(s => s.evaluationSource === "pending").length} pending review</p>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button className="btn-outline sm" onClick={exportAllScoresCSV}>📊 Export All Excel</button>
                <button className="btn-outline sm" onClick={() => window.print()}>📄 Print Report</button>
              </div>
            </div>
            <div className="candidate-list">
              {allSubs.map((s, i) => {
                const user = db.users.find(u => u.id === s.userId);
                const task = db.tasks.find(t => t.id === s.taskId);
                const pending = s.evaluationSource === "pending";
                return (
                  <div key={s.id} className="candidate-row" onClick={() => setDetailModal(s)}>
                    <div className="rank-num">#{i+1}</div>
                    <div className="candidate-info">
                      <div className="candidate-name">{user?.name || "Unknown"}</div>
                      <div className="candidate-meta">{task?.title || "Task"} • {new Date(s.submittedAt).toLocaleDateString()}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {s.files?.map((f, fi) => (
                        <span key={fi} className="file-type-chip">
                          {f.type === "video" ? "🎥" : f.type === "image" ? "🖼" : "📄"} {f.type}
                        </span>
                      ))}
                    </div>
                    {pending
                      ? <span className="pending-chip">⏳ Pending</span>
                      : <div className={`skill-badge skill-${s.skillLevel.toLowerCase()}`}>{s.skillLevel}</div>}
                    <div className="total-score">
                      {pending ? <span style={{ color: "var(--muted)", fontSize: 14 }}>—</span> : <>{s.totalScore}<span>/40</span></>}
                    </div>
                    <button className="btn-score"
                      onClick={e => { e.stopPropagation(); setScoringModal(s); }}>
                      {pending ? "Score" : "Re-score"}
                    </button>
                  </div>
                );
              })}
              {!allSubs.length && <div className="empty-chart">No submissions yet</div>}
            </div>
          </>
        )}

        {/* ── LEADERBOARDS ── */}
        {tab === "leaderboards" && (
          <>
            <div className="page-header">
              <div><h2 className="page-title">Task Leaderboards</h2><p className="page-sub">Admin-scored rankings</p></div>
            </div>
            {db.tasks.length > 0 && (
              <div className="card" style={{ marginBottom: 20 }}>
                <select className="filter-select"
                  value={lbTaskId}
                  onChange={e => setLbTaskId(e.target.value)}>
                  <option value="">Select a task…</option>
                  {db.tasks.slice().sort((a,b) => (b.deadline||"").localeCompare(a.deadline||"")).map(t => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
              </div>
            )}
            {lbTaskId
              ? <TaskLeaderboard taskId={lbTaskId} currentUser={currentUser} db={db} />
              : <div className="empty-state"><div className="empty-icon">🏆</div><h3>Pick a task above</h3></div>}
          </>
        )}

        {/* ── TASKS MANAGEMENT ── */}
        {tab === "tasks" && (
          <>
            <div className="page-header">
              <div><h2 className="page-title">Daily Tasks</h2><p className="page-sub">Create and manage tasks</p></div>
            </div>

            {/* Create form */}
            <div className="card">
              <h3 className="card-title">Create New Task</h3>
              <div className="task-create-grid">
                <div>
                  <div className="form-group">
                    <label>Title</label>
                    <input className="form-input" value={taskForm.title}
                      onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
                      placeholder="e.g., GST Reconciliation: Sales Register vs GSTR-1" />
                  </div>
                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label>Description / Task Brief</label>
                    <textarea className="form-textarea" rows={6} value={taskForm.description}
                      onChange={e => setTaskForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Write the case scenario. Include files available, checks required, and expected deliverable…" />
                  </div>
                </div>
                <div>
                  <div className="form-group">
                    <label>Submission Deadline</label>
                    <input className="form-input" type="datetime-local" value={taskForm.deadline}
                      onChange={e => setTaskForm(f => ({ ...f, deadline: e.target.value }))} />
                  </div>
                  <div className="auth-note" style={{ marginTop: 12, marginBottom: 16 }}>
                    Candidates can submit a written response + screen recording (up to 200 MB). Admin reviews and scores manually.
                  </div>
                  <button className="btn-primary" onClick={async () => {
                    if (!taskForm.title.trim() || !taskForm.description.trim() || !taskForm.deadline)
                      return notify("Title, description and deadline are required.", "error");
                    try {
                      await addDoc(collection(firestore, "tasks"), {
                        title: taskForm.title.trim(),
                        description: taskForm.description.trim(),
                        deadline: new Date(taskForm.deadline),
                        active: true,
                        createdBy: currentUser.id,
                        createdAt: serverTimestamp(),
                        submissionCount: 0,
                      });
                      setTaskForm({ title: "", description: "", deadline: "" });
                      notify("Task created.");
                    } catch (err) {
                      notify(err.message || "Could not create task.", "error");
                    }
                  }}>Create Task</button>
                </div>
              </div>
            </div>

            {/* Task table */}
            <div className="card">
              <h3 className="card-title">Manage Tasks</h3>
              {!db.tasks.length ? <div className="empty-chart">No tasks yet</div> : (
                <div className="task-admin-table">
                  <div className="task-admin-head">
                    <div>Title</div><div>Deadline</div><div>Status</div>
                    <div style={{ textAlign:"right" }}>Submissions</div>
                    <div style={{ textAlign:"right" }}>Actions</div>
                  </div>
                  {db.tasks.slice().sort((a,b) => (b.deadline||"").localeCompare(a.deadline||"")).map(task => {
                    const deadline = task.deadline ? new Date(task.deadline) : null;
                    const expired = deadline ? Date.now() > deadline.getTime() : false;
                    const subCount = db.taskSubmissions.filter(s => s.taskId === task.id).length;
                    return (
                      <div key={task.id} className="task-admin-row">
                        <div className="task-admin-title">{task.title}</div>
                        <div className="muted">{deadline ? deadline.toLocaleString() : "N/A"}</div>
                        <div className={`task-status-pill ${task.active ? (expired ? "expired" : "active") : "inactive"}`}>
                          {task.active ? (expired ? "Expired" : "Active") : "Inactive"}
                        </div>
                        <div style={{ textAlign:"right", fontFamily:"'IBM Plex Mono',monospace" }}>{subCount}</div>
                        <div style={{ textAlign:"right", display:"flex", gap: 8, justifyContent:"flex-end", flexWrap:"wrap" }}>
                          <button className="btn-outline sm" onClick={() => setTaskViewer(task)}>View</button>
                          <button className="btn-outline sm" onClick={async () => {
                            try {
                              await updateDoc(doc(firestore, "tasks", task.id), { active: !task.active });
                            } catch (err) { notify(err.message, "error"); }
                          }}>{task.active ? "Deactivate" : "Activate"}</button>
                          <button className="btn-danger sm" onClick={async () => {
                            if (!window.confirm(`Delete "${task.title}"? All submissions and leaderboard entries will be removed.`)) return;
                            try {
                              let batch = writeBatch(firestore);
                              let n = 0;
                              const flush = async () => { if (n) { await batch.commit(); batch = writeBatch(firestore); n = 0; } };
                              const del = ref => { batch.delete(ref); n++; };
                              const subsSnap = await getDocs(query(collection(firestore,"task_submissions"), where("taskId","==",task.id)));
                              for (const d of subsSnap.docs) { del(d.ref); if (n >= 450) await flush(); }
                              const lbSnap = await getDocs(collection(firestore,"task_leaderboards",task.id,"entries"));
                              for (const d of lbSnap.docs) { del(d.ref); if (n >= 450) await flush(); }
                              del(doc(firestore,"task_leaderboards",task.id));
                              del(doc(firestore,"tasks",task.id));
                              await flush();
                              notify("Task deleted.");
                            } catch (err) { notify(err.message, "error"); }
                          }}>Delete</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Admin Scoring Modal ────────────────────────────────────────────────────
function AdminScoringModal({ submission, user, task, onSave, onClose, onNavigate, navMeta }) {
  const [scores, setScores] = useState({
    taskScore: submission?.scores?.taskScore ?? 0,
    evaluationScore: submission?.scores?.evaluationScore ?? 0,
  });
  const [feedback, setFeedback] = useState(submission?.feedback?.[0] || "");
  const [saving, setSaving] = useState(false);

  const total = (Number(scores.taskScore) || 0) + (Number(scores.evaluationScore) || 0);
  const skillLevel = getSkillLevel(total);
  const set = k => e => setScores(s => ({ ...s, [k]: clampScore(e.target.value, k === "taskScore" ? 20 : 10) }));

  const handleSave = async () => {
    setSaving(true);
    await onSave(submission, scores, feedback);
    setSaving(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>Score Submission</h3>
            <div className="modal-sub">{user?.name} • {task?.title}</div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body scrollable">
          <div className="nav-row">
            <button className="btn-outline sm" onClick={() => onNavigate(-1)}>← Previous</button>
            <span className="nav-meta">{navMeta}</span>
            <button className="btn-outline sm" onClick={() => onNavigate(1)}>Next →</button>
          </div>

          {/* Files integrated preview */}
          {submission.files?.length > 0 && (
            <div>
              <div className="answer-label" style={{ marginBottom: 12 }}>Submission Preview</div>
              <FilePreview files={submission.files} />
            </div>
          )}

          {/* Text answer */}
          {submission.textAnswer && (
            <div className="answer-item">
              <div className="answer-label">Written Response</div>
              <div className="answer-text">{submission.textAnswer}</div>
            </div>
          )}

          {/* Scoring */}
          {[
            { label: "Task Completion Score", key: "taskScore", max: 20, hint: "Quality, correctness, depth of work" },
            { label: "Evaluation / Critical Thinking", key: "evaluationScore", max: 10, hint: "Self-awareness, error identification, improvements" },
          ].map(f => (
            <div key={f.key} className="score-input-row">
              <label>{f.label} <span className="max-hint">/ {f.max}</span></label>
              <div className="score-hint">{f.hint}</div>
              <div className="score-input-wrap">
                <input type="range" min="0" max={f.max} value={scores[f.key]} onChange={set(f.key)} className="score-range" />
                <input type="number" min="0" max={f.max} value={scores[f.key]} onChange={set(f.key)} className="score-num" />
              </div>
            </div>
          ))}

          <div className="total-preview">
            <span>Total Score</span>
            <span className="total-num">{total} / 40</span>
            <span className={`skill-badge skill-${skillLevel.toLowerCase()}`}>{skillLevel}</span>
          </div>

          <div className="form-group">
            <label>Feedback for Candidate (optional)</label>
            <textarea className="form-textarea" rows={4} value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="Describe what was done well and what could be improved…" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save & Update Leaderboard"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Submission Detail Modal ────────────────────────────────────────────────
function SubmissionDetailModal({ submission, user, task, onScore, onClose, onNavigate, navMeta }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{user?.name}'s Submission</h3>
            <div className="modal-sub">{task?.title} • {submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : ""}</div>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <button className="btn-primary sm" onClick={onScore}>
              {submission.evaluationSource === "pending" ? "Score" : "Re-score"}
            </button>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body scrollable">
          <div className="nav-row">
            <button className="btn-outline sm" onClick={() => onNavigate(-1)}>← Previous</button>
            <span className="nav-meta">{navMeta}</span>
            <button className="btn-outline sm" onClick={() => onNavigate(1)}>Next →</button>
          </div>

          <div className="score-chips-row">
            {submission.evaluationSource === "pending"
              ? <span className="pending-chip">⏳ Awaiting review</span>
              : <>
                  <span>Task: {submission.scores.taskScore}/20</span>
                  <span>Eval: {submission.scores.evaluationScore}/10</span>
                  <span className="total-chip">Total: {submission.totalScore}/40</span>
                  <span className={`skill-badge skill-${submission.skillLevel.toLowerCase()}`}>{submission.skillLevel}</span>
                  <span>Source: admin</span>
                </>}
          </div>

          {submission.feedback?.length > 0 && (
            <div className="answer-item">
              <div className="answer-label">Admin Feedback</div>
              <div className="feedback-list">
                {submission.feedback.map((item, i) => <div key={i} className="feedback-item">{item}</div>)}
              </div>
            </div>
          )}

          {submission.files?.length > 0 && (
            <div>
              <div className="answer-label" style={{ marginBottom: 12 }}>Submission Preview</div>
              <FilePreview files={submission.files} />
            </div>
          )}

          {submission.textAnswer && (
            <div className="answer-item">
              <div className="answer-label">Written Response</div>
              <div className="answer-text">{submission.textAnswer}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Task Submissions Viewer (admin) ───────────────────────────────────────
function TaskSubmissionsViewer({ task, db, onOpenSubmission, onClose }) {
  const subs = db.taskSubmissions.filter(s => s.taskId === task.id)
    .slice().sort((a, b) => b.totalScore - a.totalScore);
  const topN = subs.length ? Math.max(1, Math.ceil(subs.length * 0.1)) : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{task.title}</h3>
            <div className="modal-sub">{subs.length} submissions</div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body scrollable">
          {!subs.length ? <div className="empty-chart">No submissions yet</div> : (
            <div className="task-admin-table">
              <div className="task-admin-head" style={{ gridTemplateColumns:"0.5fr 1.6fr 0.8fr 0.5fr 0.5fr" }}>
                <div>Rank</div><div>Candidate</div><div>Skill</div>
                <div style={{ textAlign:"right" }}>Score</div><div style={{ textAlign:"right" }}>Open</div>
              </div>
              {subs.map((s, i) => {
                const user = db.users.find(u => u.id === s.userId);
                return (
                  <div key={s.id} className="task-admin-row"
                    style={{
                      gridTemplateColumns:"0.5fr 1.6fr 0.8fr 0.5fr 0.5fr", cursor:"pointer",
                      borderColor: i < topN ? "rgba(34,197,94,0.25)" : undefined,
                      background: i < topN ? "rgba(236,253,245,0.75)" : undefined,
                    }}
                    onClick={() => onOpenSubmission(s)}>
                    <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontWeight:900 }}>
                      {i < 3 ? ["🥇","🥈","🥉"][i] : `#${i+1}`}
                    </div>
                    <div className="task-admin-title">{user?.name || "Unknown"}</div>
                    <div className={`skill-badge skill-${s.skillLevel.toLowerCase()}`}>{s.skillLevel}</div>
                    <div style={{ textAlign:"right", fontFamily:"'IBM Plex Mono',monospace", fontWeight:900 }}>
                      {s.evaluationSource === "pending" ? "—" : `${s.totalScore}/40`}
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <button className="btn-primary sm" onClick={e => { e.stopPropagation(); onOpenSubmission(s); }}>Open</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ───────────────────────────────────────────────────────────────
function Sidebar({ role, current, setView, logout, user }) {
  const candidateLinks = [
    { id: "daily_tasks", label: "Daily Tasks", icon: "🗓" },
    { id: "leaderboards", label: "Leaderboards", icon: "🏆" },
  ];
  const adminLinks = [
    { id: "overview", label: "Overview", icon: "⊞" },
    { id: "submissions", label: "Submissions", icon: "📋" },
    { id: "leaderboards", label: "Leaderboards", icon: "🏆" },
    { id: "tasks", label: "Manage Tasks", icon: "🗓" },
  ];
  const links = role === "admin" ? adminLinks : candidateLinks;

  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon sm">CA</div>
        <div><div className="sidebar-brand">Task Platform</div><div className="sidebar-sub">Daily CA Tasks</div></div>
      </div>
      <nav className="sidebar-nav">
        {links.map(l => (
          <button key={l.id} className={`nav-item ${current === l.id ? "active" : ""}`} onClick={() => setView(l.id)}>
            <span className="nav-icon">{l.icon}</span> {l.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="user-avatar">{user?.name?.[0]}</div>
          <div><div className="user-name">{user?.name}</div><div className="user-role">{user?.role}</div></div>
        </div>
        <button className="logout-btn" onClick={logout} title="Sign out">↩</button>
      </div>
    </div>
  );
}

// ─── Charts ────────────────────────────────────────────────────────────────
function PieChart({ data }) {
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  let cum = 0;
  const slices = data.map(d => {
    const pct = d.value / total; const start = cum; cum += pct;
    return { ...d, start, pct };
  });
  const slice = (start, pct) => {
    const r = 80, cx = 100, cy = 100;
    const a1 = (start * 360 - 90) * Math.PI / 180;
    const a2 = ((start + pct) * 360 - 90) * Math.PI / 180;
    return `M${cx},${cy} L${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} A${r},${r} 0 ${pct > 0.5 ? 1 : 0},1 ${cx + r * Math.cos(a2)},${cy + r * Math.sin(a2)} Z`;
  };
  return (
    <div className="pie-chart-wrap">
      <svg viewBox="0 0 200 200" className="pie-svg">
        {slices.map((s, i) => s.pct > 0 && <path key={i} d={slice(s.start, s.pct)} fill={s.color} opacity={0.85} />)}
        <circle cx="100" cy="100" r="50" fill="var(--card)" />
        <text x="100" y="105" textAnchor="middle" fontSize="20" fill="var(--text)" fontWeight="700">{data.reduce((a,d)=>a+d.value,0)}</text>
      </svg>
      <div className="pie-legend">
        {data.map(d => (
          <div key={d.label} className="legend-item">
            <div className="legend-dot" style={{ background: d.color }} />
            <span>{d.label}</span><span className="legend-val">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── CSS ───────────────────────────────────────────────────────────────────
function CSS() {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f5f7fb; --surface: #ffffff; --card: #ffffff; --subtle: #f8fafc;
      --border: #d9e1ec; --border-strong: #b7c3d4; --text: #142033; --muted: #66758a;
      --accent: #0f172a; --accent2: #1e293b; --green: #059669; --red: #dc2626;
      --yellow: #a15c07; --blue: #245b91; --shadow: 0 12px 30px rgba(20,32,51,0.08);
    }
    body { background: var(--bg); color: var(--text); font-family: 'Source Sans 3', sans-serif; font-size: 16px; }
    .app-root { min-height: 100vh; }

    .toast { position: fixed; top: 20px; right: 20px; z-index: 9999; padding: 14px 20px; border-radius: 12px; display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; box-shadow: 0 8px 32px rgba(0,0,0,0.3); animation: slideIn .3s ease; max-width: 360px; }
    .toast-success { background: #166534; color: #bbf7d0; }
    .toast-error { background: #7f1d1d; color: #fecaca; }
    .toast-info { background: #1e3a8a; color: #bfdbfe; }
    @keyframes slideIn { from { transform: translateX(120px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    /* Auth */
    .auth-page { min-height: 100vh; display: flex; align-items: stretch; }
    .auth-card { width: 460px; min-width: 340px; padding: 48px 40px; display: flex; flex-direction: column; gap: 18px; background: var(--surface); border-right: 1px solid var(--border); justify-content: center; }
    .auth-card.wide { width: 540px; }
    .auth-logo { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
    .logo-icon { width: 48px; height: 48px; border-radius: 10px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; color: #fff; }
    .logo-icon.sm { width: 36px; height: 36px; font-size: 11px; flex-shrink: 0; }
    .auth-title { font-size: 24px; font-weight: 800; color: var(--text); }
    .auth-sub { font-size: 13px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
    .auth-hero { flex: 1; padding: 60px; display: flex; flex-direction: column; justify-content: center; background: #eef3f8; border-left: 1px solid var(--border); }
    .hero-heading { font-size: 40px; font-weight: 800; line-height: 1.15; margin-bottom: 16px; letter-spacing: -0.03em; }
    .hero-body { font-size: 17px; line-height: 1.7; color: var(--muted); margin-bottom: 32px; max-width: 480px; }
    .hero-tags { display: flex; flex-wrap: wrap; gap: 8px; }
    .hero-tag { padding: 6px 14px; border-radius: 999px; background: #fff; border: 1px solid var(--border); font-size: 13px; color: var(--accent); font-weight: 700; }

    /* Forms */
    .form-group { display: flex; flex-direction: column; gap: 8px; }
    .form-group label { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .form-input { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; color: var(--text); font-size: 16px; font-family: 'Source Sans 3', sans-serif; outline: none; transition: border .2s; }
    .form-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(23,59,99,0.1); }
    .form-textarea { background: #fff; border: 1px solid var(--border-strong); border-radius: 10px; padding: 16px; color: var(--text); font-size: 16px; font-family: 'Source Sans 3', sans-serif; resize: vertical; outline: none; transition: border .2s; line-height: 1.65; width: 100%; }
    .form-textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(23,59,99,0.1); }
    .form-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }

    /* Buttons */
    .btn-primary { padding: 12px 20px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-weight: 800; font-size: 15px; cursor: pointer; font-family: 'Source Sans 3', sans-serif; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all .2s; }
    .btn-primary:hover { background: #000; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    .btn-primary.sm { padding: 8px 14px; font-size: 13px; }
    .btn-outline { padding: 11px 20px; border: 1px solid var(--border-strong); background: #fff; color: var(--accent); border-radius: 8px; font-weight: 800; font-size: 15px; cursor: pointer; font-family: 'Source Sans 3', sans-serif; transition: background .2s; }
    .btn-outline:hover { background: #eef3f8; }
    .btn-outline.sm { padding: 7px 12px; font-size: 13px; }
    .btn-submit { padding: 13px 28px; background: var(--green); color: #fff; border: none; border-radius: 8px; font-weight: 800; font-size: 15px; cursor: pointer; font-family: 'Source Sans 3', sans-serif; }
    .btn-submit:disabled { opacity: .6; cursor: not-allowed; }
    .btn-danger { padding: 7px 12px; border: 1px solid rgba(180,35,24,0.35); background: #fff; color: var(--red); border-radius: 8px; font-weight: 800; font-size: 13px; cursor: pointer; font-family: 'Source Sans 3', sans-serif; }
    .btn-score { padding: 6px 14px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-size: 13px; font-weight: 800; cursor: pointer; font-family: 'Source Sans 3', sans-serif; white-space: nowrap; }

    .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
    .spinner.dark { border-color: rgba(23,59,99,.2); border-top-color: var(--accent); margin: 0 auto; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .auth-link { text-align: center; font-size: 13px; color: var(--muted); }
    .auth-link button { background: none; border: none; color: var(--accent); cursor: pointer; font-family: 'Source Sans 3', sans-serif; font-weight: 800; }
    .back-btn { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 14px; font-weight: 800; align-self: flex-start; font-family: 'Source Sans 3', sans-serif; }
    .auth-note, .setup-box { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 14px; color: var(--muted); font-size: 13px; line-height: 1.7; }
    .setup-box { display: flex; flex-direction: column; gap: 6px; }
    .setup-box code { color: var(--accent); font-family: 'IBM Plex Mono', monospace; font-size: 12px; }

    /* Layout */
    .main-layout { display: flex; min-height: 100vh; }
    .sidebar { width: 250px; min-height: 100vh; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 22px 0; position: sticky; top: 0; height: 100vh; }
    .sidebar-logo { display: flex; align-items: center; gap: 12px; padding: 0 20px 24px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
    .sidebar-brand { font-size: 17px; font-weight: 800; color: var(--text); }
    .sidebar-sub { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
    .sidebar-nav { flex: 1; padding: 0 12px; display: flex; flex-direction: column; gap: 4px; }
    .nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 8px; border: none; background: transparent; color: var(--muted); font-family: 'Source Sans 3', sans-serif; font-size: 15px; font-weight: 700; cursor: pointer; text-align: left; transition: all .2s; }
    .nav-item:hover { background: #eef3f8; color: var(--text); }
    .nav-item.active { background: #e8f0f8; color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
    .nav-icon { font-size: 15px; width: 20px; text-align: center; }
    .sidebar-footer { padding: 16px 16px 0; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 10px; margin-top: 8px; }
    .sidebar-user { flex: 1; display: flex; align-items: center; gap: 10px; overflow: hidden; }
    .user-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; color: #fff; flex-shrink: 0; }
    .user-name { font-size: 14px; font-weight: 800; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .user-role { font-size: 11px; color: var(--muted); text-transform: uppercase; }
    .logout-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 18px; padding: 4px; }
    
    .nav-row { display: flex; align-items: center; justify-content: center; gap: 20px; padding: 12px; background: var(--subtle); border-radius: 12px; margin-bottom: 20px; border: 1px solid var(--border); }
    .nav-meta { font-family: 'IBM Plex Mono', monospace; font-weight: 700; color: var(--accent); font-size: 14px; }

    .content-area { flex: 1; padding: 36px 40px 56px; overflow-y: auto; max-width: 1300px; }
    .page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 28px; }
    .page-title { font-size: 32px; font-weight: 800; color: var(--text); letter-spacing: -0.03em; }
    .page-sub { font-size: 15px; color: var(--muted); margin-top: 4px; }
    .header-badge { padding: 6px 14px; background: rgba(239,68,68,.12); color: var(--red); border-radius: 20px; font-size: 12px; font-weight: 700; border: 1px solid rgba(239,68,68,.25); }

    /* Previewer */
    .preview-container { display: flex; flex-direction: column; gap: 24px; background: #000; border-radius: 14px; overflow: hidden; border: 1px solid var(--accent); }
    .preview-item { display: flex; flex-direction: column; }
    .preview-label { background: var(--accent2); color: #fff; padding: 8px 16px; font-size: 12px; font-weight: 700; font-family: 'IBM Plex Mono', monospace; }
    .video-player { width: 100%; max-height: 500px; outline: none; background: #000; }
    .doc-viewer { width: 100%; height: 600px; border: none; background: #fff; }
    .img-preview { width: 100%; height: auto; display: block; }
    .no-preview { padding: 40px; text-align: center; color: #fff; font-size: 14px; }
    .no-preview a { color: #60a5fa; text-decoration: none; font-weight: 700; }

    /* Animated Progress */
    .file-progress-bar { 
      background: linear-gradient(90deg, var(--blue), #60a5fa);
      box-shadow: 0 0 10px rgba(96,165,250,0.5);
    }

    /* Stats */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; position: relative; overflow: hidden; box-shadow: var(--shadow); }
    .stat-card::before { content: ''; position: absolute; top: 0; left: 0; bottom: 0; width: 4px; }
    .stat-accent::before { background: var(--accent); }
    .stat-blue::before { background: var(--blue); }
    .stat-purple::before { background: #7c3aed; }
    .stat-red::before { background: var(--red); }
    .stat-green::before { background: var(--green); }
    .stat-yellow::before { background: var(--yellow); }
    .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 800; margin-bottom: 6px; }
    .stat-value { font-size: 30px; font-weight: 800; color: var(--text); }
    .stat-icon { font-size: 20px; margin-bottom: 6px; }

    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: var(--shadow); }
    .card-header-flex { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
    .card-header-flex .card-title { margin-bottom: 0; }
    .card-title { font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); margin-bottom: 18px; }
    .two-col { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
    .muted { color: var(--muted); font-size: 14px; }
    .empty-chart { color: var(--muted); font-size: 14px; text-align: center; padding: 40px; }
    .empty-state { text-align: center; padding: 80px 40px; }
    .empty-icon { font-size: 56px; margin-bottom: 16px; }
    .empty-state h3 { font-size: 20px; font-weight: 800; margin-bottom: 8px; }
    .empty-state p { color: var(--muted); font-size: 14px; margin-bottom: 24px; max-width: 400px; margin-left: auto; margin-right: auto; line-height: 1.7; }

    /* ── File Upload ── */
    .drop-zone { border: 2px dashed var(--border-strong); border-radius: 12px; padding: 32px; text-align: center; cursor: pointer; transition: all .2s; background: var(--subtle); user-select: none; }
    .drop-zone:hover, .drop-zone.dragging { border-color: var(--accent); background: #eef3f8; }
    .drop-zone.disabled { opacity: .5; cursor: not-allowed; pointer-events: none; }
    .drop-icon { font-size: 32px; margin-bottom: 8px; }
    .drop-label { font-size: 16px; font-weight: 700; color: var(--text); margin-bottom: 4px; }
    .drop-hint { font-size: 13px; color: var(--muted); }
    .file-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .file-item { display: flex; align-items: center; gap: 12px; background: var(--subtle); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
    .file-item.file-done { border-color: rgba(31,122,77,0.3); background: rgba(236,253,245,0.7); }
    .file-item.file-error { border-color: rgba(180,35,24,0.3); background: rgba(255,241,240,0.7); }
    .file-icon { font-size: 22px; flex-shrink: 0; }
    .file-info { flex: 1; min-width: 0; }
    .file-name { font-size: 14px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-meta { font-size: 12px; color: var(--muted); margin-top: 2px; font-family: 'IBM Plex Mono', monospace; }
    .file-err-label { color: var(--red); }
    .file-ok-label { color: var(--green); }
    .file-progress-track { height: 4px; background: var(--border); border-radius: 2px; margin-top: 6px; overflow: hidden; }
    .file-progress-bar { height: 100%; background: var(--accent); border-radius: 2px; transition: width .3s; }
    .file-remove { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; padding: 4px; flex-shrink: 0; }
    .file-view-btn { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 700; cursor: pointer; text-decoration: none; font-family: 'Source Sans 3', sans-serif; white-space: nowrap; }
    .file-type-chip { background: var(--subtle); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; font-size: 12px; color: var(--muted); font-weight: 600; }
    .upload-section { background: var(--subtle); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
    .upload-section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .upload-section-title { font-size: 15px; font-weight: 800; color: var(--text); }
    .upload-section-hint { font-size: 12px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
    .upload-tips { font-size: 13px; color: var(--muted); line-height: 1.6; max-width: 400px; }

    /* Tasks */
    .tasks-layout { display: grid; grid-template-columns: 380px 1fr; gap: 20px; align-items: start; }
    .task-list { display: flex; flex-direction: column; gap: 10px; }
    .task-card { width: 100%; text-align: left; background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px; cursor: pointer; transition: .15s; box-shadow: 0 6px 18px rgba(20,32,51,0.06); }
    .task-card:hover { border-color: rgba(23,59,99,0.4); transform: translateY(-1px); }
    .task-card.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(23,59,99,0.12); }
    .task-card-top { display: flex; align-items: start; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .task-title { font-weight: 900; font-size: 15px; color: var(--text); line-height: 1.2; }
    .task-desc { font-size: 13px; color: var(--muted); line-height: 1.5; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
    .task-meta { margin-top: 8px; font-size: 11px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
    .task-status { font-size: 11px; font-weight: 900; border-radius: 999px; padding: 5px 10px; border: 1px solid; white-space: nowrap; }
    .task-status.open { background: #ecfdf5; border-color: rgba(34,197,94,0.25); color: #166534; }
    .task-status.submitted { background: #eff6ff; border-color: rgba(37,99,235,0.22); color: #1d4ed8; }
    .task-status.expired { background: #fff7ed; border-color: rgba(251,146,60,0.3); color: #9a3412; }
    .task-detail { display: flex; flex-direction: column; gap: 16px; }
    .task-detail-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .task-detail-title { font-size: 18px; font-weight: 900; margin: 0; }
    .task-detail-sub { color: var(--muted); font-size: 12px; font-family: 'IBM Plex Mono', monospace; margin-top: 4px; }
    .task-full-desc { color: var(--text); line-height: 1.7; font-size: 15px; white-space: pre-wrap; }
    .task-actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-top: 16px; flex-wrap: wrap; }
    .task-answer { min-height: 180px; }
    .task-create-grid { display: grid; grid-template-columns: 1fr 320px; gap: 16px; align-items: start; }
    .task-admin-table { display: flex; flex-direction: column; gap: 8px; }
    .task-admin-head { display: grid; grid-template-columns: 1.7fr 1fr 0.7fr 0.5fr 0.7fr; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 800; font-size: 12px; }
    .task-admin-row { display: grid; grid-template-columns: 1.7fr 1fr 0.7fr 0.5fr 0.7fr; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,255,255,0.8); align-items: center; transition: border-color .15s; }
    .task-admin-row:hover { border-color: var(--accent); }
    .task-admin-title { font-weight: 800; font-size: 14px; }
    .task-status-pill { font-size: 11px; font-weight: 800; padding: 5px 10px; border-radius: 999px; border: 1px solid; width: fit-content; }
    .task-status-pill.active { background: #eff6ff; border-color: rgba(37,99,235,0.2); color: #1d4ed8; }
    .task-status-pill.expired { background: #fff7ed; border-color: rgba(251,146,60,0.25); color: #9a3412; }
    .task-status-pill.inactive { background: #f1f5f9; border-color: rgba(148,163,184,0.4); color: #475569; }

    /* Leaderboard */
    .task-leaderboard { display: flex; flex-direction: column; gap: 6px; }
    .task-lb-head { display: grid; grid-template-columns: 70px 1.6fr 150px 110px; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 12px; font-weight: 800; }
    .task-lb-row { display: grid; grid-template-columns: 70px 1.6fr 150px 110px; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: rgba(255,255,255,0.8); transition: .15s; }
    .task-lb-row:hover { border-color: var(--accent); }
    .task-lb-row.top-ten { border-color: rgba(34,197,94,0.25); background: rgba(236,253,245,0.8); }
    .task-lb-row.me { box-shadow: 0 0 0 2px rgba(23,59,99,0.15); }
    .task-lb-rank { font-family: 'IBM Plex Mono', monospace; font-weight: 900; }
    .task-lb-name { font-weight: 800; }
    .task-lb-score { text-align: right; font-family: 'IBM Plex Mono', monospace; font-weight: 900; }

    /* Candidate list */
    .candidate-list { display: flex; flex-direction: column; gap: 8px; }
    .candidate-row { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; display: flex; align-items: center; gap: 14px; cursor: pointer; transition: .15s; box-shadow: 0 4px 12px rgba(20,32,51,0.05); }
    .candidate-row:hover { border-color: var(--accent); transform: translateY(-1px); }
    .rank-num { width: 28px; font-size: 13px; font-weight: 800; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
    .candidate-info { flex: 1; min-width: 0; }
    .candidate-name { font-size: 15px; font-weight: 800; color: var(--text); }
    .candidate-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .total-score { font-size: 20px; font-weight: 800; color: var(--text); min-width: 52px; text-align: right; }
    .total-score span { font-size: 12px; color: var(--muted); }

    /* Skill badges */
    .skill-badge { padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 800; border: 1px solid; white-space: nowrap; }
    .skill-beginner { background: rgba(180,35,24,.1); color: var(--red); border-color: rgba(180,35,24,.25); }
    .skill-intermediate { background: rgba(161,92,7,.1); color: var(--yellow); border-color: rgba(161,92,7,.25); }
    .skill-advanced { background: rgba(31,122,77,.1); color: var(--green); border-color: rgba(31,122,77,.25); }
    .skill-pending { background: rgba(102,117,138,.1); color: var(--muted); border-color: rgba(102,117,138,.25); }

    /* Pending/chips */
    .pending-chip { background: rgba(161,92,7,.12); color: var(--yellow); border: 1px solid rgba(161,92,7,.25); border-radius: 20px; padding: 4px 10px; font-size: 12px; font-weight: 800; white-space: nowrap; }
    .score-chips-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
    .score-chips-row span { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--muted); }
    .total-chip { background: #eef3f8; color: var(--accent); border: 1px solid var(--border); padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 800; }
    .flag-alert { background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.3); border-radius: 10px; padding: 10px 14px; font-size: 13px; color: var(--yellow); }

    /* Pending list */
    .pending-list { display: flex; flex-direction: column; gap: 8px; }
    .pending-row { display: flex; align-items: center; gap: 12px; background: var(--subtle); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; cursor: pointer; transition: .15s; }
    .pending-row:hover { border-color: var(--accent); }
    .pending-info { flex: 1; }
    .pending-name { font-size: 14px; font-weight: 800; color: var(--text); }
    .pending-task { font-size: 12px; color: var(--muted); margin-top: 2px; }

    /* Answers */
    .answers-list { display: flex; flex-direction: column; gap: 12px; }
    .answer-item { background: var(--subtle); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .answer-label { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); font-weight: 800; margin-bottom: 8px; }
    .answer-text { font-size: 14px; color: var(--text); line-height: 1.7; font-family: 'IBM Plex Mono', monospace; white-space: pre-wrap; }

    /* Feedback */
    .feedback-list { display: flex; flex-direction: column; gap: 8px; }
    .feedback-item { background: var(--subtle); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; color: var(--text); font-size: 14px; line-height: 1.6; }

    /* Pie chart */
    .pie-chart-wrap { display: flex; align-items: center; gap: 24px; }
    .pie-svg { width: 150px; height: 150px; flex-shrink: 0; }
    .pie-legend { display: flex; flex-direction: column; gap: 10px; }
    .legend-item { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text); font-weight: 600; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .legend-val { margin-left: auto; background: var(--subtle); padding: 2px 8px; border-radius: 6px; font-size: 12px; }

    /* Modals */
    .modal-overlay { position: fixed; inset: 0; background: rgba(20,32,51,.5); z-index: 999; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; width: 520px; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 60px rgba(0,0,0,0.2); }
    .modal.modal-wide { width: 740px; }
    .modal.modal-centered { width: 560px; }
    .modal-header { padding: 22px 24px 0; display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    .modal-header h3 { font-size: 20px; font-weight: 800; color: var(--text); }
    .modal-sub { font-size: 13px; color: var(--muted); margin-top: 3px; }
    .modal-body { padding: 22px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; flex: 1; }
    .modal-body.scrollable { overflow-y: auto; max-height: calc(90vh - 130px); }
    .modal-footer { padding: 14px 24px; border-top: 1px solid var(--border); display: flex; gap: 10px; justify-content: flex-end; }
    .close-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 20px; line-height: 1; padding: 4px; }
    .center-msg { background: rgba(255,241,240,0.7); border: 1px solid rgba(180,35,24,0.25); color: #7f1d1d; border-radius: 12px; padding: 14px 16px; font-weight: 700; line-height: 1.6; }

    /* Scoring */
    .score-input-row { display: flex; flex-direction: column; gap: 6px; }
    .score-input-row label { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .score-hint { font-size: 12px; color: var(--muted); margin-top: -2px; }
    .max-hint { color: var(--border-strong); font-size: 11px; font-weight: 400; }
    .score-input-wrap { display: flex; align-items: center; gap: 12px; }
    .score-range { flex: 1; accent-color: var(--accent); cursor: pointer; }
    .score-num { width: 58px; background: var(--subtle); border: 1px solid var(--border); border-radius: 8px; padding: 8px; color: var(--text); font-family: 'IBM Plex Mono', monospace; font-size: 16px; font-weight: 700; text-align: center; outline: none; }
    .total-preview { background: var(--subtle); border-radius: 10px; padding: 14px 16px; display: flex; align-items: center; gap: 12px; }
    .total-preview span:first-child { flex: 1; font-size: 14px; font-weight: 700; color: var(--muted); }
    .total-num { font-size: 24px; font-weight: 800; color: var(--text); font-family: 'IBM Plex Mono', monospace; }

    /* Filter */
    .filter-bar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .filter-select { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; color: var(--text); font-family: 'Source Sans 3', sans-serif; font-size: 15px; font-weight: 700; cursor: pointer; outline: none; }

    /* Responsive */
    @media (max-width: 960px) {
      .tasks-layout { grid-template-columns: 1fr; }
      .task-create-grid { grid-template-columns: 1fr; }
      .two-col { grid-template-columns: 1fr; }
      .content-area { padding: 20px; }
      .sidebar { width: 56px; }
      .sidebar-logo div, .sidebar-brand, .sidebar-sub, .user-name, .user-role { display: none; }
      .nav-item { justify-content: center; font-size: 0; padding: 12px; }
      .nav-icon { font-size: 18px; }
      .form-row { grid-template-columns: 1fr; }
      .task-lb-head, .task-lb-row { grid-template-columns: 50px 1fr 100px 80px; }
      .auth-hero { display: none; }
      .auth-card { width: 100%; min-width: unset; }
    }

    @media print {
      .sidebar, .btn-primary, .btn-outline, .btn-submit, .btn-danger, .btn-score, .toast, .modal-overlay, .filter-bar, .page-header div:last-child, .card-header-flex div:last-child { display: none !important; }
      .main-layout { display: block; }
      .content-area { padding: 0; max-width: 100%; }
      .card { box-shadow: none; border: 1px solid var(--border); break-inside: avoid; }
      .task-card, .candidate-row, .task-lb-row { break-inside: avoid; }
      body { background: #fff; }
      .page-title::after { content: ' - Platform Report'; }
    }
  `;
}