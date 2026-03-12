# Operations Log — AI Plant Log Digitizer

An AI-powered web app that photographs handwritten plant operation log sheets and digitizes them into structured, searchable records stored in Firebase Firestore.

---

## Features

- **AI extraction** via Google Gemini 2.5 Flash — reads handwritten tables, ETP readings, meter values, and pond parameters
- **Inline verification** — review and correct every extracted field before saving
- **Firebase Firestore** — per-user cloud database, auto-scales to any team size
- **Anonymous auth** — no sign-up required; each device gets a unique secure identity
- **CSV export** — download any log as a spreadsheet
- **Responsive** — works on mobile for on-site capture and desktop for review
- **Config guard** — app shows a clear setup screen if any env var is missing

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 18 | https://nodejs.org |
| npm | ≥ 9 | bundled with Node |

---

## Quick Start

```bash
# 1. Clone / unzip the project
cd ops-logbook

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# → edit .env with your API keys (see below)

# 4. Start dev server
npm run dev
# → opens http://localhost:3000
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in each value:

### Google Gemini API Key

1. Go to https://aistudio.google.com/app/apikey
2. Click **Create API key**
3. Paste into `VITE_GEMINI_API_KEY`

### Firebase (Firestore database)

1. Go to https://console.firebase.google.com
2. **Create a new project** (or use an existing one)
3. Add a **Web app** (the `</>` icon)
4. Copy the config object values into your `.env`

**Required Firebase setup steps:**
- In **Authentication → Sign-in method**, enable **Anonymous**
- In **Firestore Database**, click **Create database** (choose a region close to your users, start in **production mode**)
- Deploy security rules: `npx firebase deploy --only firestore:rules` (see below)

---

## Firestore Security Rules

The included `firestore.rules` ensures each user can only access their own reports. Deploy them with:

```bash
# Install Firebase CLI (once)
npm install -g firebase-tools

# Login
firebase login

# Set your project
firebase use YOUR_PROJECT_ID

# Deploy rules
firebase deploy --only firestore:rules
```

---

## Build for Production

```bash
npm run build
# Output is in ./dist/
```

---

## Deployment Options

### Option A — Firebase Hosting (recommended, free tier generous)

```bash
npm install -g firebase-tools
firebase login
firebase use YOUR_PROJECT_ID
npm run build
firebase deploy --only hosting
```

Your app is live at `https://YOUR_PROJECT_ID.web.app`

---

### Option B — Vercel (zero-config)

1. Push the project to a GitHub/GitLab/Bitbucket repo
2. Go to https://vercel.com → **New Project** → import the repo
3. Vercel auto-detects Vite
4. Go to **Settings → Environment Variables** and add all vars from `.env`
5. **Deploy**

Your app is live at `https://your-project.vercel.app`

---

### Option C — Netlify

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Build and deploy
npm run build
netlify deploy --prod --dir dist
```

Set environment variables in Netlify dashboard → **Site Settings → Environment variables**.

---

### Option D — Self-hosted (nginx / VPS)

```bash
npm run build
# Upload ./dist to your server
# Configure nginx to serve index.html for all routes:
```

```nginx
server {
  listen 80;
  root /var/www/ops-logbook/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

---

## Data Architecture

```
Firestore
└── artifacts/
    └── {APP_ID}/
        └── users/
            └── {userId}/           ← per-user namespace (anonymous uid)
                └── reports/
                    └── {reportId}  ← one document per log sheet
```

All data is scoped per-user. Anonymous users get a stable uid tied to their browser. If you want persistent accounts across devices, swap `signInAnonymously` for email/password or Google Sign-In in `src/App.jsx`.

---

## Project Structure

```
ops-logbook/
├── public/
│   └── favicon.svg
├── src/
│   ├── firebase.js     ← Firebase init + env var loading
│   ├── App.jsx         ← Main application
│   ├── main.jsx        ← React entry point
│   └── index.css       ← Tailwind + custom animations
├── .env.example        ← Template — copy to .env
├── .gitignore
├── firebase.json       ← Firebase Hosting + Firestore rules config
├── firestore.rules     ← Firestore security rules
├── vercel.json         ← Vercel SPA routing config
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── package.json
```

---

## Customization

### Change extraction schema
Edit `RESPONSE_SCHEMA` in `src/App.jsx` and the corresponding field sections in the verify form.

### Add user accounts
Replace the `signInAnonymously` call in the `useEffect` with your preferred Firebase auth provider.

### Add more plants to production table
The schema uses a dynamic array — any plant name extracted by Gemini will appear automatically.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Config banner on load | Missing `.env` vars | Copy `.env.example` → `.env`, restart dev server |
| "Gemini API error 400" | Invalid API key | Check `VITE_GEMINI_API_KEY` in `.env` |
| "Save failed: permission-denied" | Firestore rules not deployed or Anonymous auth not enabled | Deploy `firestore.rules`; enable Anonymous auth in Firebase console |
| Blank history after reload | Anon auth generates a new uid on some browsers | Expected — anon uid is stable per browser session but resets if storage is cleared |
| Build fails: "cannot find module" | Missing deps | Run `npm install` |

---

## License

MIT — use freely for internal plant operations tooling.
