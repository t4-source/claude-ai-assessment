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
  addDoc,
  collection,
  doc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";

const EMPTY_ANSWERS = {
  sectionA: "",
  promptUsed: "",
  claudeOutput: "",
  candidateImprovements: "",
  sectionC: "",
  sectionD: "",
  sectionE: "",
};

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
  FIREBASE_CONFIG.appId
);

const firebaseApp = firebaseReady ? getApps()[0] || initializeApp(FIREBASE_CONFIG) : null;
const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;
const firestore = firebaseApp ? getFirestore(firebaseApp) : null;

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

function normalizeResponse(id, data = {}) {
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
    userId: data.userId || "",
    submittedAt: getIsoDate(data.submittedAt) || data.submittedAtIso || "",
    answers: { ...EMPTY_ANSWERS, ...(data.answers || {}) },
    scores,
    totalScore,
    skillLevel: data.skillLevel || getSkillLevel(totalScore),
    flags: Array.isArray(data.flags) ? data.flags : [],
    integritySignals: Array.isArray(data.integritySignals) ? data.integritySignals : [],
    aiEvaluation: data.aiEvaluation || null,
    evaluationSource: data.evaluationSource || "manual",
  };
}

const ANSWER_FIELDS = Object.keys(EMPTY_ANSWERS);
const FIELD_LABELS = {
  sectionA: "Section A",
  promptUsed: "Prompt Used",
  claudeOutput: "AI Output",
  candidateImprovements: "Improvements",
  sectionC: "Section C",
  sectionD: "Section D",
  sectionE: "Section E",
};

function clampScore(value, max) {
  return Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeForCompare(text = "") {
  return text
    .toLowerCase()
    .replace(/[₹$€£]\s*[\d,.]+/g, " amount ")
    .replace(/\d+(\.\d+)?%?/g, " number ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeForCompare(text)
    .split(" ")
    .filter(token => token.length > 2);
}

function levenshteinRatio(a, b) {
  const left = normalizeForCompare(a).slice(0, 1500);
  const right = normalizeForCompare(b).slice(0, 1500);
  if (!left || !right) return 0;

  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    let prevDiagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const old = previous[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, prevDiagonal + cost);
      prevDiagonal = old;
    }
  }

  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function tokenJaccard(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;

  let intersection = 0;
  left.forEach(token => {
    if (right.has(token)) intersection++;
  });

  return intersection / new Set([...left, ...right]).size;
}

function similarityPercent(a, b) {
  if (!a?.trim() || !b?.trim()) return 0;
  return Math.round(Math.max(levenshteinRatio(a, b), tokenJaccard(a, b)) * 100);
}

function band(value, size) {
  return Math.floor(value / size) * size;
}

function promptStructureFingerprint(text = "") {
  const lower = text.toLowerCase();
  const markers = [];
  if (/you are|act as|role:/.test(lower)) markers.push("role");
  if (/your task|task:|analy[sz]e|evaluate|generate|review/.test(lower)) markers.push("task");
  if (/context:|client|provided|following|i will provide/.test(lower)) markers.push("context");
  if (/format|output|json|table|checklist|template/.test(lower)) markers.push("output_format");
  if (/risk score|confidence|priority|high\/medium\/low|1-10/.test(lower)) markers.push("scoring");
  if (/ind as|gst|gstr|itc|sa \d+|section \d+|benford|beneish/.test(lower)) markers.push("domain_refs");
  if (/\(\d+\)|\b\d+[.)]/.test(text)) markers.push("numbered_steps");
  if (/\n\s*[-*•]/.test(text)) markers.push("bullets");
  if (/\|/.test(text)) markers.push("table_columns");
  if (/issue|amount|reference|recommend(ed|ation)|action/.test(lower)) markers.push("audit_fields");

  const labels = text.match(/\b[A-Z][A-Za-z ]{2,22}:/g) || [];
  markers.push(`labels_${Math.min(labels.length, 6)}`);
  markers.push(`sentences_${band((text.match(/[.!?]/g) || []).length, 4)}`);
  markers.push(`length_${band(text.length, 250)}`);

  return uniqueList(markers);
}

function outputPatternFingerprint(text = "") {
  const lower = text.toLowerCase();
  const markers = [];
  if (/based on|analysis complete|found|key findings/.test(lower)) markers.push("summary_intro");
  if (/\b\d+[.)]/.test(text)) markers.push("numbered_findings");
  if (/\n\s*[-*•]/.test(text)) markers.push("bulleted_findings");
  if (/[₹$€£]\s*[\d,.]+|\b\d+(\.\d+)?%/.test(text)) markers.push("quantified");
  if (/high|medium|low|risk|priority|confidence/.test(lower)) markers.push("risk_labels");
  if (/issue|finding|recommendation|action|reference/.test(lower)) markers.push("finding_fields");
  if (/\|/.test(text)) markers.push("table");
  markers.push(`lines_${band(text.split(/\n+/).filter(Boolean).length, 3)}`);
  markers.push(`length_${band(text.length, 250)}`);
  return uniqueList(markers);
}

function fingerprintSimilarity(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach(item => {
    if (b.has(item)) intersection++;
  });
  return intersection / new Set([...a, ...b]).size;
}

function analyzeIntegrity(answers, priorResponses, currentUserId) {
  const flags = new Set();
  const signals = [];
  const totalChars = ANSWER_FIELDS.reduce((sum, field) => sum + (answers[field]?.trim().length || 0), 0);

  if (answers.sectionA.trim().length < 50 || totalChars < 350) flags.add("low_effort_response");
  if (ANSWER_FIELDS.some(field => !answers[field]?.trim())) flags.add("incomplete_submission");

  priorResponses
    .filter(response => response.userId !== currentUserId)
    .forEach(response => {
      ANSWER_FIELDS.forEach(field => {
        const current = answers[field] || "";
        const previous = response.answers?.[field] || "";
        if (current.length < 80 || previous.length < 80) return;

        const similarity = similarityPercent(current, previous);
        if (similarity >= 94) {
          flags.add("near_duplicate_answer");
          signals.push({
            type: "near_duplicate_answer",
            field: FIELD_LABELS[field],
            matchedResponseId: response.id,
            similarity,
          });
        }
        if (field === "sectionA" && similarity >= 80) {
          flags.add("similar_prompt_text");
          signals.push({
            type: "similar_prompt_text",
            field: FIELD_LABELS[field],
            matchedResponseId: response.id,
            similarity,
          });
        }
      });

      const structureSimilarity = fingerprintSimilarity(
        promptStructureFingerprint(answers.sectionA),
        promptStructureFingerprint(response.answers?.sectionA || "")
      );
      const sectionSimilarity = similarityPercent(answers.sectionA, response.answers?.sectionA || "");
      if (structureSimilarity >= 0.86 && sectionSimilarity >= 45) {
        flags.add("same_prompt_structure");
        signals.push({
          type: "same_prompt_structure",
          field: "Section A",
          matchedResponseId: response.id,
          similarity: Math.round(structureSimilarity * 100),
        });
      }

      const outputSimilarity = fingerprintSimilarity(
        outputPatternFingerprint(answers.claudeOutput),
        outputPatternFingerprint(response.answers?.claudeOutput || "")
      );
      const outputTextSimilarity = similarityPercent(answers.claudeOutput, response.answers?.claudeOutput || "");
      if (outputSimilarity >= 0.85 && outputTextSimilarity >= 45) {
        flags.add("same_output_pattern");
        signals.push({
          type: "same_output_pattern",
          field: "AI Output",
          matchedResponseId: response.id,
          similarity: Math.round(outputSimilarity * 100),
        });
      }
    });

  return {
    flags: [...flags],
    signals: signals
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 8),
  };
}

function scoreText(text, keywords, minChars, maxScore) {
  const lower = text.toLowerCase();
  const keywordHits = keywords.filter(keyword => lower.includes(keyword)).length;
  const keywordScore = (keywordHits / keywords.length) * maxScore * 0.48;
  const lengthScore = Math.min(text.trim().length / minChars, 1) * maxScore * 0.34;
  const structureScore = promptStructureFingerprint(text).length >= 5 ? maxScore * 0.18 : maxScore * 0.08;
  return clampScore(keywordScore + lengthScore + structureScore, maxScore);
}

function heuristicEvaluate(answers, flags = []) {
  const promptScore = scoreText(
    `${answers.sectionA} ${answers.sectionD} ${answers.sectionE}`,
    ["role", "act as", "materiality", "audit", "risk", "gst", "tds", "format", "excel", "source"],
    1200,
    10
  );
  const taskScore = scoreText(
    `${answers.promptUsed} ${answers.claudeOutput} ${answers.candidateImprovements}`,
    ["excel", "csv", "formula", "reconcile", "validate", "invoice", "output", "amount", "duplicate", "format"],
    900,
    20
  );
  const evaluationScore = scoreText(
    `${answers.sectionC} ${answers.candidateImprovements}`,
    ["vague", "missing", "source", "evidence", "verify", "formula", "materiality", "follow-up"],
    500,
    10
  );
  const totalScore = promptScore + taskScore + evaluationScore;

  return {
    scores: { promptScore, taskScore, evaluationScore },
    totalScore,
    skillLevel: getSkillLevel(totalScore),
    flags,
    feedback: [
      "Heuristic fallback score used because the AI evaluator was unavailable.",
      promptScore < 6 ? "Prompts need clearer CA role, source documents, materiality, checks, and output format." : "Prompts include useful CA context, controls, and deliverable structure.",
      evaluationScore < 6 ? "Evaluation should identify missing source evidence, formulas, exception thresholds, and follow-up procedures." : "Evaluation shows useful critique of evidence, reliability, and professional use.",
    ],
    qualitySignals: {
      structuredPrompt: promptStructureFingerprint(answers.sectionA).length >= 5,
      domainSpecific: /gst|gstr|itc|audit|tds|fraud|ind as|tax|trial balance/i.test(Object.values(answers).join(" ")),
      actionableEvaluation: /recommend|action|improve|verify|evidence|materiality|formula/i.test(`${answers.sectionC} ${answers.candidateImprovements}`),
      formatSpecified: /format|table|json|checklist|columns|csv|excel/i.test(Object.values(answers).join(" ")),
    },
    source: "heuristic_fallback",
  };
}

