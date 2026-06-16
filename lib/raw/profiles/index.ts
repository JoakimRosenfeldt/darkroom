import { registerProfile } from "../registry";
import { nefProfile } from "./nef";
import { standardImageProfile } from "./standard";

let initialized = false;

export function initializeProfiles(): void {
  if (initialized) {
    return;
  }

  registerProfile(standardImageProfile);
  registerProfile(nefProfile);
  initialized = true;
}

export { nefProfile, standardImageProfile };
