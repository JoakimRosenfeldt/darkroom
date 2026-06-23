"use client";

import type { StarRating } from "@/lib/catalog/types";

interface StarRatingControlProps {
  value: StarRating;
  onChange: (value: StarRating) => void;
  className?: string;
  starClassName?: string;
}

export function StarRatingControl({
  value,
  onChange,
  className = "",
  starClassName = "text-sm",
}: StarRatingControlProps) {
  return (
    <div className={`flex items-center gap-0.5 ${className}`}>
      {([0, 1, 2, 3, 4, 5] as const).map((starValue) => (
        <button
          key={starValue}
          type="button"
          onClick={() => onChange(starValue)}
          title={
            starValue === 0 ? "Clear rating" : `${starValue} star${starValue === 1 ? "" : "s"}`
          }
          className={[
            "px-0.5 transition",
            starClassName,
            value >= starValue && starValue > 0
              ? "text-amber-400"
              : "text-lr-text-dim hover:text-lr-text-muted",
          ].join(" ")}
        >
          {starValue === 0 ? "∅" : "★"}
        </button>
      ))}
    </div>
  );
}
