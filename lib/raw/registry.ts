import type { ImageProfile } from "./types";

const profiles: ImageProfile[] = [];

export function registerProfile(profile: ImageProfile): void {
  const existingIndex = profiles.findIndex((item) => item.id === profile.id);
  if (existingIndex >= 0) {
    profiles[existingIndex] = profile;
    return;
  }
  profiles.push(profile);
}

export function getProfiles(): ImageProfile[] {
  return [...profiles];
}

export function resolveProfile(
  file: Pick<{ name: string }, "name">,
): ImageProfile | null {
  return profiles.find((profile) => profile.detect(file)) ?? null;
}

export function getSupportedExtensions(): string[] {
  const extensions = new Set<string>();
  for (const profile of profiles) {
    for (const extension of profile.extensions) {
      extensions.add(extension.toLowerCase());
    }
  }
  return [...extensions].sort();
}
