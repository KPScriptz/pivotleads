'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr(false);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        const next = new URLSearchParams(window.location.search).get('next') || '/campaign';
        window.location.href = next.startsWith('/') ? next : '/campaign';
      } else {
        setErr(true); setBusy(false);
      }
    } catch {
      setErr(true); setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F5F7] flex items-center justify-center px-4 font-sans">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="text-[11px] uppercase tracking-[0.16em] text-emerald-600 font-bold">Campaign</div>
          <div className="text-2xl font-bold tracking-tight text-gray-900 mt-1">Pivot <span className="text-emerald-600">Leads</span></div>
        </div>
        <form onSubmit={submit} className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          <label className="block text-sm font-semibold text-gray-800 mb-1.5">Team password</label>
          <input
            type="password"
            value={pw}
            autoFocus
            onChange={(e) => { setPw(e.target.value); setErr(false); }}
            placeholder="Enter the password"
            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
          />
          {err && <div className="text-[13px] text-rose-600 mt-2">That password isn&apos;t right. Try again.</div>}
          <button
            type="submit"
            disabled={busy || !pw}
            className="mt-4 w-full bg-[#48f4ad] hover:brightness-105 disabled:opacity-50 text-[#04231a] text-sm font-bold py-2.5 rounded-lg transition-all"
          >
            {busy ? 'Checking…' : 'Enter'}
          </button>
        </form>
        <div className="text-center text-[11px] text-gray-400 mt-4">Private beta — ask your team for the password.</div>
      </div>
    </div>
  );
}
