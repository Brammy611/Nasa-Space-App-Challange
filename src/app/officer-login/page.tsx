"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useTranslation } from "@/lib/i18n/LanguageContext";
import LanguageToggle from "@/components/LanguageToggle";

/** Only same-site paths are allowed as the post-login destination (no open redirect). */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/citizen-reports";
  return raw;
}

function OfficerLoginForm() {
  const { tr } = useTranslation();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  const [displayName, setDisplayName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/officer/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, passcode }),
      });
      if (response.ok) {
        window.location.assign(next);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      if (body.code === "WRONG_PASSCODE") setError(tr("Kode akses salah.", "Wrong access code."));
      else if (body.code === "INVALID_DISPLAY_NAME") setError(tr("Nama petugas harus 2–80 karakter.", "Officer name must be 2-80 characters."));
      else if (body.code === "TOO_MANY_ATTEMPTS") setError(tr("Terlalu banyak percobaan. Coba lagi beberapa menit lagi.", "Too many attempts. Try again in a few minutes."));
      else if (body.code === "OFFICER_AUTH_DISABLED")
        setError(tr("Login petugas belum diaktifkan di server (OFFICER_ACCESS_KEY belum diisi).", "Officer sign-in is not enabled on the server (OFFICER_ACCESS_KEY is not set)."));
      else setError(tr("Gagal masuk. Coba lagi.", "Sign-in failed. Please try again."));
    } catch {
      setError(tr("Gagal terhubung ke server.", "Could not reach the server."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-5">
      <div className="space-y-1">
        <span className="material-symbols-outlined text-[28px] text-[#075640]" aria-hidden="true">badge</span>
        <h1 className="text-xl font-bold text-gray-900">{tr("Masuk sebagai petugas", "Sign in as officer")}</h1>
        <p className="text-xs leading-relaxed text-gray-500">
          {tr(
            "Untuk meninjau laporan dan menjalankan operasi lapangan. Nama Anda dicatat di histori perubahan; kode akses dibagikan oleh koordinator tim.",
            "For reviewing reports and managing field operations. Your name is recorded in the change history; the access code is shared by your team coordinator."
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="displayName" className="text-xs font-semibold text-gray-700">
          {tr("Nama petugas", "Officer name")}
        </label>
        <input
          id="displayName"
          type="text"
          autoComplete="name"
          minLength={2}
          maxLength={80}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-[#075640] focus:outline-none focus:ring-2 focus:ring-[#075640]/20"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="passcode" className="text-xs font-semibold text-gray-700">
          {tr("Kode akses", "Access code")}
        </label>
        <input
          id="passcode"
          type="password"
          autoComplete="current-password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          required
          className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-[#075640] focus:outline-none focus:ring-2 focus:ring-[#075640]/20"
        />
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs font-medium text-rose-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !passcode || displayName.trim().length < 2}
        className="w-full rounded-xl bg-[#075640] py-2.5 text-sm font-bold text-white transition hover:bg-[#06442f] disabled:opacity-50"
      >
        {submitting ? tr("Memeriksa…", "Checking…") : tr("Masuk", "Sign in")}
      </button>

      <div className="flex items-center justify-between text-xs">
        <Link href="/operator" className="text-gray-500 hover:text-gray-800">
          {tr("Lihat dasbor tanpa masuk", "View dashboard without signing in")}
        </Link>
        <Link href="/community" className="text-gray-500 hover:text-gray-800">
          {tr("Saya warga", "I'm a citizen")}
        </Link>
      </div>
    </form>
  );
}

export default function OfficerLoginPage() {
  return (
    <main className="min-h-screen bg-[#f4f6f3] flex flex-col items-center justify-center gap-4 p-6">
      <div className="w-full max-w-sm flex justify-end">
        <LanguageToggle />
      </div>
      <Suspense fallback={null}>
        <OfficerLoginForm />
      </Suspense>
    </main>
  );
}
