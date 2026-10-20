/** Kind → driver (integrations plan KTD3). Each channel stream edits only its own `drivers/<kind>.ts`. Telegram keeps its own path. */

import type { RegistryKind } from "@tidegap/core";

import { discord } from "./discord.js";
import { email } from "./email.js";
import { ntfy } from "./ntfy.js";
import { pushover } from "./pushover.js";
import { shortcuts } from "./shortcuts.js";
import { slack } from "./slack.js";
import type { ChannelDriver } from "./types.js";
import { webhook } from "./webhook.js";

export type { ChannelDriver, DriverContext } from "./types.js";

export type DriverKind = Exclude<RegistryKind, "telegram">;

export const DRIVERS: Readonly<Record<DriverKind, ChannelDriver>> = { webhook, slack, discord, ntfy, pushover, email, shortcuts };
