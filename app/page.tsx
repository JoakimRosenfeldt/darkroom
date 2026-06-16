"use client";

import { FolderPicker } from "@/components/import/FolderPicker";
import { PhotoGrid } from "@/components/library/PhotoGrid";
import { useLibraryStore } from "@/stores/library-store";

export default function HomePage() {
  const entries = useLibraryStore((state) => state.entries);
  const folderName = useLibraryStore((state) => state.folderName);

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-4 border-b border-zinc-800 pb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-zinc-500">
            Client-side library
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-zinc-50">
            Darkroom
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
            Browse local folders in place, decode RAW files on your machine, and
            keep your library private.
          </p>
        </div>
        <FolderPicker />
      </header>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-500">
            Library
          </h2>
          {folderName ? (
            <p className="text-sm text-zinc-400">
              {entries.length} photo{entries.length === 1 ? "" : "s"}
            </p>
          ) : null}
        </div>
        <PhotoGrid entries={entries} />
      </section>
    </div>
  );
}