function normalizeEvaluation(data, fallbackFlags) {
  const scores = {
    promptScore: clampScore(data?.scores?.promptScore, 10),
    taskScore: clampScore(data?.scores?.taskScore, 20),
    evaluationScore: clampScore(data?.scores?.evaluationScore, 10),
  };
  const totalScore = clampScore(data?.totalScore ?? scores.promptScore + scores.taskScore + scores.evaluationScore, 40);

  return {
    scores,
    totalScore,
    skillLevel: data?.skillLevel || getSkillLevel(totalScore),
    flags: uniqueList([...(fallbackFlags || []), ...(Array.isArray(data?.flags) ? data.flags : [])]),
    feedback: Array.isArray(data?.feedback) ? data.feedback.slice(0, 6) : [],
    qualitySignals: data?.qualitySignals || {},
    source: data?.source || "openai",
  };
}

async function evaluateAssessmentWithAI(answers, integrityFlags) {
  try {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    return normalizeEvaluation(data, integrityFlags);
  } catch {
    return heuristicEvaluate(answers, integrityFlags);
  }
}

// ─── App State ────────────────────────────────────────────────────────────
function App() {
  const [users, setUsers] = useState([]);
  const [responses, setResponses] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [view, setView] = useState("login"); // login | signup | assessment | admin | candidate_dashboard
  const theme = "light";
  const [notification, setNotification] = useState(null);
  const [authReady, setAuthReady] = useState(!firebaseReady);
  const db = { users, responses };

  const notify = useCallback((msg, type = "success") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3500);
  }, []);

  useEffect(() => {
    if (!firebaseAuth || !firestore) return;
    let unsubscribeProfile = () => {};

    const unsubscribeAuth = onAuthStateChanged(firebaseAuth, authUser => {
      unsubscribeProfile();

      if (!authUser) {
        setCurrentUser(null);
        setAuthReady(true);
        setView("login");
        return;
      }

      unsubscribeProfile = onSnapshot(
        doc(firestore, "users", authUser.uid),
        snapshot => {
          const profile = normalizeUser(authUser.uid, snapshot.exists() ? snapshot.data() : {}, authUser);
          setCurrentUser(profile);
          setAuthReady(true);
          setView(v => {
            if (v !== "login" && v !== "signup") return v;
            return profile.role === "admin" ? "admin" : "candidate_dashboard";
          });
        },
        error => {
          notify(`Could not load user profile: ${error.message}`, "error");
          setAuthReady(true);
        }
      );
    });

    return () => {
      unsubscribeProfile();
      unsubscribeAuth();
    };
  }, [notify]);

  useEffect(() => {
    if (!firestore || !currentUser) {
      setUsers([]);
      setResponses([]);
      return;
    }

    const unsubscribeUsers = currentUser.role === "admin"
      ? onSnapshot(
        collection(firestore, "users"),
        snapshot => setUsers(snapshot.docs.map(userDoc => normalizeUser(userDoc.id, userDoc.data()))),
        error => notify(`Could not load users: ${error.message}`, "error")
      )
      : () => {};

    if (currentUser.role !== "admin") setUsers([currentUser]);

    const unsubscribeResponses = onSnapshot(
      query(collection(firestore, "responses"), orderBy("submittedAt", "desc")),
      snapshot => setResponses(snapshot.docs.map(responseDoc => normalizeResponse(responseDoc.id, responseDoc.data()))),
      error => notify(`Could not load responses: ${error.message}`, "error")
    );

    return () => {
      unsubscribeUsers();
      unsubscribeResponses();
    };
  }, [currentUser, notify]);

  const logout = useCallback(async () => {
    if (firebaseAuth) await signOut(firebaseAuth);
    setCurrentUser(null);
    setView("login");
  }, []);

  if (!firebaseReady) {
    return (
      <div className={`app-root ${theme}`}>
        <style>{CSS(theme)}</style>
        <FirebaseSetupNotice />
      </div>
    );
  }

  if (!authReady) {
    return (
      <div className={`app-root ${theme}`}>
        <style>{CSS(theme)}</style>
        <div className="auth-page">
          <div className="auth-card" style={{ textAlign: "center" }}>
            <span className="spinner dark" />
            <h1 className="auth-title">Loading secure session</h1>
            <p className="auth-sub">Connecting to Firebase Auth and Firestore.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-root ${theme}`}>
      <style>{CSS(theme)}</style>

      {/* Notification Toast */}
      {notification && (
        <div className={`toast toast-${notification.type}`}>
          <span>{notification.type === "success" ? "✓" : notification.type === "error" ? "✗" : "ℹ"}</span>
          {notification.msg}
        </div>
      )}

      {/* Router */}
      {view === "login" && (
        <LoginPage setView={setView} notify={notify} />
      )}
      {view === "signup" && (
        <SignupPage setView={setView} notify={notify} />
      )}
      {view === "assessment" && currentUser?.role === "candidate" && (
        <AssessmentPage db={db} currentUser={currentUser} setView={setView} notify={notify} logout={logout} />
      )}
      {view === "candidate_dashboard" && currentUser?.role === "candidate" && (
        <CandidateDashboard db={db} currentUser={currentUser} setView={setView} logout={logout} />
      )}
      {view === "admin" && currentUser?.role === "admin" && (
        <AdminDashboard db={db} currentUser={currentUser} logout={logout} notify={notify} />
      )}
    </div>
  );
}

function FirebaseSetupNotice() {
  return (
    <div className="auth-page">
      <div className="auth-card wide">
        <div className="auth-logo">
          <div className="logo-icon">CA</div>
          <div>
            <h1 className="auth-title">Firebase Setup Required</h1>
            <p className="auth-sub">Add Firebase web config variables before deployment.</p>
          </div>
        </div>
        <div className="setup-box">
          <p>Create a Firebase project, enable Email/Password Auth, create Firestore, then add these environment variables in Vercel:</p>
          <code>VITE_FIREBASE_API_KEY</code>
          <code>VITE_FIREBASE_AUTH_DOMAIN</code>
          <code>VITE_FIREBASE_PROJECT_ID</code>
          <code>VITE_FIREBASE_STORAGE_BUCKET</code>
          <code>VITE_FIREBASE_MESSAGING_SENDER_ID</code>
          <code>VITE_FIREBASE_APP_ID</code>
        </div>
      </div>
    </div>
  );
}

// ─── LOGIN PAGE ───────────────────────────────────────────────────────────
function LoginPage({ setView, notify }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password) return notify("Email and password are required.", "error");
    setLoading(true);
    try {
      await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
      notify("Signed in successfully.");
    } catch (error) {
      notify(error.message || "Invalid email or password.", "error");
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
            <h1 className="auth-title">AI Skills Assessment</h1>
            <p className="auth-sub">Chartered Accountant • AI Proficiency Evaluation</p>
          </div>
        </div>

        <div className="form-group">
          <label>Email Address</label>
          <input className="form-input" type="email" value={email}
            onChange={e => setEmail(e.target.value)} placeholder="your@email.com"
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

        <p className="auth-link">
          Don't have an account? <button onClick={() => setView("signup")}>Create one</button>
        </p>
      </div>

      <div className="auth-hero">
        <div className="hero-stats">
          {[["Role-Based", "CA Scenarios"], ["40 pts", "Structured Score"], ["AI + Excel", "Practical Workflow"]].map(([val, lbl]) => (
            <div key={lbl} className="hero-stat">
              <div className="hero-stat-val">{val}</div>
              <div className="hero-stat-lbl">{lbl}</div>
            </div>
          ))}
        </div>
        <h2 className="hero-heading">Evaluate AI Readiness for Modern CA Work</h2>
        <p className="hero-body">Assess how well candidates use AI for audit review, GST reconciliation, Excel-based analysis, report preparation, and professional quality control. The platform focuses on practical judgement, not generic prompt writing.</p>
        <div className="hero-tags">
          {["Audit Risk Review", "GST Reconciliation", "Excel and CSV Checks", "Working Paper Output", "AI Reliability Review"].map(t => (
            <span key={t} className="hero-tag">{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── SIGNUP PAGE ──────────────────────────────────────────────────────────
function SignupPage({ setView, notify }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", domain: "Audit", experience: "1-3 years", aiUsage: "Beginner" });
  const [loading, setLoading] = useState(false);

  const handleSignup = async () => {
    if (!form.name || !form.email || !form.password) return notify("All fields required.", "error");
    if (form.password.length < 6) return notify("Password must be at least 6 characters.", "error");

    setLoading(true);
    try {
      const credential = await createUserWithEmailAndPassword(firebaseAuth, form.email.trim(), form.password);
      await updateProfile(credential.user, { displayName: form.name.trim() });
      await setDoc(doc(firestore, "users", credential.user.uid), {
        id: credential.user.uid,
        name: form.name.trim(),
        email: form.email.trim(),
        role: "candidate",
        domain: form.domain,
        experience: form.experience,
        aiUsage: form.aiUsage,
        createdAt: serverTimestamp(),
      });
      notify("Account created successfully.");
      setView("candidate_dashboard");
    } catch (error) {
      notify(error.message || "Could not create account.", "error");
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
          <div>
            <h1 className="auth-title">Create Account</h1>
            <p className="auth-sub">Join the AI Skills Assessment Platform</p>
          </div>
        </div>

        {[["Full Name", "name", "text", "Priya Sharma"],
          ["Email Address", "email", "email", "priya@example.com"],
          ["Password", "password", "password", "••••••••"]
        ].map(([lbl, key, type, ph]) => (
          <div className="form-group" key={key}>
            <label>{lbl}</label>
            <input className="form-input" type={type} value={form[key]} onChange={set(key)} placeholder={ph} />
          </div>
        ))}

        <div className="form-row">
          <div className="form-group">
            <label>Domain</label>
            <select className="form-input" value={form.domain} onChange={set("domain")}>
              <option>Audit</option><option>Tax</option><option>Advisory</option>
            </select>
          </div>
          <div className="form-group">
            <label>Experience</label>
            <select className="form-input" value={form.experience} onChange={set("experience")}>
              <option>{"< 1 year"}</option><option>1-3 years</option><option>3-5 years</option><option>5+ years</option>
            </select>
          </div>
          <div className="form-group">
            <label>AI Usage Level</label>
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

// ─── CANDIDATE DASHBOARD ──────────────────────────────────────────────────
function CandidateDashboard({ db, currentUser, setView, logout }) {
  const myResponse = db.responses.find(r => r.userId === currentUser.id);
  const ranked = [...db.responses].sort((a, b) => b.totalScore - a.totalScore);
  const myRank = myResponse ? ranked.findIndex(r => r.id === myResponse.id) + 1 : null;
  const avgScore = db.responses.length ? Math.round(db.responses.reduce((sum, r) => sum + r.totalScore, 0) / db.responses.length) : 0;
  const percentile = myResponse && ranked.length
    ? Math.round(((ranked.length - myRank + 1) / ranked.length) * 100)
    : 0;
  const benchmarkDelta = myResponse ? myResponse.totalScore - avgScore : 0;

  return (
    <div className="main-layout">
      <Sidebar role="candidate" current="dashboard" setView={setView} logout={logout} user={currentUser} />
      <div className="content-area">
        <div className="page-header">
          <div>
            <h2 className="page-title">My Dashboard</h2>
            <p className="page-sub">Welcome back, {currentUser.name}</p>
          </div>
          {myResponse ? (
            <button className="btn-primary sm" onClick={() => printCandidateReport(currentUser, myResponse, avgScore, myRank, ranked.length)}>
              Download Report PDF
            </button>
          ) : (
            <button className="btn-primary sm" onClick={() => setView("assessment")}>
              Start Assessment →
            </button>
          )}
        </div>

        {myResponse ? (
          <>
            <div className="stats-grid">
              {[
                { label: "Total Score", value: myResponse.totalScore + "/40", color: "accent" },
                { label: "Rank", value: `#${myRank} of ${ranked.length}`, color: "blue" },
                { label: "Skill Level", value: myResponse.skillLevel, color: skillColor(myResponse.skillLevel) },
                { label: "Percentile", value: percentile + "%", color: "purple" },
              ].map(s => (
                <div key={s.label} className={`stat-card stat-${s.color}`}>
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value">{s.value}</div>
                </div>
              ))}
            </div>

            <div className="two-col">
              <div className="card">
                <h3 className="card-title">Score Breakdown</h3>
                <div className="score-bars">
                  {[
                    { label: "Prompt Engineering", score: myResponse.scores.promptScore, max: 10 },
                    { label: "Task Submission", score: myResponse.scores.taskScore, max: 20 },
                    { label: "Output Evaluation", score: myResponse.scores.evaluationScore, max: 10 },
                  ].map(b => (
                    <div key={b.label} className="score-bar-row">
                      <div className="score-bar-label"><span>{b.label}</span><span>{b.score}/{b.max}</span></div>
                      <div className="score-bar-track">
                        <div className="score-bar-fill" style={{ width: `${(b.score / b.max) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card">
                <h3 className="card-title">Percentile Ring</h3>
                <PercentileRing score={myResponse.totalScore} max={40} />
                <div className="benchmark-note">
                  You scored {Math.abs(benchmarkDelta)} points {benchmarkDelta >= 0 ? "above" : "below"} the platform average of {avgScore}/40.
                </div>
                {myResponse.flags.length > 0 && (
                  <div className="flag-alert">
                    ⚠ {myResponse.flags.map(f => f.replace(/_/g, " ")).join(", ")}
                  </div>
                )}
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <h3 className="card-title">Benchmarking</h3>
                <div className="benchmark-grid">
                  <div><span>Your Score</span><strong>{myResponse.totalScore}/40</strong></div>
                  <div><span>Average</span><strong>{avgScore}/40</strong></div>
                  <div><span>Rank</span><strong>#{myRank}</strong></div>
                  <div><span>Percentile</span><strong>{percentile}%</strong></div>
                </div>
              </div>

              <div className="card">
                <h3 className="card-title">AI Evaluation</h3>
                <div className="feedback-list">
                  {(myResponse.aiEvaluation?.feedback?.length ? myResponse.aiEvaluation.feedback : ["No AI feedback was stored for this response."]).map(item => (
                    <div key={item} className="feedback-item">{item}</div>
                  ))}
                </div>
                <div className="eval-source">Source: {myResponse.evaluationSource.replace(/_/g, " ")}</div>
              </div>
            </div>

            <div className="card">
              <h3 className="card-title">My Submitted Answers</h3>
              <div className="answers-list">
                {[
                  { label: "Section A - Audit Prompt Design", val: myResponse.answers.sectionA },
                  { label: "Section B - Excel/CSV Prompt", val: myResponse.answers.promptUsed },
                  { label: "Section B - AI Output Format", val: myResponse.answers.claudeOutput },
                  { label: "Section B - Validation and Improvements", val: myResponse.answers.candidateImprovements },
                  { label: "Section C - AI Output Review", val: myResponse.answers.sectionC },
                  { label: "Section D - Repaired Prompt", val: myResponse.answers.sectionD },
                  { label: "Section E - Client Deliverable Prompt", val: myResponse.answers.sectionE },
                ].map(a => (
                  <div key={a.label} className="answer-item">
                    <div className="answer-label">{a.label}</div>
                    <div className="answer-text">{a.val}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <h3>No Assessment Submitted</h3>
            <p>You haven't taken the assessment yet. Complete it to see your AI skills score and ranking.</p>
            <button className="btn-primary" onClick={() => setView("assessment")}>Begin Assessment</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ASSESSMENT PAGE ──────────────────────────────────────────────────────
function AssessmentPage({ db, currentUser, setView, notify, logout }) {
  const existing = db.responses.find(r => r.userId === currentUser.id);
  const [section, setSection] = useState(0);
  const [timer, setTimer] = useState(30 * 60);
  const [answers, setAnswers] = useState(EMPTY_ANSWERS);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const autosaveRef = useRef(null);
  const draftLoadedRef = useRef(false);
  const answersRef = useRef(answers);
  const responsesRef = useRef(db.responses);

  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  useEffect(() => {
    responsesRef.current = db.responses;
  }, [db.responses]);

  useEffect(() => {
    if (existing) { setView("candidate_dashboard"); return; }
    if (draftLoadedRef.current) return;
    draftLoadedRef.current = true;
    const saved = localStorage.getItem(`assessment_draft_${currentUser.id}`);
    if (saved) {
      try {
        setAnswers(a => ({ ...a, ...JSON.parse(saved) }));
      } catch {
        localStorage.removeItem(`assessment_draft_${currentUser.id}`);
      }
    }
  }, [existing, currentUser.id, setView]);

  useEffect(() => {
    autosaveRef.current = setInterval(() => {
      setSaving(true);
      localStorage.setItem(`assessment_draft_${currentUser.id}`, JSON.stringify(answers));
      setTimeout(() => setSaving(false), 1000);
    }, 30000);
    return () => clearInterval(autosaveRef.current);
  }, [answers]);

  useEffect(() => {
    const t = setInterval(() => setTimer(s => { if (s <= 1) { clearInterval(t); handleSubmit(); return 0; } return s - 1; }), 1000);
    return () => clearInterval(t);
  }, []);

  const set = k => e => setAnswers(a => ({ ...a, [k]: e.target.value }));
  const blockPaste = e => {
    e.preventDefault();
    notify("Pasting is disabled during the assessment.", "error");
  };
  const textareaSecurityProps = {
    onPaste: blockPaste,
    onDrop: blockPaste,
    onContextMenu: e => e.preventDefault(),
    autoComplete: "off",
    spellCheck: false,
  };
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const handleSubmit = async () => {
    if (submitted || submitting) return;
    const currentAnswers = answersRef.current;
    const missing = ANSWER_FIELDS.filter(field => !currentAnswers[field].trim());
    if (missing.length) return notify("Complete every section before submitting.", "error");

    setSubmitting(true);
    try {
      const integrity = analyzeIntegrity(currentAnswers, responsesRef.current, currentUser.id);
      const aiEvaluation = await evaluateAssessmentWithAI(currentAnswers, integrity.flags);
      const response = {
        userId: currentUser.id,
        answers: currentAnswers,
        scores: aiEvaluation.scores,
        totalScore: aiEvaluation.totalScore,
        skillLevel: aiEvaluation.skillLevel,
        flags: uniqueList([...integrity.flags, ...aiEvaluation.flags]),
        integritySignals: integrity.signals,
        aiEvaluation: {
          feedback: aiEvaluation.feedback,
          qualitySignals: aiEvaluation.qualitySignals,
        },
        evaluationSource: aiEvaluation.source,
        submittedAt: serverTimestamp(),
        submittedAtIso: new Date().toISOString(),
      };

      await addDoc(collection(firestore, "responses"), response);
      localStorage.removeItem(`assessment_draft_${currentUser.id}`);
      setSubmitted(true);
      notify(aiEvaluation.source === "openai" ? "Assessment submitted and AI-scored." : "Assessment submitted with fallback scoring.");
      setTimeout(() => setView("candidate_dashboard"), 2500);
    } catch (error) {
      notify(error.message || "Could not submit assessment.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const sections = [
    { label: "Audit Prompt", icon: "1" },
    { label: "Excel Workflow", icon: "2" },
    { label: "AI Review", icon: "3" },
    { label: "Prompt Repair", icon: "4" },
    { label: "Client Deliverable", icon: "5" },
  ];

  if (submitted) return (
    <div className="auth-page"><div className="auth-card" style={{ textAlign: "center" }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>🎉</div>
      <h2 className="auth-title">Submitted!</h2>
      <p className="auth-sub">Your assessment has been scored. Redirecting…</p>
    </div></div>
  );

  return (
    <div className="main-layout">
      <Sidebar role="candidate" current="assessment" setView={setView} logout={logout} user={currentUser} />
      <div className="content-area">
        <div className="page-header">
          <div>
            <h2 className="page-title">AI Skills Assessment</h2>
            <p className="page-sub">Section {section + 1} of 5 • {saving ? "Autosaving…" : "All changes saved"}</p>
          </div>
          <div className="assessment-controls">
            <div className={`timer ${timer < 300 ? "timer-urgent" : ""}`}>⏱ {fmt(timer)}</div>
          </div>
        </div>

        {/* Section Navigator */}
        <div className="section-nav">
          {sections.map((s, i) => (
            <button key={i} className={`section-pill ${i === section ? "active" : i < section ? "done" : ""}`}
              onClick={() => setSection(i)}>
              <span>{s.icon}</span> {s.label}
            </button>
          ))}
        </div>

        {/* Section Content */}
        <div className="assessment-card">
          {section === 0 && (
            <AssessmentSection
              title="Section A: Audit Prompt Design" score="10 pts"
              desc="Write one professional prompt for an AI assistant to review a client's trial balance and financial statements for audit risk. The prompt must define the CA role, required documents, materiality threshold, checks to perform, and the exact output format expected for audit working papers."
              field="sectionA" val={answers.sectionA} set={set("sectionA")}
              textareaProps={textareaSecurityProps}
              placeholder="Act as an Indian statutory audit manager. Review the attached trial balance, ledger extract, and financial statements. Check revenue cut-off, unusual journals, related parties, GST/TDS exposures, ageing, material variances... Return a table with Issue | Evidence | Amount | Risk | Audit Procedure | Client Query."
              minLen={450}
            />
          )}
          {section === 1 && (
            <div>
              <div className="section-header">
                <h3 className="section-title">Section B: Excel and File Workflow <span className="pts-badge">20 marks</span></h3>
                <div className="section-desc">
                  <p><strong>Scenario:</strong> You are given two files: 1. Sales Register (Excel) 2. GSTR-1 data (CSV).</p>
                  <p><strong>Task:</strong> Explain how you would use an AI tool, such as Claude, along with Excel/CSV data to reconcile these records and identify mismatches.</p>
                  <p><strong>Note:</strong> Focus on practical workflow. No coding required.</p>
                </div>
              </div>
              {[
                ["1. Prompt You Would Use", "promptUsed", "Write the exact prompt you would give to the AI to analyze the files. Include fields to compare such as invoice number, date, GSTIN, taxable value, and tax amount."],
                ["2. Expected Output Format", "claudeOutput", "Describe or show how the AI should return results. Example: a table or CSV with columns like Invoice No, Issue Type, Difference Amount, and Remarks."],
                ["3. Validation Steps and Final Deliverable", "candidateImprovements", "Explain how you would verify the AI output using Excel, such as formulas, filters, pivot tables, and cross-checking totals. Then explain how you would convert the AI output into a usable report for audit or GST reconciliation."],
              ].map(([lbl, key, ph]) => (
                <div className="form-group" key={key}>
                  <label>{lbl}</label>
                  <textarea className="form-textarea" rows={6} value={answers[key]}
                    onChange={set(key)} placeholder={ph} {...textareaSecurityProps} />
                </div>
              ))}
            </div>
          )}
          {section === 2 && (
            <AssessmentSection
              title="Section C: Review AI Output Quality" score="10 pts"
              desc={<>Review the AI output below as if you are signing off a working paper. Identify what is wrong, what evidence is missing, and what follow-up instructions you would give before relying on it.<br /><br /><div className="sample-output">"Sales increased by 18% and expenses look normal. GST seems mostly fine. A few invoices may need checking. Overall, there is no major issue, but the client should confirm the numbers."</div></>}
              field="sectionC" val={answers.sectionC} set={set("sectionC")}
              textareaProps={textareaSecurityProps}
              placeholder="This output is not sufficient because it does not cite source files, invoice IDs, materiality, exception amounts, formulas used, or audit procedures. I would ask the AI to..."
              minLen={350}
            />
          )}
          {section === 3 && (
            <div>
              <div className="section-header">
                <h3 className="section-title">Section D: Prompt Repair <span className="pts-badge">Bonus</span></h3>
                <p className="section-desc">Rewrite the weak prompt into a specific CA-grade instruction. It must mention input files, checks, expected format, exclusions, and how exceptions should be prioritised.</p>
              </div>
              <div className="sample-output weak">
                <strong>Weak Prompt:</strong> "Check my GST and Excel file and tell me if anything is wrong."
              </div>
              <div className="form-group">
                <label>Your Improved Prompt</label>
                <textarea className="form-textarea" rows={8} value={answers.sectionD}
                  onChange={set("sectionD")}
                  placeholder="Act as a GST reconciliation specialist. Use sales_register.xlsx, GSTR-1.csv, and GSTR-3B.pdf. Match by GSTIN, invoice number, date, taxable value, CGST/SGST/IGST. Flag mismatches above Rs 5,000 or 2%, duplicates, missing invoices, invalid GSTINs, and date-format issues. Return a table plus a CSV-ready exception list..."
                  {...textareaSecurityProps} />
              </div>
            </div>
          )}
          {section === 4 && (
            <AssessmentSection
              title="Section E: Client Deliverable Prompt" score="Synthesis"
              desc="Your client is a manufacturing company with Rs 12Cr turnover. Write a prompt that makes AI produce a client-ready GST and audit deliverable. It should include a checklist, Excel-ready reconciliation table, source-document assumptions, and a short management summary."
              field="sectionE" val={answers.sectionE} set={set("sectionE")}
              textareaProps={textareaSecurityProps}
              placeholder="Prepare a professional deliverable for a manufacturing client. Inputs: purchase register, sales register, GSTR-1, GSTR-3B, E-way bill data, fixed asset additions, and previous-year audit points. Output: management summary, compliance checklist, Excel-ready exception table, responsible owner, due date, risk rating, and evidence required."
              minLen={500}
            />
          )}
        </div>

        {/* Navigation Buttons */}
        <div className="assessment-nav">
          <button className="btn-outline" onClick={() => setSection(s => Math.max(0, s - 1))} disabled={section === 0}>
            ← Previous
          </button>
          <div className="progress-dots">
            {sections.map((_, i) => <div key={i} className={`dot ${i === section ? "active" : i < section ? "done" : ""}`} />)}
          </div>
          {section < 4 ? (
            <button className="btn-primary" onClick={() => setSection(s => s + 1)}>Next →</button>
          ) : (
            <button className="btn-submit" onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Scoring…" : "Submit Assessment ✓"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AssessmentSection({ title, score, desc, field, val, set, placeholder, minLen, textareaProps = {} }) {
  const pct = Math.min(100, Math.round((val.length / minLen) * 100));
  return (
    <div>
      <div className="section-header">
        <h3 className="section-title">{title} <span className="pts-badge">{score}</span></h3>
        <p className="section-desc">{desc}</p>
      </div>
      <div className="form-group">
        <label>Your Response</label>
        <textarea className="form-textarea" rows={9} value={val} onChange={set} placeholder={placeholder} {...textareaProps} />
        <div className="char-indicator">
          <div className="char-bar" style={{ width: `${pct}%`, background: pct >= 100 ? "#22c55e" : "#f59e0b" }} />
        </div>
        <span className="char-count">{val.length} chars {pct < 100 ? `(aim for ${minLen}+)` : "✓ Good length"}</span>
      </div>
    </div>
  );
}

// ─── ADMIN DASHBOARD ──────────────────────────────────────────────────────
function AdminDashboard({ db, currentUser, logout, notify }) {
  const [tab, setTab] = useState("overview");
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [filters, setFilters] = useState({ domain: "All", experience: "All", aiUsage: "All" });
  const [scoringModal, setScoringModal] = useState(null);

  const responses = db.responses;
  const candidates = db.users.filter(u => u.role === "candidate");
  const avgScore = responses.length ? Math.round(responses.reduce((a, r) => a + r.totalScore, 0) / responses.length) : 0;
  const ranked = [...responses].sort((a, b) => b.totalScore - a.totalScore);
  const topTenCount = ranked.length ? Math.max(1, Math.ceil(ranked.length * 0.1)) : 0;
  const topTen = ranked.slice(0, topTenCount);
  const commonMistakes = getCommonMistakes(responses);

  const skillDist = { Beginner: 0, Intermediate: 0, Advanced: 0 };
  responses.forEach(r => { if (skillDist[r.skillLevel] !== undefined) skillDist[r.skillLevel]++; });

  const applyScores = async (responseId, scores) => {
    const total = scores.promptScore + scores.taskScore + scores.evaluationScore;
    const skillLevel = getSkillLevel(total);
    try {
      await updateDoc(doc(firestore, "responses", responseId), {
        scores,
        totalScore: total,
        skillLevel,
        evaluationSource: "admin_override",
        reviewedBy: currentUser.id,
        reviewedAt: serverTimestamp(),
      });
      notify("Scores saved successfully!");
      setScoringModal(null);
    } catch (error) {
      notify(error.message || "Could not save scores.", "error");
    }
  };

  const filteredResponses = ranked.filter(r => {
    const user = db.users.find(u => u.id === r.userId);
    if (!user) return false;
    if (filters.domain !== "All" && user.domain !== filters.domain) return false;
    if (filters.experience !== "All" && user.experience !== filters.experience) return false;
    if (filters.aiUsage !== "All" && user.aiUsage !== filters.aiUsage) return false;
    return true;
  });

  return (
    <div className="main-layout">
      <Sidebar role="admin" current={tab} setView={setTab} logout={logout} user={currentUser} />
      <div className="content-area">

        {/* Scoring Modal */}
        {scoringModal && (
          <ScoringModal
            response={scoringModal}
            user={db.users.find(u => u.id === scoringModal.userId)}
            onSave={applyScores}
            onClose={() => setScoringModal(null)}
          />
        )}

        {/* Candidate Detail Panel */}
        {selectedCandidate && (
          <CandidateDetailPanel
            response={selectedCandidate}
            user={db.users.find(u => u.id === selectedCandidate.userId)}
            onScore={() => setScoringModal(selectedCandidate)}
            onClose={() => setSelectedCandidate(null)}
          />
        )}

        {/* Overview Tab */}
        {tab === "overview" && (
          <>
            <div className="page-header">
              <div>
                <h2 className="page-title">Admin Dashboard</h2>
                <p className="page-sub">AI Skills Assessment Analytics</p>
              </div>
              <div className="header-badge">Admin</div>
            </div>

            <div className="stats-grid">
              {[
                { label: "Total Candidates", value: candidates.length, icon: "👥", color: "blue" },
                { label: "Submissions", value: responses.length, icon: "📋", color: "purple" },
                { label: "Average Score", value: avgScore + "/40", icon: "📊", color: "accent" },
                { label: "Flagged", value: responses.filter(r => r.flags.length > 0).length, icon: "⚠", color: "red" },
              ].map(s => (
                <div key={s.label} className={`stat-card stat-${s.color}`}>
                  <div className="stat-icon">{s.icon}</div>
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value">{s.value}</div>
                </div>
              ))}
            </div>

            <div className="card">
              <h3 className="card-title">Admin Insights</h3>
              <div className="insight-grid">
                <div className="insight-panel">
                  <div className="insight-kicker">Top 10% Candidates</div>
                  <div className="insight-value">{topTen.length || 0}</div>
                  <div className="insight-body">
                    {topTen.length
                      ? topTen.map(r => db.users.find(u => u.id === r.userId)?.name || "Unknown").join(", ")
                      : "No submissions yet"}
                  </div>
                </div>
                <div className="insight-panel">
                  <div className="insight-kicker">Most Common Mistakes</div>
                  <div className="mistake-list">
                    {commonMistakes.length
                      ? commonMistakes.map(item => <span key={item.label}>{item.label} ({item.count})</span>)
                      : <span>No recurring issues yet</span>}
                  </div>
                </div>
                <div className="insight-panel">
                  <div className="insight-kicker">Benchmark</div>
                  <div className="insight-value">{avgScore}/40</div>
                  <div className="insight-body">Average candidate score across all submitted assessments.</div>
                </div>
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <h3 className="card-title">Top Performers</h3>
                <BarChart data={ranked.slice(0, 5).map(r => ({
                  label: db.users.find(u => u.id === r.userId)?.name?.split(" ")[0] || "?",
                  value: r.totalScore, max: 40
                }))} />
              </div>
              <div className="card">
                <h3 className="card-title">Skill Distribution</h3>
                <PieChart data={[
                  { label: "Beginner", value: skillDist.Beginner, color: "#ef4444" },
                  { label: "Intermediate", value: skillDist.Intermediate, color: "#f59e0b" },
                  { label: "Advanced", value: skillDist.Advanced, color: "#22c55e" },
                ]} />
              </div>
            </div>

            <div className="card">
              <h3 className="card-title">Score Distribution</h3>
              <Histogram data={responses.map(r => r.totalScore)} />
            </div>
          </>
        )}

        {/* Candidates Tab */}
        {tab === "candidates" && (
          <>
            <div className="page-header">
              <div>
                <h2 className="page-title">Candidate Evaluation</h2>
                <p className="page-sub">{filteredResponses.length} submissions</p>
              </div>
            </div>

            <div className="filter-bar">
              {[
                { key: "domain", opts: ["All", "Audit", "Tax", "Advisory"] },
                { key: "experience", opts: ["All", "< 1 year", "1-3 years", "3-5 years", "5+ years"] },
                { key: "aiUsage", opts: ["All", "Beginner", "Intermediate", "Advanced"] },
              ].map(f => (
                <select key={f.key} className="filter-select"
                  value={filters[f.key]} onChange={e => setFilters(flt => ({ ...flt, [f.key]: e.target.value }))}>
                  {f.opts.map(o => <option key={o}>{o}</option>)}
                </select>
              ))}
            </div>

            <div className="candidate-list">
              {filteredResponses.map((r, i) => {
                const user = db.users.find(u => u.id === r.userId);
                return (
                  <div key={r.id} className="candidate-row" onClick={() => setSelectedCandidate(r)}>
                    <div className="rank-num">#{i + 1}</div>
                    <div className="candidate-info">
                      <div className="candidate-name">{user?.name || "Unknown"}</div>
                      <div className="candidate-meta">{user?.domain} • {user?.experience} • {user?.aiUsage}</div>
                    </div>
                    <div className="candidate-scores">
                      <span className="score-chip">P:{r.scores.promptScore}/10</span>
                      <span className="score-chip">T:{r.scores.taskScore}/20</span>
                      <span className="score-chip">E:{r.scores.evaluationScore}/10</span>
                    </div>
                    <div className={`skill-badge skill-${r.skillLevel.toLowerCase()}`}>{r.skillLevel}</div>
                    <div className="total-score">{r.totalScore}<span>/40</span></div>
                    {r.flags.length > 0 && <div className="flag-chip">⚠ {r.flags.length}</div>}
                    <button className="btn-score" onClick={e => { e.stopPropagation(); setScoringModal(r); }}>Score</button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Leaderboard Tab */}
        {tab === "leaderboard" && (
          <>
            <div className="page-header">
              <div><h2 className="page-title">Leaderboard</h2><p className="page-sub">Ranked by total score</p></div>
            </div>
            <div className="leaderboard">
              {ranked.map((r, i) => {
                const user = db.users.find(u => u.id === r.userId);
                return (
                  <div key={r.id} className={`leaderboard-row rank-${i + 1}`}>
                    <div className="lb-rank">{i < 3 ? ["🥇", "🥈", "🥉"][i] : `#${i + 1}`}</div>
                    <div className="lb-avatar">{user?.name?.[0] || "?"}</div>
                    <div className="lb-info">
                      <div className="lb-name">{user?.name}</div>
                      <div className="lb-meta">{user?.domain} • {user?.experience}</div>
                    </div>
                    <div className={`skill-badge skill-${r.skillLevel.toLowerCase()}`}>{r.skillLevel}</div>
                    <div className="lb-score">
                      <div className="lb-score-bar" style={{ width: `${(r.totalScore / 40) * 100}%` }} />
                      <span>{r.totalScore}/40</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Scoring Modal ─────────────────────────────────────────────────────────
function ScoringModal({ response, user, onSave, onClose }) {
  const [scores, setScores] = useState({ ...response.scores });
  const total = scores.promptScore + scores.taskScore + scores.evaluationScore;
  const set = k => e => setScores(s => ({ ...s, [k]: Math.max(0, Math.min(Number(e.target.value), k === "taskScore" ? 20 : 10)) }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Score: {user?.name}</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {[
            { label: "Prompt Engineering Score", key: "promptScore", max: 10 },
            { label: "Task Submission Score", key: "taskScore", max: 20 },
            { label: "Output Evaluation Score", key: "evaluationScore", max: 10 },
          ].map(f => (
            <div key={f.key} className="score-input-row">
              <label>{f.label} <span className="max-hint">/ {f.max}</span></label>
              <div className="score-input-wrap">
                <input type="range" min="0" max={f.max} value={scores[f.key]} onChange={set(f.key)} className="score-range" />
                <input type="number" min="0" max={f.max} value={scores[f.key]} onChange={set(f.key)} className="score-num" />
              </div>
            </div>
          ))}
          <div className="total-preview">
            <span>Total Score</span>
            <span className="total-num">{total} / 40</span>
            <span className={`skill-badge skill-${(total < 16 ? "beginner" : total < 28 ? "intermediate" : "advanced")}`}>
              {total < 16 ? "Beginner" : total < 28 ? "Intermediate" : "Advanced"}
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => onSave(response.id, scores)}>Save Scores</button>
        </div>
      </div>
    </div>
  );
}

// ─── Candidate Detail Panel ────────────────────────────────────────────────
function CandidateDetailPanel({ response, user, onScore, onClose }) {
  const answers = [
    ["Section A - Audit Prompt Design", response.answers.sectionA],
    ["Section B - Excel/CSV Prompt", response.answers.promptUsed],
    ["Section B - AI Output Format", response.answers.claudeOutput],
    ["Section B - Validation and Improvements", response.answers.candidateImprovements],
    ["Section C - AI Output Review", response.answers.sectionC],
    ["Section D - Repaired Prompt", response.answers.sectionD],
    ["Section E - Client Deliverable Prompt", response.answers.sectionE],
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{user?.name}'s Submission</h3>
            <div className="modal-sub">{user?.domain} • {user?.experience} • {user?.aiUsage}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary sm" onClick={onScore}>Score</button>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body scrollable">
          <div className="score-chips-row">
            <span>Prompt: {response.scores.promptScore}/10</span>
            <span>Task: {response.scores.taskScore}/20</span>
            <span>Eval: {response.scores.evaluationScore}/10</span>
            <span className="total-chip">Total: {response.totalScore}/40</span>
            <span className={`skill-badge skill-${response.skillLevel.toLowerCase()}`}>{response.skillLevel}</span>
            <span>Source: {response.evaluationSource.replace(/_/g, " ")}</span>
            {response.flags.map(f => <span key={f} className="flag-chip">⚠ {f.replace(/_/g, " ")}</span>)}
          </div>
          {response.integritySignals.length > 0 && (
            <div className="answer-item">
              <div className="answer-label">Integrity Signals</div>
              <div className="signal-list">
                {response.integritySignals.map((signal, i) => (
                  <span key={`${signal.type}-${i}`}>
                    {signal.type.replace(/_/g, " ")} • {signal.field} • {signal.similarity}% match
                  </span>
                ))}
              </div>
            </div>
          )}
          {response.aiEvaluation?.feedback?.length > 0 && (
            <div className="answer-item">
              <div className="answer-label">AI Feedback</div>
              <div className="feedback-list">
                {response.aiEvaluation.feedback.map(item => <div key={item} className="feedback-item">{item}</div>)}
              </div>
            </div>
          )}
          {answers.map(([lbl, val]) => (
            <div key={lbl} className="answer-item">
              <div className="answer-label">{lbl}</div>
              <div className="answer-text">{val || <em style={{ opacity: 0.4 }}>No response</em>}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────
function Sidebar({ role, current, setView, logout, user }) {
  const candidateLinks = [
    { id: "candidate_dashboard", label: "Dashboard", icon: "⊞" },
    { id: "assessment", label: "Assessment", icon: "✎" },
  ];
  const adminLinks = [
    { id: "overview", label: "Overview", icon: "⊞" },
    { id: "candidates", label: "Candidates", icon: "👥" },
    { id: "leaderboard", label: "Leaderboard", icon: "🏆" },
  ];
  const links = role === "admin" ? adminLinks : candidateLinks;

  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon sm">CA</div>
        <div>
          <div className="sidebar-brand">AI Skills</div>
          <div className="sidebar-sub">Assessment</div>
        </div>
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
          <div>
            <div className="user-name">{user?.name}</div>
            <div className="user-role">{user?.role}</div>
          </div>
        </div>
        <button className="logout-btn" onClick={logout}>↩</button>
      </div>
    </div>
  );
}

// ─── CHART COMPONENTS ──────────────────────────────────────────────────────
function BarChart({ data }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div className="bar-chart">
      {data.map((d, i) => (
        <div key={i} className="bar-item">
          <div className="bar-wrap">
            <div className="bar-fill" style={{ height: `${(d.value / 40) * 100}%` }}>
              <span className="bar-val">{d.value}</span>
            </div>
          </div>
          <div className="bar-label">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

function PieChart({ data }) {
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  let cum = 0;
  const slices = data.map(d => {
    const pct = d.value / total;
    const start = cum;
    cum += pct;
    return { ...d, start, pct };
  });

  const slice = (start, pct, color) => {
    const r = 80, cx = 100, cy = 100;
    const a1 = (start * 360 - 90) * Math.PI / 180;
    const a2 = ((start + pct) * 360 - 90) * Math.PI / 180;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const large = pct > 0.5 ? 1 : 0;
    return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`;
  };

  return (
    <div className="pie-chart-wrap">
      <svg viewBox="0 0 200 200" className="pie-svg">
        {slices.map((s, i) => s.pct > 0 && (
          <path key={i} d={slice(s.start, s.pct, s.color)} fill={s.color} opacity={0.85} />
        ))}
        <circle cx="100" cy="100" r="50" fill="var(--card)" />
        <text x="100" y="105" textAnchor="middle" fontSize="20" fill="var(--text)" fontWeight="700">{total}</text>
      </svg>
      <div className="pie-legend">
        {data.map(d => (
          <div key={d.label} className="legend-item">
            <div className="legend-dot" style={{ background: d.color }} />
            <span>{d.label}</span>
            <span className="legend-val">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Histogram({ data }) {
  if (!data.length) return <div className="empty-chart">No data yet</div>;
  const buckets = [0, 8, 16, 24, 32, 40];
  const counts = buckets.slice(0, -1).map((b, i) => ({
    label: `${b}–${buckets[i + 1]}`,
    count: data.filter(v => v >= b && v < buckets[i + 1]).length
  }));
  const max = Math.max(...counts.map(c => c.count), 1);
  return (
    <div className="histogram">
      {counts.map((b, i) => (
        <div key={i} className="hist-col">
          <div className="hist-bar-wrap">
            <div className="hist-bar" style={{ height: `${(b.count / max) * 100}%` }}>
              {b.count > 0 && <span className="hist-val">{b.count}</span>}
            </div>
          </div>
          <div className="hist-label">{b.label}</div>
        </div>
      ))}
    </div>
  );
}

function PercentileRing({ score, max }) {
  const pct = score / max;
  const r = 54, cx = 70, cy = 70;
  const circ = 2 * Math.PI * r;
  const dash = pct * circ;
  return (
    <div className="ring-wrap">
      <svg viewBox="0 0 140 140" className="ring-svg">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth="12" />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--accent)" strokeWidth="12"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`} />
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize="22" fontWeight="800" fill="var(--text)">{score}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize="10" fill="var(--muted)">out of {max}</text>
      </svg>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function skillColor(level) {
  return { Beginner: "red", Intermediate: "yellow", Advanced: "green" }[level] || "blue";
}

function getCommonMistakes(responses) {
  const counts = new Map();
  const add = label => counts.set(label, (counts.get(label) || 0) + 1);

  responses.forEach(response => {
    response.flags.forEach(flag => add(flag.replace(/_/g, " ")));
    if (response.scores.promptScore < 6) add("weak prompt structure");
    if (response.scores.taskScore < 10) add("thin Excel or AI workflow evidence");
    if (response.scores.evaluationScore < 6) add("shallow output critique");
  });

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, count]) => ({ label, count }));
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function printCandidateReport(user, response, avgScore, rank, totalCandidates) {
  const feedback = response.aiEvaluation?.feedback?.length
    ? response.aiEvaluation.feedback.map(item => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>No AI feedback stored.</li>";
  const report = window.open("", "_blank", "width=900,height=1200");
  if (!report) return;

  report.document.write(`
    <html>
      <head>
        <title>${escapeHtml(user.name)} - AI Skills Report</title>
        <style>
          body { font-family: Arial, sans-serif; color: #111827; padding: 40px; line-height: 1.5; }
          h1 { margin: 0 0 4px; font-size: 28px; }
          h2 { margin-top: 28px; font-size: 16px; text-transform: uppercase; letter-spacing: .08em; color: #173b63; }
          .muted { color: #6b7280; }
          .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 24px 0; }
          .box { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
          .label { font-size: 11px; text-transform: uppercase; color: #6b7280; margin-bottom: 6px; }
          .value { font-size: 24px; font-weight: 800; }
          pre { white-space: pre-wrap; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; font-size: 13px; }
          @media print { button { display: none; } body { padding: 24px; } }
        </style>
      </head>
      <body>
        <button onclick="window.print()">Print / Save as PDF</button>
        <h1>AI Skills Assessment Report</h1>
        <div class="muted">${escapeHtml(user.name)} • ${escapeHtml(user.email)} • ${escapeHtml(user.domain)} • ${escapeHtml(user.experience)}</div>
        <div class="grid">
          <div class="box"><div class="label">Total Score</div><div class="value">${response.totalScore}/40</div></div>
          <div class="box"><div class="label">Skill Level</div><div class="value">${escapeHtml(response.skillLevel)}</div></div>
          <div class="box"><div class="label">Rank</div><div class="value">#${rank || "-"}/${totalCandidates || "-"}</div></div>
          <div class="box"><div class="label">Average</div><div class="value">${avgScore}/40</div></div>
        </div>
        <h2>Score Breakdown</h2>
        <p>Prompt Engineering: ${response.scores.promptScore}/10<br />Task Submission: ${response.scores.taskScore}/20<br />Output Evaluation: ${response.scores.evaluationScore}/10</p>
        <h2>Evaluator Feedback</h2>
        <ul>${feedback}</ul>
        <h2>Flags</h2>
        <p>${response.flags.length ? escapeHtml(response.flags.map(flag => flag.replace(/_/g, " ")).join(", ")) : "No integrity flags."}</p>
        <h2>Submitted Prompt</h2>
        <pre>${escapeHtml(response.answers.sectionA)}</pre>
      </body>
    </html>
  `);
  report.document.close();
  report.focus();
  report.print();
}

// ─── CSS ───────────────────────────────────────────────────────────────────
function CSS() {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #f5f7fb;
      --surface: #ffffff;
      --card: #ffffff;
      --subtle: #f8fafc;
      --border: #d9e1ec;
      --border-strong: #b7c3d4;
      --text: #142033;
      --muted: #66758a;
      --accent: #173b63;
      --accent2: #2f5f8f;
      --green: #1f7a4d;
      --red: #b42318;
      --yellow: #a15c07;
      --blue: #245b91;
      --shadow: 0 12px 30px rgba(20, 32, 51, 0.08);
    }

    body { background: var(--bg); color: var(--text); font-family: 'Source Sans 3', sans-serif; font-size: 16px; }
    .app-root { min-height: 100vh; background: var(--bg); }

    /* Toast */
    .toast { position: fixed; top: 20px; right: 20px; z-index: 9999; padding: 14px 20px; border-radius: 12px; display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; box-shadow: 0 8px 32px rgba(0,0,0,0.3); animation: slideIn .3s ease; }
    .toast-success { background: #166534; color: #bbf7d0; border: 1px solid #22c55e40; }
    .toast-error { background: #7f1d1d; color: #fecaca; border: 1px solid #ef444440; }
    .toast-info { background: #1e3a8a; color: #bfdbfe; border: 1px solid #3b82f640; }
    @keyframes slideIn { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    /* AUTH PAGES */
    .auth-page { min-height: 100vh; display: flex; align-items: stretch; background: var(--bg); }
    .auth-card { width: 480px; min-width: 380px; padding: 48px 40px; display: flex; flex-direction: column; gap: 18px; background: var(--surface); border-right: 1px solid var(--border); justify-content: center; }
    .auth-card.wide { width: 560px; }
    .auth-logo { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
    .logo-icon { width: 48px; height: 48px; border-radius: 10px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; color: #fff; letter-spacing: 1px; }
    .logo-icon.sm { width: 36px; height: 36px; font-size: 11px; border-radius: 10px; flex-shrink: 0; }
    .auth-title { font-size: 26px; font-weight: 800; color: var(--text); letter-spacing: -0.02em; }
    .auth-sub { font-size: 14px; color: var(--muted); margin-top: 2px; font-family: 'IBM Plex Mono', monospace; }

    .auth-hero { flex: 1; padding: 60px; display: flex; flex-direction: column; justify-content: center; background: #eef3f8; position: relative; overflow: hidden; border-left: 1px solid var(--border); }
    .auth-hero::before { display: none; }
    .hero-stats { display: flex; gap: 32px; margin-bottom: 40px; }
    .hero-stat-val { font-size: 36px; font-weight: 800; color: var(--accent); }
    .hero-stat-lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-top: 2px; }
    .hero-heading { font-size: 42px; font-weight: 800; line-height: 1.15; margin-bottom: 16px; letter-spacing: -0.03em; }
    .hero-body { font-size: 17px; line-height: 1.7; color: var(--muted); max-width: 520px; margin-bottom: 32px; }
    .hero-tags { display: flex; flex-wrap: wrap; gap: 8px; }
    .hero-tag { padding: 6px 14px; border-radius: 999px; background: #ffffff; border: 1px solid var(--border); font-size: 13px; color: var(--accent); font-weight: 700; }

    /* Forms */
    .form-group { display: flex; flex-direction: column; gap: 8px; }
    .form-group label { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .form-input { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; color: var(--text); font-size: 16px; font-family: 'Source Sans 3', sans-serif; transition: border .2s, box-shadow .2s; outline: none; }
    .form-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(23,59,99,0.12); }
    .form-textarea { background: #fff; border: 1px solid var(--border-strong); border-radius: 8px; padding: 18px; color: var(--text); font-size: 17px; font-family: 'Source Sans 3', sans-serif; resize: vertical; outline: none; transition: border .2s, box-shadow .2s; line-height: 1.65; min-height: 180px; }
    .form-textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(23,59,99,0.12); }
    .form-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }

    /* Buttons */
    .btn-primary { padding: 12px 22px; background: var(--accent); color: #fff; border: 1px solid var(--accent); border-radius: 8px; font-weight: 800; font-size: 15px; cursor: pointer; font-family: 'Source Sans 3', sans-serif; display: flex; align-items: center; justify-content: center; gap: 8px; transition: background .2s, transform .1s; }
    .btn-primary:hover { opacity: .9; transform: translateY(-1px); }
    .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    .btn-primary.sm { padding: 8px 16px; font-size: 14px; }
    .btn-outline { padding: 11px 20px; border: 1px solid var(--border-strong); background: #fff; color: var(--accent); border-radius: 8px; font-weight: 800; font-size: 15px; cursor: pointer; font-family: 'Source Sans 3', sans-serif; transition: background .2s, border-color .2s; }
    .btn-outline:hover { background: #eef3f8; border-color: var(--accent); }
    .btn-outline.sm { padding: 7px 14px; font-size: 13px; }
    .btn-submit { padding: 13px 28px; background: var(--green); color: #fff; border: 1px solid var(--green); border-radius: 8px; font-weight: 800; font-size: 15px; cursor: pointer; font-family: 'Source Sans 3', sans-serif; }
    .btn-submit:disabled { opacity: .6; cursor: not-allowed; }
    .btn-score { padding: 6px 14px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-size: 13px; font-weight: 800; cursor: pointer; font-family: 'Source Sans 3', sans-serif; white-space: nowrap; }

    /* Spinner */
    .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
    .spinner.dark { border-color: rgba(99,102,241,.2); border-top-color: var(--accent); margin: 0 auto; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Divider */
    .divider { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }

    /* Demo buttons */
    .demo-grid { display: flex; flex-direction: column; gap: 8px; }
    .demo-btn { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 11px 16px; cursor: pointer; display: flex; align-items: center; gap: 12px; font-family: 'Source Sans 3', sans-serif; color: var(--text); font-size: 14px; text-align: left; transition: border-color .2s; }
    .demo-btn:hover { border-color: var(--accent); }
    .demo-email { color: var(--muted); font-family: 'IBM Plex Mono', monospace; font-size: 12px; }
    .role-badge { padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .role-badge.candidate { background: #eef3f8; color: var(--accent); }
    .role-badge.admin { background: #fff1f0; color: var(--red); }
    .auth-note, .setup-box { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 14px; color: var(--muted); font-size: 12px; line-height: 1.7; }
    .auth-note code, .setup-box code { color: var(--accent); font-family: 'IBM Plex Mono', monospace; font-size: 11px; }
    .setup-box { display: flex; flex-direction: column; gap: 8px; }

    /* Auth link */
    .auth-link { text-align: center; font-size: 13px; color: var(--muted); }
    .auth-link button { background: none; border: none; color: var(--accent); cursor: pointer; font-family: 'Source Sans 3', sans-serif; font-weight: 800; }
    .back-btn { background: none; border: none; color: var(--accent); cursor: pointer; font-family: 'Source Sans 3', sans-serif; font-size: 14px; font-weight: 800; align-self: flex-start; }

    /* MAIN LAYOUT */
    .main-layout { display: flex; min-height: 100vh; background: var(--bg); }

    /* Sidebar */
    .sidebar { width: 260px; min-height: 100vh; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 22px 0; position: sticky; top: 0; height: 100vh; }
    .sidebar-logo { display: flex; align-items: center; gap: 12px; padding: 0 20px 24px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
    .sidebar-brand { font-size: 18px; font-weight: 800; color: var(--text); letter-spacing: -0.01em; }
    .sidebar-sub { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
    .sidebar-nav { flex: 1; padding: 0 12px; display: flex; flex-direction: column; gap: 4px; }
    .nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 8px; border: none; background: transparent; color: var(--muted); font-family: 'Source Sans 3', sans-serif; font-size: 16px; font-weight: 700; cursor: pointer; text-align: left; transition: all .2s; }
    .nav-item:hover { background: #eef3f8; color: var(--text); }
    .nav-item.active { background: #e8f0f8; color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
    .nav-icon { font-size: 15px; width: 20px; text-align: center; }
    .sidebar-footer { padding: 16px 16px 0; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 10px; margin-top: 8px; }
    .sidebar-user { flex: 1; display: flex; align-items: center; gap: 10px; overflow: hidden; }
    .user-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; color: #fff; flex-shrink: 0; }
    .user-name { font-size: 14px; font-weight: 800; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .user-role { font-size: 11px; color: var(--muted); text-transform: uppercase; }
    .logout-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 18px; padding: 4px; }

    /* Content */
    .content-area { flex: 1; width: min(100%, 1280px); max-width: 1280px; margin: 0 auto; padding: 38px 42px 56px; overflow-y: auto; }
    .page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 28px; }
    .page-title { font-size: 34px; font-weight: 800; color: var(--text); letter-spacing: -0.03em; line-height: 1.1; }
    .page-sub { font-size: 16px; color: var(--muted); margin-top: 6px; }
    .header-badge { padding: 6px 16px; background: rgba(239,68,68,.15); color: var(--red); border-radius: 20px; font-size: 12px; font-weight: 700; border: 1px solid rgba(239,68,68,.3); }

    /* Stats Grid */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; position: relative; overflow: hidden; box-shadow: var(--shadow); }
    .stat-card::before { content: ''; position: absolute; top: 0; left: 0; bottom: 0; width: 4px; }
    .stat-accent::before { background: var(--accent); }
    .stat-blue::before { background: var(--blue); }
    .stat-purple::before { background: var(--accent2); }
    .stat-red::before { background: var(--red); }
    .stat-green::before { background: var(--green); }
    .stat-yellow::before { background: var(--yellow); }
    .stat-label { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 800; margin-bottom: 8px; }
    .stat-value { font-size: 32px; font-weight: 800; color: var(--text); letter-spacing: -0.03em; }
    .stat-icon { font-size: 22px; margin-bottom: 8px; }

    /* Cards */
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: var(--shadow); }
    .card-title { font-size: 16px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); margin-bottom: 20px; }
    .two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin-bottom: 20px; }

    /* Score bars */
    .score-bars { display: flex; flex-direction: column; gap: 16px; }
    .score-bar-row { display: flex; flex-direction: column; gap: 6px; }
    .score-bar-label { display: flex; justify-content: space-between; font-size: 15px; color: var(--text); font-weight: 700; }
    .score-bar-track { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; }
    .score-bar-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width .8s ease; }

    /* Answers */
    .answers-list { display: flex; flex-direction: column; gap: 16px; }
    .answer-item { background: var(--subtle); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
    .answer-label { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); font-weight: 800; margin-bottom: 10px; }
    .answer-text { font-size: 15px; color: var(--text); line-height: 1.7; font-family: 'IBM Plex Mono', monospace; white-space: pre-wrap; }

    /* Empty state */
    .empty-state { text-align: center; padding: 80px 40px; }
    .empty-icon { font-size: 56px; margin-bottom: 16px; }
    .empty-state h3 { font-size: 20px; font-weight: 800; margin-bottom: 8px; }
    .empty-state p { color: var(--muted); font-size: 14px; margin-bottom: 24px; max-width: 400px; margin-left: auto; margin-right: auto; line-height: 1.7; }

    /* Assessment */
    .section-nav { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
    .section-pill { padding: 10px 16px; border-radius: 999px; border: 1px solid var(--border-strong); background: #fff; color: var(--muted); font-family: 'Source Sans 3', sans-serif; font-size: 15px; font-weight: 800; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all .2s; }
    .section-pill:hover { border-color: var(--accent); color: var(--accent); }
    .section-pill.active { background: var(--accent); border-color: var(--accent); color: #fff; }
    .section-pill.done { border-color: #b7d5c7; color: var(--green); background: #edf7f2; }

    .assessment-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 34px; margin-bottom: 20px; box-shadow: var(--shadow); }
    .section-header { margin-bottom: 28px; max-width: 980px; }
    .section-title { font-size: 26px; font-weight: 800; color: var(--text); display: flex; align-items: center; gap: 12px; margin-bottom: 12px; letter-spacing: -0.02em; }
    .pts-badge { background: #eef3f8; color: var(--accent); padding: 4px 11px; border-radius: 999px; font-size: 13px; font-weight: 800; border: 1px solid var(--border); }
    .section-desc { font-size: 18px; color: var(--text); line-height: 1.65; }

    .sample-output { background: #f8fafc; border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin-bottom: 20px; font-family: 'IBM Plex Mono', monospace; font-size: 15px; color: var(--text); line-height: 1.7; border-left: 4px solid var(--accent); }
    .sample-output.weak { border-left-color: var(--red); }

    .char-indicator { height: 3px; background: var(--border); border-radius: 2px; margin-top: 8px; overflow: hidden; }
    .char-bar { height: 100%; border-radius: 2px; transition: width .3s; }
    .char-count { font-size: 13px; color: var(--muted); margin-top: 6px; font-family: 'IBM Plex Mono', monospace; }

    .assessment-nav { display: flex; align-items: center; justify-content: space-between; }
    .progress-dots { display: flex; gap: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); transition: all .2s; }
    .dot.active { background: var(--accent); transform: scale(1.3); }
    .dot.done { background: var(--green); }

    .assessment-controls { display: flex; gap: 12px; align-items: center; }
    .timer { font-family: 'IBM Plex Mono', monospace; font-size: 18px; font-weight: 700; color: var(--text); background: var(--card); border: 1px solid var(--border); padding: 8px 16px; border-radius: 10px; }
    .timer.timer-urgent { color: var(--red); border-color: var(--red); animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .6; } }

    /* Flag alert */
    .flag-alert { background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.3); border-radius: 10px; padding: 10px 14px; font-size: 12px; color: var(--yellow); margin-top: 12px; }
    .benchmark-note { color: var(--muted); font-size: 12px; text-align: center; line-height: 1.6; margin-top: 8px; }
    .benchmark-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .benchmark-grid div { background: var(--subtle); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
    .benchmark-grid span { display: block; color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; font-weight: 800; }
    .benchmark-grid strong { color: var(--text); font-size: 24px; font-family: 'IBM Plex Mono', monospace; }
    .feedback-list { display: flex; flex-direction: column; gap: 8px; }
    .feedback-item { background: var(--subtle); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; color: var(--text); font-size: 15px; line-height: 1.6; }
    .eval-source { margin-top: 12px; color: var(--muted); font-size: 12px; font-family: 'IBM Plex Mono', monospace; text-transform: uppercase; }
    .signal-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .signal-list span { background: #fff7ed; border: 1px solid #fed7aa; color: var(--yellow); border-radius: 8px; padding: 6px 8px; font-size: 12px; font-family: 'IBM Plex Mono', monospace; }

    /* Ring */
    .ring-wrap { display: flex; justify-content: center; }
    .ring-svg { width: 140px; height: 140px; }

    /* Percentile */
    .pie-chart-wrap { display: flex; align-items: center; gap: 24px; }
    .pie-svg { width: 160px; height: 160px; flex-shrink: 0; }
    .pie-legend { display: flex; flex-direction: column; gap: 12px; }
    .legend-item { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text); font-weight: 600; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .legend-val { margin-left: auto; background: var(--subtle); padding: 2px 8px; border-radius: 6px; font-size: 12px; }

    /* Bar Chart */
    .bar-chart { display: flex; align-items: flex-end; gap: 12px; height: 160px; }
    .bar-item { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; }
    .bar-wrap { flex: 1; display: flex; align-items: flex-end; width: 100%; justify-content: center; }
    .bar-fill { width: 100%; max-width: 40px; background: var(--accent); border-radius: 6px 6px 0 0; display: flex; align-items: flex-start; justify-content: center; padding-top: 6px; transition: height .6s ease; min-height: 4px; }
    .bar-val { font-size: 11px; font-weight: 700; color: #fff; }
    .bar-label { font-size: 11px; color: var(--muted); margin-top: 6px; font-weight: 600; }

    /* Histogram */
    .histogram { display: flex; gap: 8px; height: 120px; align-items: flex-end; }
    .hist-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; }
    .hist-bar-wrap { flex: 1; display: flex; align-items: flex-end; width: 100%; }
    .hist-bar { width: 100%; background: var(--blue); border-radius: 4px 4px 0 0; display: flex; align-items: flex-start; justify-content: center; padding-top: 4px; min-height: 4px; transition: height .6s; }
    .hist-val { font-size: 10px; color: #fff; font-weight: 700; }
    .hist-label { font-size: 11px; color: var(--muted); margin-top: 4px; font-family: 'IBM Plex Mono', monospace; }
    .empty-chart { color: var(--muted); font-size: 13px; text-align: center; padding: 40px; }

    /* Admin */
    .filter-bar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .filter-select { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; color: var(--text); font-family: 'Source Sans 3', sans-serif; font-size: 15px; font-weight: 700; cursor: pointer; outline: none; }
    .insight-grid { display: grid; grid-template-columns: 1fr 1.4fr 1fr; gap: 14px; }
    .insight-panel { background: var(--subtle); border: 1px solid var(--border); border-radius: 12px; padding: 16px; min-height: 128px; }
    .insight-kicker { color: var(--accent); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 10px; }
    .insight-value { color: var(--text); font-size: 32px; font-weight: 800; font-family: 'IBM Plex Mono', monospace; margin-bottom: 8px; }
    .insight-body { color: var(--muted); font-size: 14px; line-height: 1.6; }
    .mistake-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .mistake-list span { background: rgba(239,68,68,.1); color: var(--red); border: 1px solid rgba(239,68,68,.25); border-radius: 999px; padding: 6px 10px; font-size: 11px; font-weight: 700; }

    .candidate-list { display: flex; flex-direction: column; gap: 8px; }
    .candidate-row { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; display: flex; align-items: center; gap: 16px; cursor: pointer; transition: border-color .2s, transform .15s; box-shadow: 0 4px 18px rgba(20, 32, 51, 0.05); }
    .candidate-row:hover { border-color: var(--accent); transform: translateY(-1px); }
    .rank-num { width: 28px; font-size: 13px; font-weight: 800; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
    .candidate-info { flex: 1; min-width: 0; }
    .candidate-name { font-size: 16px; font-weight: 800; color: var(--text); }
    .candidate-meta { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .candidate-scores { display: flex; gap: 6px; }
    .score-chip { background: var(--subtle); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; font-size: 12px; font-weight: 700; font-family: 'IBM Plex Mono', monospace; color: var(--text); }
    .total-score { font-size: 20px; font-weight: 800; color: var(--text); min-width: 52px; text-align: right; }
    .total-score span { font-size: 12px; color: var(--muted); }
    .flag-chip { background: rgba(245,158,11,.15); color: var(--yellow); border: 1px solid rgba(245,158,11,.3); border-radius: 6px; padding: 3px 8px; font-size: 11px; font-weight: 700; white-space: nowrap; }

    /* Skill Badges */
    .skill-badge { padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 800; border: 1px solid; }
    .skill-beginner { background: rgba(239,68,68,.1); color: var(--red); border-color: rgba(239,68,68,.3); }
    .skill-intermediate { background: rgba(245,158,11,.1); color: var(--yellow); border-color: rgba(245,158,11,.3); }
    .skill-advanced { background: rgba(34,197,94,.1); color: var(--green); border-color: rgba(34,197,94,.3); }

    /* Leaderboard */
    .leaderboard { display: flex; flex-direction: column; gap: 10px; }
    .leaderboard-row { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px 24px; display: flex; align-items: center; gap: 16px; transition: transform .15s; }
    .leaderboard-row:hover { transform: translateX(4px); }
    .leaderboard-row.rank-1 { border-color: #f59e0b; background: rgba(245,158,11,.05); }
    .leaderboard-row.rank-2 { border-color: #9ca3af; background: rgba(156,163,175,.05); }
    .leaderboard-row.rank-3 { border-color: #b45309; background: rgba(180,83,9,.05); }
    .lb-rank { font-size: 24px; width: 36px; text-align: center; }
    .lb-avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 16px; color: #fff; flex-shrink: 0; }
    .lb-info { flex: 1; }
    .lb-name { font-size: 16px; font-weight: 800; color: var(--text); }
    .lb-meta { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .lb-score { display: flex; align-items: center; gap: 12px; min-width: 160px; }
    .lb-score-bar { height: 6px; background: var(--accent); border-radius: 3px; }
    .lb-score span { font-size: 16px; font-weight: 800; color: var(--text); font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }

    /* Modal */
    .modal-overlay { position: fixed; inset: 0; background: rgba(20,32,51,.48); z-index: 999; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; width: 520px; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; }
    .modal.modal-wide { width: 720px; }
    .modal-header { padding: 24px 24px 0; display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    .modal-header h3 { font-size: 22px; font-weight: 800; color: var(--text); }
    .modal-sub { font-size: 14px; color: var(--muted); margin-top: 3px; }
    .modal-body { padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; flex: 1; }
    .modal-body.scrollable { overflow-y: auto; max-height: calc(90vh - 130px); }
    .modal-footer { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; gap: 10px; justify-content: flex-end; }
    .close-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 20px; line-height: 1; padding: 4px; }

    .score-input-row { display: flex; flex-direction: column; gap: 8px; }
    .score-input-row label { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); display: flex; align-items: center; gap: 8px; }
    .max-hint { color: var(--border); font-size: 11px; }
    .score-input-wrap { display: flex; align-items: center; gap: 12px; }
    .score-range { flex: 1; accent-color: var(--accent); cursor: pointer; height: 4px; }
    .score-num { width: 60px; background: var(--subtle); border: 1px solid var(--border); border-radius: 8px; padding: 8px; color: var(--text); font-family: 'IBM Plex Mono', monospace; font-size: 16px; font-weight: 700; text-align: center; outline: none; }
    .total-preview { background: var(--subtle); border-radius: 10px; padding: 16px; display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .total-preview span:first-child { flex: 1; font-size: 14px; font-weight: 700; color: var(--muted); }
    .total-num { font-size: 24px; font-weight: 800; color: var(--text); font-family: 'IBM Plex Mono', monospace; }
    .total-chip { background: #eef3f8; color: var(--accent); border: 1px solid var(--border); padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 800; }
    .score-chips-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
    .score-chips-row span { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--muted); }

    /* Responsive */
    @media (max-width: 900px) {
      .auth-hero { display: none; }
      .auth-card { width: 100%; min-width: unset; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .two-col { grid-template-columns: 1fr; }
      .content-area { padding: 20px; max-width: 100vw; }
      .sidebar { width: 60px; padding: 16px 0; }
      .sidebar-logo, .sidebar-brand, .sidebar-sub, .user-name, .user-role, .sidebar-sub { display: none; }
      .nav-item { justify-content: center; padding: 12px; font-size: 0; }
      .nav-icon { font-size: 16px; }
      .form-row { grid-template-columns: 1fr; }
      .candidate-scores { display: none; }
      .insight-grid, .benchmark-grid { grid-template-columns: 1fr; }
      .section-title { font-size: 23px; align-items: flex-start; flex-direction: column; }
      .section-desc { font-size: 17px; }
    }
  `;
}

export default App;
