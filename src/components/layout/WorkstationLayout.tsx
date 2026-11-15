"use client";

import { useState } from "react";
import Sidebar from "@/components/layout/Sidebar";
import TopBar from "@/components/layout/TopBar";

interface WorkstationLayoutProps {
  children: React.ReactNode;
  activeTab?: string;
  fullBleed?: boolean;
}

export default function WorkstationLayout({
  children,
  fullBleed = false,
}: WorkstationLayoutProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex h-screen w-full bg-[var(--color-bg-main)] text-[var(--color-text-main)] font-sans">
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Tutup navigasi"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-[1500] bg-black/45 backdrop-blur-[1px] lg:hidden"
        />
      )}
      <Sidebar mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopBar onOpenMenu={() => setMobileNavOpen(true)} />
        <main className={`flex-1 min-h-0 ${fullBleed ? "overflow-hidden" : "overflow-y-auto p-4 sm:p-6 lg:p-8 custom-scroll"}`}>
          {children}
        </main>
      </div>
    </div>
  );
}
