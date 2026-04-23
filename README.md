# AI Skills Assessment

React + Firebase assessment platform with Firebase Auth, Firestore storage, OpenAI-assisted scoring, integrity checks, admin insights, benchmarking, and printable candidate reports.

## Setup

1. Create a Firebase project.
2. Enable Authentication with Email/Password.
3. Create Firestore in production mode.
4. Add the values from `.env.example` to a local `.env` file and to Vercel project environment variables.
5. Add `OPENAI_API_KEY` in Vercel for `/api/evaluate`.
6. Deploy Firestore rules from `firestore.rules`.

## Run

```bash
npm install
npm run dev
```

`npm run dev` runs the React client. Use Vercel dev or deploy to Vercel for the `/api/evaluate` serverless OpenAI route; if that route is unavailable, the app falls back to local heuristic scoring.

## Admin Users

Signup creates candidate accounts only. To create an admin, create a Firebase Auth user and set the matching Firestore document at `users/{uid}` with `role: "admin"`.
