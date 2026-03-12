import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Upload, FileText, AlertCircle, Download, Loader2, Camera,
  Edit3, Save, Trash2, Droplets, Zap, Activity, History,
  Calendar, Cloud, CheckCircle2, ChevronRight, ClipboardList, Waves,
  RefreshCw, LogIn, WifiOff
} from 'lucide-react';
import {
  signInAnonymously, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, onAuthStateChanged, signOut
} from 'firebase/auth';
import {
  collection, doc, setDoc, getDocs, deleteDoc,
  query, orderBy, limit, serverTimestamp
} from 'firebase/firestore';
import { auth, db, APP_ID, GEMINI_API_KEY } from './firebase.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
  });

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    metadata: {
      type: 'OBJECT',
      properties: {
        date:           { type: 'STRING' },
        shift:          { type: 'STRING' },
        report_made_by: { type: 'STRING' },
      },
    },
    etp_pyro: {
      type: 'OBJECT',
      properties: {
        treated_water:    { type: 'STRING' },
        etp_of:           { type: 'STRING' },
        feed_water_to_ro: { type: 'STRING' },
      },
    },
    etp_hydro: {
      type: 'OBJECT',
      properties: {
        ect:      { type: 'STRING' },
        ect_level: { type: 'STRING' },
        rw_hydro: { type: 'STRING' },
      },
    },
    production_table: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          plant:         { type: 'STRING' },
          feed:          { type: 'STRING' },
          production:    { type: 'STRING' },
          reject:        { type: 'STRING' },
          running_hours: { type: 'STRING' },
        },
      },
    },
    meter_readings: {
      type: 'OBJECT',
      properties: {
        ro_reject_meter:             { type: 'STRING' },
        cpp_bd_meter:                { type: 'STRING' },
        reject_to_pond:              { type: 'STRING' },
        hydro_ro_reject_to_etp_pyro: { type: 'STRING' },
        pond_to_etp:                 { type: 'STRING' },
      },
    },
    cpp_bd_breakdown: {
      type: 'OBJECT',
      properties: {
        etp:    { type: 'STRING' },
        biliya: { type: 'STRING' },
        total:  { type: 'STRING' },
      },
    },
    incoming_flows: {
      type: 'OBJECT',
      properties: {
        sw_i_to_etp:     { type: 'STRING' },
        sw_ii_to_etp:    { type: 'STRING' },
        slf_water:       { type: 'STRING' },
        delution_water:  { type: 'STRING' },
        zld_feed:        { type: 'STRING' },
      },
    },
    pond_parameters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          pond:      { type: 'STRING' },
          parameter: { type: 'STRING' },
          value:     { type: 'STRING' },
        },
      },
    },
  },
};

const EMPTY_DATA = {
  metadata:        { date: '', shift: '', report_made_by: '' },
  etp_pyro:        { treated_water: '', etp_of: '', feed_water_to_ro: '' },
  etp_hydro:       { ect: '', ect_level: '', rw_hydro: '' },
  production_table: [],
  meter_readings:  { ro_reject_meter: '', cpp_bd_meter: '', reject_to_pond: '', hydro_ro_reject_to_etp_pyro: '', pond_to_etp: '' },
  cpp_bd_breakdown: { etp: '', biliya: '', total: '' },
  incoming_flows:  { sw_i_to_etp: '', sw_ii_to_etp: '', slf_water: '', delution_water: '', zld_feed: '' },
  pond_parameters: [],
};

const merge = (base, incoming) => ({
  ...base,
  ...incoming,
  metadata:         { ...base.metadata,         ...incoming?.metadata         },
  etp_pyro:         { ...base.etp_pyro,         ...incoming?.etp_pyro         },
  etp_hydro:        { ...base.etp_hydro,        ...incoming?.etp_hydro        },
  meter_readings:   { ...base.meter_readings,   ...incoming?.meter_readings   },
  cpp_bd_breakdown: { ...base.cpp_bd_breakdown, ...incoming?.cpp_bd_breakdown },
  incoming_flows:   { ...base.incoming_flows,   ...incoming?.incoming_flows   },
  production_table:  incoming?.production_table  ?? [],
  pond_parameters:   incoming?.pond_parameters   ?? [],
});

// ─── Firestore helpers ───────────────────────────────────────────────────────

const reportsPath = (uid) =>
  collection(db, 'artifacts', APP_ID, 'users', uid, 'reports');

