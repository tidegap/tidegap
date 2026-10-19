/** Every registry kind (KTD1). Each channel stream edits only its own `kinds/<kind>.ts`. */

import type { KindDescriptor } from "../registry.js";
import type { ChannelKind, RegistryKind } from "../types.js";
import { discord } from "./discord.js";
import { email } from "./email.js";
import { ntfy } from "./ntfy.js";
import { pushover } from "./pushover.js";
import { shortcuts } from "./shortcuts.js";
import { slack } from "./slack.js";
import { telegram } from "./telegram.js";
import { webhook } from "./webhook.js";

/** One descriptor per registry kind, in card order. */
export const KIND_DESCRIPTORS: Readonly<Record<RegistryKind, KindDescriptor>> = { telegram, email, slack, discord, ntfy, pushover, webhook, shortcuts };

export function kindDescriptor(kind: RegistryKind): KindDescriptor {
  return KIND_DESCRIPTORS[kind];
}

/** True for `os` and every registry kind; the ledger skips any other row kind. */
export function isChannelKind(kind: string): kind is ChannelKind {
  return kind === "os" || Object.hasOwn(KIND_DESCRIPTORS, kind);
}
