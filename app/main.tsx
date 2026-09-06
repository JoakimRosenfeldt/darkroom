import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router";
import { LibraryBootstrap } from "@/components/shell/LibraryBootstrap";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./globals.css";

const LibraryPage = lazy(() => import("./page"));
const PhotoPage = lazy(() => import("./photo/page"));
const ComparePage = lazy(() => import("./compare/page"));

const root = document.getElementById("root");
if (!root) throw new Error("The app root is missing.");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <LibraryBootstrap />
      <Suspense fallback={<main className="flex h-screen items-center justify-center text-sm text-lr-text-dim">Loading...</main>}>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/photo" element={<PhotoPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="*" element={
            <main className="flex h-screen flex-col items-center justify-center gap-4 text-sm">
              <p>Page not found.</p>
              <Link to="/" className="text-lr-accent">Return to Library</Link>
            </main>
          } />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>,
);
