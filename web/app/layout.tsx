import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aura Finance - Delivery Group Intelligence & P&L",
  description: "Next-generation financial reconciliation, Recipe BOM costing, and settlement intelligence for restaurant multi-brand chains.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full subtle-mesh-bg text-slate-900 antialiased selection:bg-indigo-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
