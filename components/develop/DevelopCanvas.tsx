"use client";

import Image from "next/image";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { DevelopRenderer } from "@/lib/develop/renderer";
import { useDevelopStore } from "@/stores/develop-store";

interface DevelopCanvasProps {
  image: DevelopImage;
  alt: string;
}

export interface DevelopCanvasHandle {
  exportJpeg(): Promise<Blob>;
}

export const DevelopCanvas = forwardRef<DevelopCanvasHandle, DevelopCanvasProps>(
  function DevelopCanvas({ image, alt }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<DevelopRenderer | null>(null);
  const settings = useDevelopStore((state) => state.settings);
  const showOriginal = useDevelopStore((state) => state.showOriginal);
  const setShowOriginal = useDevelopStore((state) => state.setShowOriginal);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    async exportJpeg() {
      const renderer = rendererRef.current;
      if (!renderer || !ready) {
        throw new Error("Editor preview is not ready to export.");
      }
      return renderer.toBlob();
    },
  }), [ready]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const currentCanvas = canvas;

    let active = true;
    setReady(false);
    setError(null);

    async function loadRenderer() {
      try {
        rendererRef.current?.dispose();
        const renderer = new DevelopRenderer(currentCanvas);
        rendererRef.current = renderer;
        await renderer.setImage(image);
        if (!active) {
          renderer.dispose();
          return;
        }
        setReady(true);
      } catch (rendererError) {
        if (active) {
          setError(
            rendererError instanceof Error
              ? rendererError.message
              : "Could not initialize editor preview.",
          );
        }
      }
    }

    void loadRenderer();

    return () => {
      active = false;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [image]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !renderer || !container || !ready) {
      return;
    }
    const currentCanvas = canvas;
    const currentContainer = container;
    const currentRenderer = renderer;

    function render() {
      if (!currentCanvas || !currentContainer) {
        return;
      }
      currentRenderer.resize(
        currentContainer.clientWidth,
        currentContainer.clientHeight,
      );
      currentRenderer.render(settings, showOriginal);
    }

    render();
    const observer = new ResizeObserver(render);
    observer.observe(currentContainer);
    return () => observer.disconnect();
  }, [settings, showOriginal, ready]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "\\") {
        setShowOriginal(true);
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "\\") {
        setShowOriginal(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [setShowOriginal]);

  if (error) {
    return (
      <div className="relative h-full w-full">
        <Image
          src={image.objectUrl}
          alt={alt}
          fill
          unoptimized
          className="object-contain"
          priority
        />
        <div className="absolute left-3 top-3 rounded border border-red-500/40 bg-red-950/80 px-3 py-2 text-xs text-red-100">
          Editing preview unavailable: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full" />
      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs uppercase tracking-wider text-lr-text-dim">
          Preparing editor...
        </div>
      ) : null}
      <CropOverlay />
      {showOriginal ? (
        <div className="absolute left-3 top-3 rounded bg-lr-panel/90 px-2 py-1 text-[11px] uppercase tracking-wider text-lr-text-muted">
          Before
        </div>
      ) : null}
    </div>
  );
});

function CropOverlay() {
  const crop = useDevelopStore((state) => state.settings.crop);
  if (!crop.enabled) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute border border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.32)]"
      style={{
        left: `${crop.x * 100}%`,
        top: `${crop.y * 100}%`,
        width: `${crop.width * 100}%`,
        height: `${crop.height * 100}%`,
        transform: `rotate(${crop.angle}deg)`,
      }}
    >
      <div className="grid h-full w-full grid-cols-3 grid-rows-3">
        {Array.from({ length: 9 }, (_, index) => (
          <div key={index} className="border border-white/20" />
        ))}
      </div>
    </div>
  );
}