const saveReport = async (uid, data) => {
  const reportDate = data.metadata?.date?.replace(/\//g, '-') || 'unknown';
  const docId = `report_${reportDate}_${Date.now()}`;
  const ref = doc(reportsPath(uid), docId);
  await setDoc(ref, {
    ...data,
    _id: docId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docId;
};

const fetchReports = async (uid) => {
  const q = query(reportsPath(uid), orderBy('createdAt', 'desc'), limit(100));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
};

const deleteReport = async (uid, docId) => {
  await deleteDoc(doc(reportsPath(uid), docId));
};

// ─── Gemini AI extraction ────────────────────────────────────────────────────

const extractWithGemini = async (base64Data, mimeType) => {
  if (!GEMINI_API_KEY) {
    throw new Error('VITE_GEMINI_API_KEY is not set in .env');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: `You are a specialist in plant operation logs.
Extract ALL information from the log sheet image.
Pay special attention to handwritten numbers, including small notes like "Pond to ETP: 146".
Ensure the production table is extracted unit by unit (RO-1, RO-2, RO-3, PYRO, RO-4, ZLD, Hydro).
If a value is illegible or missing, return an empty string "".`,
        }],
      },
      contents: [{
        role: 'user',
        parts: [
          { text: 'Extract every field from this plant operation log sheet.' },
          { inlineData: { mimeType, data: base64Data } },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini API error ${res.status}`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return JSON.parse(text);
};

// ─── ConfigBanner – shown when env vars are missing ─────────────────────────

const ConfigBanner = () => (
  <div className="fixed inset-0 bg-slate-900 flex items-center justify-center z-50 p-6">
    <div className="bg-white rounded-[40px] p-10 max-w-lg w-full shadow-2xl border-4 border-yellow-300">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-14 h-14 bg-yellow-100 rounded-2xl flex items-center justify-center">
          <AlertCircle className="text-yellow-600" size={28} />
        </div>
        <h2 className="text-2xl font-black text-slate-800">Setup Required</h2>
      </div>
      <p className="text-slate-600 font-medium mb-6 leading-relaxed">
        Create a <code className="bg-slate-100 px-2 py-0.5 rounded font-mono text-sm">.env</code> file
        in the project root with the following variables:
      </p>
      <pre className="bg-slate-900 text-green-400 p-5 rounded-2xl text-xs overflow-x-auto font-mono leading-relaxed">
{`VITE_GEMINI_API_KEY=...
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...`}
      </pre>
      <p className="text-slate-500 text-sm mt-5 font-medium">
        See <code className="bg-slate-100 px-1 rounded font-mono">.env.example</code> for details.
        Restart the dev server after editing.
      </p>
    </div>
  </div>
);

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab,      setActiveTab]      = useState('upload');
  const [previewUrl,     setPreviewUrl]     = useState(null);
  const [isProcessing,   setIsProcessing]   = useState(false);
  const [isSaving,       setIsSaving]       = useState(false);
  const [isLoadingHist,  setIsLoadingHist]  = useState(false);
  const [error,          setError]          = useState(null);
  const [successMsg,     setSuccessMsg]     = useState(null);
  const [user,           setUser]           = useState(null);
  const [authReady,      setAuthReady]      = useState(false);
  const [extractedData,  setExtractedData]  = useState(null);
  const [savedReports,   setSavedReports]   = useState([]);
  const [deleteConfirm,  setDeleteConfirm]  = useState(null);

  const fileInputRef = useRef(null);

  const configMissing = !import.meta.env.VITE_FIREBASE_API_KEY || !import.meta.env.VITE_GEMINI_API_KEY;

  // ── Auth ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        try { await signInAnonymously(auth); }
        catch (e) { console.error('Anon sign-in failed:', e); }
      } else {
        setUser(u);
        setAuthReady(true);
      }
    });
    return unsub;
  }, []);

  // ── History loader ────────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    if (!user) return;
    setIsLoadingHist(true);
    try {
      const reports = await fetchReports(user.uid);
      setSavedReports(reports);
    } catch (e) {
      console.error(e);
      setError('Failed to load history from Firestore.');
    } finally {
      setIsLoadingHist(false);
    }
  }, [user]);

  useEffect(() => {
    if (activeTab === 'history' && user) loadHistory();
  }, [activeTab, user, loadHistory]);

  // ── Toast helpers ─────────────────────────────────────────────────────────
  const toast = (msg, isError = false) => {
    if (isError) setError(msg);
    else setSuccessMsg(msg);
    setTimeout(() => { setError(null); setSuccessMsg(null); }, 3500);
  };

  // ── AI extraction ─────────────────────────────────────────────────────────
  const handleFile = async (file) => {
    if (!file) return;
    setPreviewUrl(URL.createObjectURL(file));
    setIsProcessing(true);
    setError(null);
    try {
      const base64 = await fileToBase64(file);
      const parsed = await extractWithGemini(base64, file.type);
      setExtractedData(merge(EMPTY_DATA, parsed));
      setActiveTab('verify');
    } catch (e) {
      toast(e.message || 'AI extraction failed. Please retake the photo.', true);
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Save to Firestore ─────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!user || !extractedData) return;
    setIsSaving(true);
    try {
      await saveReport(user.uid, extractedData);
      toast('Plant log saved to database.');
      setTimeout(() => setActiveTab('history'), 1800);
    } catch (e) {
      toast('Save failed: ' + (e.message || 'unknown error'), true);
    } finally {
      setIsSaving(false);
    }
  };

  // ── Delete report ─────────────────────────────────────────────────────────
  const handleDelete = async (docId) => {
    if (!user) return;
    try {
      await deleteReport(user.uid, docId);
      setSavedReports(prev => prev.filter(r => r.id !== docId));
      toast('Report deleted.');
    } catch (e) {
      toast('Delete failed.', true);
    } finally {
      setDeleteConfirm(null);
    }
  };

  // ── CSV export ────────────────────────────────────────────────────────────
  const downloadCSV = () => {
    if (!extractedData) return;
    const rows = [['Section', 'Field', 'Value']];
    const { metadata: m, etp_pyro, etp_hydro, production_table,
            meter_readings, cpp_bd_breakdown, incoming_flows, pond_parameters } = extractedData;

    rows.push(['Metadata', 'Date',     m.date]);
    rows.push(['Metadata', 'Shift',    m.shift]);
    rows.push(['Metadata', 'Operator', m.report_made_by]);
    Object.entries(etp_pyro).forEach(([k, v]) =>
      rows.push(['ETP-PYRO', k.replace(/_/g, ' '), v]));
    Object.entries(etp_hydro).forEach(([k, v]) =>
      rows.push(['ETP-HYDRO', k.replace(/_/g, ' '), v]));
    production_table.forEach(p =>
      rows.push(['Production', p.plant, `Prod:${p.production} Feed:${p.feed} Reject:${p.reject} Hrs:${p.running_hours}`]));
    Object.entries(meter_readings).forEach(([k, v]) =>
      rows.push(['Meters', k.replace(/_/g, ' '), v]));
    Object.entries(cpp_bd_breakdown).forEach(([k, v]) =>
      rows.push(['CPP Breakdown', k, v]));
    Object.entries(incoming_flows).forEach(([k, v]) =>
      rows.push(['Incoming Flows', k.replace(/_/g, ' '), v]));
    pond_parameters.forEach(p =>
      rows.push(['Pond', `${p.pond} ${p.parameter}`, p.value]));

    const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Log_${m.date?.replace(/\//g, '-') || 'export'}.csv`;
    a.click();
  };

  // ── Field update helpers ──────────────────────────────────────────────────
  const updateNested = (section, field, val) =>
    setExtractedData(prev => ({ ...prev, [section]: { ...prev[section], [field]: val } }));

  const updateTable = (section, index, field, val) =>
    setExtractedData(prev => {
      const arr = [...prev[section]];
      arr[index] = { ...arr[index], [field]: val };
      return { ...prev, [section]: arr };
    });

  // ─── Render ───────────────────────────────────────────────────────────────
  if (configMissing) return <ConfigBanner />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-20">

      {/* Header */}
      <header className="bg-indigo-950 text-white px-6 md:px-8 py-4 flex items-center justify-between shadow-2xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <ClipboardList size={26} className="text-indigo-400" />
          <h1 className="text-lg md:text-xl font-black tracking-tighter uppercase">
            Operations <span className="text-indigo-400">Log</span>
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {!authReady && (
            <span className="text-indigo-300 text-xs font-bold flex items-center gap-1">
              <Loader2 size={14} className="animate-spin" /> Connecting…
            </span>
          )}
          <button
            onClick={() => setActiveTab('history')}
            className={`px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-colors ${
              activeTab === 'history' ? 'bg-white text-indigo-950' : 'hover:bg-white/10'
            }`}
          >
            <History size={16} /> Logs
          </button>
          <button
            onClick={() => { setActiveTab('upload'); setExtractedData(null); setPreviewUrl(null); setError(null); }}
            className="bg-indigo-600 hover:bg-indigo-500 px-5 py-2 rounded-xl text-sm font-bold shadow-lg transition-all"
          >
            + New Entry
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6">

        {/* Tab bar */}
        <div className="flex gap-2 mb-8 bg-white p-1.5 rounded-full w-fit shadow-lg border mx-auto mt-4">
          {['upload', 'verify', 'history'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              disabled={tab === 'verify' && !extractedData}
              className={`px-8 py-2 rounded-full text-[11px] font-black transition-all uppercase tracking-widest disabled:opacity-30 ${
                activeTab === tab
                  ? 'bg-indigo-600 text-white shadow-lg'
                  : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* ── UPLOAD TAB ── */}
        {activeTab === 'upload' && (
          <div className="max-w-2xl mx-auto mt-8">
            {!isProcessing ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="group border-4 border-dashed border-indigo-200 bg-white rounded-[48px] p-16 md:p-24 cursor-pointer hover:border-indigo-500 hover:bg-indigo-50/50 transition-all flex flex-col items-center gap-8 shadow-xl text-center"
              >
                <div className="w-28 h-28 md:w-32 md:h-32 bg-indigo-600 text-white rounded-[40px] flex items-center justify-center group-hover:scale-110 transition-transform shadow-2xl">
                  <Camera size={52} />
                </div>
                <div className="space-y-3">
                  <h2 className="text-3xl md:text-4xl font-black text-slate-800 tracking-tight">
                    Daily Log Upload
                  </h2>
                  <p className="text-slate-500 font-medium text-sm md:text-base">
                    Capture the operational log sheet. AI will digitize every parameter from ETP to Ponds.
                  </p>
                </div>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => handleFile(e.target.files?.[0])}
                  className="hidden"
                  accept="image/*"
                  capture="environment"
                />
                <button className="bg-indigo-950 text-white px-12 py-4 rounded-3xl font-black text-base shadow-xl active:scale-95 transition-transform">
                  Scan Sheet
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-8 py-24">
                <div className="relative">
                  <Loader2 className="animate-spin text-indigo-600" size={80} />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-12 h-12 bg-indigo-100 rounded-full" />
                  </div>
                </div>
                {previewUrl && (
                  <img
                    src={previewUrl}
                    alt="Scanning…"
                    className="w-48 h-48 object-cover rounded-3xl opacity-50 shadow-xl"
                  />
                )}
                <div className="text-center">
                  <h2 className="text-2xl font-black text-slate-800">Digitizing log sheet…</h2>
                  <p className="text-slate-500 font-medium mt-1 text-sm">
                    Extracting production metrics, ETP levels and meter readings.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <div className="mt-6 bg-red-50 text-red-600 p-6 rounded-[32px] border-2 border-red-100 flex items-start gap-4">
                <AlertCircle size={24} className="shrink-0 mt-0.5" />
                <p className="font-bold text-sm leading-relaxed">{error}</p>
              </div>
            )}

            {/* Help box */}
            <div className="mt-8 bg-indigo-50 rounded-[32px] p-6 border border-indigo-100">
              <h3 className="font-black text-indigo-800 mb-3 text-sm">Tips for best results</h3>
              <ul className="text-indigo-700 text-sm font-medium space-y-1.5">
                <li>• Ensure the sheet is fully in frame with no shadows</li>
                <li>• Hold the camera parallel to the sheet for less distortion</li>
                <li>• Use good lighting — avoid glare on laminated sheets</li>
                <li>• Both JPG and PNG are accepted</li>
              </ul>
            </div>
          </div>
        )}

        {/* ── VERIFY TAB ── */}
        {activeTab === 'verify' && extractedData && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">

            {/* Left: preview + hint */}
            <div className="lg:sticky lg:top-28 space-y-6">
              {previewUrl && (
                <div className="bg-white p-3 rounded-[36px] shadow-2xl border-4 border-white ring-1 ring-slate-200 overflow-hidden">
                  <img src={previewUrl} alt="Original" className="w-full h-auto rounded-3xl" />
                </div>
              )}
              <div className="bg-indigo-900 p-7 rounded-[36px] text-white shadow-xl flex gap-5 items-start">
                <Edit3 size={28} className="text-indigo-300 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-xl font-black mb-1">Verify & Correct</h3>
                  <p className="text-indigo-200 text-sm font-medium leading-snug">
                    Review all extracted values. Tap any field to edit. Confirm accuracy before committing to the database.
                  </p>
                </div>
              </div>
              <button
                onClick={downloadCSV}
                className="w-full bg-white border-2 border-slate-100 text-slate-700 py-4 rounded-[28px] font-black flex items-center justify-center gap-3 hover:border-indigo-500 hover:text-indigo-600 transition-all shadow-sm"
              >
                <Download size={20} /> Export as CSV
              </button>
            </div>

            {/* Right: editable form */}
            <div className="space-y-6 pb-36">

              {/* General */}
              <section className="bg-white rounded-[36px] p-7 shadow-sm border border-slate-100">
                <h3 className="text-[10px] font-black text-indigo-500 uppercase tracking-widest border-b pb-3 mb-5">
                  General Report Info
                </h3>
                <div className="grid grid-cols-3 gap-5">
                  {Object.entries(extractedData.metadata).map(([k, v]) => (
                    <div key={k}>
                      <label className="text-[10px] font-black text-slate-400 block mb-1.5 uppercase">
                        {k.replace(/_/g, ' ')}
                      </label>
                      <input
                        type="text"
                        value={v}
                        onChange={(e) => updateNested('metadata', k, e.target.value)}
                        className="w-full bg-slate-50 border-2 border-slate-100 rounded-xl px-3 py-2 font-bold text-slate-800 text-sm focus:border-indigo-400 transition-colors"
                      />
                    </div>
                  ))}
                </div>
              </section>

              {/* ETP Summary */}
              <section className="bg-white rounded-[36px] p-7 shadow-sm border border-slate-100">
                <h3 className="text-[10px] font-black text-indigo-500 uppercase tracking-widest border-b pb-3 mb-5 flex items-center gap-2">
                  <Droplets size={13} /> ETP Summary
                </h3>
                <div className="grid grid-cols-2 gap-8">
                  {[['etp_pyro', 'Pyro'], ['etp_hydro', 'Hydro']].map(([key, label]) => (
                    <div key={key} className="space-y-3">
                      <h4 className="text-xs font-black text-slate-400 border-l-4 border-indigo-200 pl-2 uppercase">{label}</h4>
                      {Object.entries(extractedData[key]).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-500 capitalize">{k.replace(/_/g, ' ')}</span>
                          <input
                            type="text"
                            value={v}
                            onChange={(e) => updateNested(key, k, e.target.value)}
                            className="w-24 text-right bg-slate-50 rounded-lg px-2 py-1 font-black text-indigo-600 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </section>

              {/* Production Table */}
              <section className="bg-white rounded-[36px] shadow-sm border border-slate-100 overflow-hidden">
                <div className="px-7 py-4 bg-slate-50 border-b flex items-center gap-2">
                  <Zap size={16} className="text-indigo-500" />
                  <h3 className="text-[10px] font-black text-slate-600 uppercase tracking-widest">Operational Data</h3>
                </div>
                {extractedData.production_table.length === 0 ? (
                  <p className="text-slate-400 text-sm font-medium text-center py-8">No production rows extracted.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead className="text-[10px] font-black text-slate-400 uppercase border-b bg-slate-50/50">
                        <tr>
                          {['Plant', 'Feed', 'Prod', 'Reject', 'Hrs'].map(h => (
                            <th key={h} className="px-4 py-3 first:pl-7">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {extractedData.production_table.map((row, idx) => (
                          <tr key={idx} className="hover:bg-indigo-50/20 transition-colors">
                            <td className="pl-7 pr-4 py-3 font-black text-slate-700 text-sm">{row.plant}</td>
                            {['feed', 'production', 'reject', 'running_hours'].map(field => (
                              <td key={field} className="px-4 py-3">
                                <input
                                  type="text"
                                  value={row[field]}
                                  onChange={(e) => updateTable('production_table', idx, field, e.target.value)}
                                  className="w-full bg-transparent border-b-2 border-transparent focus:border-indigo-400 text-center font-bold text-sm outline-none transition-colors"
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Meters & Flows */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <section className="bg-white rounded-[36px] p-7 shadow-sm border border-slate-100">
                  <h3 className="text-[10px] font-black text-indigo-500 uppercase tracking-widest border-b pb-3 mb-5">Meters & Notes</h3>
                  <div className="space-y-3">
                    {Object.entries(extractedData.meter_readings).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between border-b border-slate-50 pb-2">
                        <span className="text-xs font-bold text-slate-500 capitalize">{k.replace(/_/g, ' ')}</span>
                        <input
                          type="text"
                          value={v}
                          onChange={(e) => updateNested('meter_readings', k, e.target.value)}
                          className="w-28 text-right bg-slate-50 rounded-lg px-2 py-1 font-black text-indigo-700 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        />
                      </div>
                    ))}
                    <div className="pt-3 border-t-2 border-dashed border-slate-100">
                      <h4 className="text-[9px] font-black text-slate-400 uppercase mb-3">CPP B/D Breakdown</h4>
                      {Object.entries(extractedData.cpp_bd_breakdown).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between pb-1">
                          <span className="text-xs font-medium text-slate-500 capitalize">{k}</span>
                          <input
                            type="text"
                            value={v}
                            onChange={(e) => updateNested('cpp_bd_breakdown', k, e.target.value)}
                            className="w-20 text-right font-black text-slate-700 text-sm outline-none focus:border-b-2 focus:border-indigo-400"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="bg-white rounded-[36px] p-7 shadow-sm border border-slate-100">
                  <h3 className="text-[10px] font-black text-indigo-500 uppercase tracking-widest border-b pb-3 mb-5 flex items-center gap-2">
                    <Activity size={13} /> Incoming Flows
                  </h3>
                  <div className="space-y-3">
                    {Object.entries(extractedData.incoming_flows).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between border-b border-slate-50 pb-2">
                        <span className="text-xs font-bold text-slate-500 capitalize">{k.replace(/_/g, ' ')}</span>
                        <input
                          type="text"
                          value={v}
                          onChange={(e) => updateNested('incoming_flows', k, e.target.value)}
                          className="w-24 text-right bg-slate-50 rounded-lg px-2 py-1 font-black text-indigo-600 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        />
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              {/* Pond Parameters */}
              <section className="bg-white rounded-[36px] p-7 shadow-sm border border-slate-100">
                <h3 className="text-[10px] font-black text-indigo-500 uppercase tracking-widest border-b pb-3 mb-5 flex items-center gap-2">
                  <Waves size={13} /> Pond Parameters
                </h3>
                {extractedData.pond_parameters.length === 0 ? (
                  <p className="text-slate-400 text-sm font-medium text-center py-4">No pond parameters extracted.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-x-10 gap-y-4">
                    {extractedData.pond_parameters.map((p, idx) => (
                      <div key={idx} className="flex items-center justify-between border-b border-slate-50 pb-2">
                        <div>
                          <p className="text-xs font-black text-slate-800 leading-tight">{p.pond || 'Pond'}</p>
                          <p className="text-[9px] text-slate-400 uppercase font-black">{p.parameter || 'level'}</p>
                        </div>
                        <input
                          type="text"
                          value={p.value}
                          onChange={(e) => updateTable('pond_parameters', idx, 'value', e.target.value)}
                          className="w-20 text-right font-black text-indigo-600 text-sm outline-none focus:border-b-2 focus:border-indigo-400"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Sticky action bar */}
              <div className="flex gap-3 sticky bottom-6 p-3 bg-white/85 backdrop-blur-2xl border-2 border-white rounded-[40px] shadow-2xl ring-1 ring-slate-200 z-20">
                <button
                  onClick={() => { setExtractedData(null); setActiveTab('upload'); }}
                  className="flex-1 bg-slate-100 text-slate-500 py-5 rounded-[32px] font-black flex items-center justify-center gap-2 hover:bg-red-50 hover:text-red-500 transition-all text-sm"
                >
                  <Trash2 size={20} /> Discard
                </button>
                <button
                  onClick={handleSave}
                  disabled={isSaving || !user}
                  className="flex-[2] bg-indigo-950 text-white py-5 rounded-[32px] font-black flex items-center justify-center gap-3 hover:bg-black shadow-xl transition-all disabled:opacity-50 active:scale-95 text-sm"
                >
                  {isSaving
                    ? <><Loader2 size={20} className="animate-spin" /> Saving…</>
                    : <><Save size={20} /> Commit to Database</>
                  }
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── HISTORY TAB ── */}
        {activeTab === 'history' && (
          <div className="max-w-4xl mx-auto py-6">
            <div className="flex items-center justify-between mb-10">
              <h2 className="text-3xl md:text-4xl font-black text-slate-800 tracking-tight">Plant Log History</h2>
              <button
                onClick={loadHistory}
                disabled={isLoadingHist}
                className="text-indigo-600 font-bold hover:underline flex items-center gap-2 text-sm disabled:opacity-50"
              >
                <RefreshCw size={15} className={isLoadingHist ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>

            {isLoadingHist && (
              <div className="flex items-center justify-center py-24">
                <Loader2 size={48} className="animate-spin text-indigo-300" />
              </div>
            )}

            {!isLoadingHist && savedReports.length === 0 && (
              <div className="bg-white rounded-[48px] p-24 text-center border-4 border-dashed border-slate-100 flex flex-col items-center gap-5">
                <Cloud size={64} className="text-slate-100" />
                <p className="text-slate-400 font-bold text-lg">No saved reports yet.</p>
                <p className="text-slate-300 font-medium text-sm">Upload a log sheet to get started.</p>
              </div>
            )}

            {!isLoadingHist && savedReports.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {savedReports.map((report) => (
                  <div
                    key={report.id}
                    className="bg-white p-7 rounded-[40px] border-2 border-slate-50 hover:border-indigo-400 hover:shadow-xl transition-all cursor-pointer group relative overflow-hidden"
                    onClick={() => { setExtractedData(merge(EMPTY_DATA, report)); setActiveTab('verify'); setPreviewUrl(null); }}
                  >
                    <div className="absolute top-0 right-0 w-28 h-28 bg-indigo-50 rounded-bl-full -mr-10 -mt-10 group-hover:bg-indigo-600 transition-colors duration-500 pointer-events-none" />

                    <div className="relative z-10 flex justify-between items-start mb-6">
                      <div className="bg-indigo-600 p-3.5 rounded-2xl text-white group-hover:scale-110 transition-transform shadow-lg">
                        <Calendar size={24} />
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirm(report.id); }}
                        className="p-2 rounded-xl text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Delete report"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>

                    <div className="relative z-10">
                      <h3 className="text-2xl font-black text-slate-800 group-hover:text-indigo-600 transition-colors leading-none">
                        {report.metadata?.date || 'Unknown Date'}
                      </h3>
                      <p className="text-sm font-bold text-slate-400 mt-2 uppercase tracking-wider">
                        {[report.metadata?.shift && `${report.metadata.shift} Shift`, report.metadata?.report_made_by].filter(Boolean).join(' • ')}
                      </p>
                    </div>

                    <div className="mt-8 flex items-center justify-between border-t border-slate-50 pt-5 relative z-10">
                      <div className="flex gap-5">
                        <span className="text-xs font-bold text-slate-400 flex items-center gap-1.5">
                          <Zap size={13} /> {report.production_table?.length ?? 0} Units
                        </span>
                        <span className="text-xs font-bold text-slate-400 flex items-center gap-1.5">
                          <Waves size={13} /> {report.pond_parameters?.length ?? 0} Ponds
                        </span>
                      </div>
                      <ChevronRight size={20} className="text-slate-200 group-hover:text-indigo-600 group-hover:translate-x-1 transition-all" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Delete confirm modal */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6"
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-white rounded-[40px] p-8 max-w-sm w-full shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-xl font-black text-slate-800 mb-2">Delete this report?</h3>
            <p className="text-slate-500 text-sm font-medium mb-7">This cannot be undone.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-4 rounded-[24px] font-black text-slate-500 bg-slate-100 hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="flex-1 py-4 rounded-[24px] font-black text-white bg-red-600 hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {(successMsg || error) && (
        <div className={`fixed top-10 left-1/2 -translate-x-1/2 px-10 py-4 rounded-full shadow-2xl flex items-center gap-3 z-[100] border-2 transition-all animate-in fade-in slide-in-from-top-12 ${
          error
            ? 'bg-red-600 text-white border-red-400/20'
            : 'bg-indigo-950 text-white border-indigo-400/20'
        }`}>
          {error
            ? <AlertCircle size={22} className="text-red-200" />
            : <CheckCircle2 size={22} className="text-emerald-400" />
          }
          <p className="font-black text-sm">{error || successMsg}</p>
        </div>
      )}
    </div>
  );
}
