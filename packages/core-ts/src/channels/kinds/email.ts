/**
 * Email via SMTP (R12, KTD5): plain-text mail through the user's own SMTP
 * account. The host's client (`packages/cli/src/channels/smtp.ts`) sends
 * the spec; this file holds the fields, the provider presets and the
 * where-to-get-it steps. TLS is always verified; security `none` (no TLS at
 * all) is allowed only to a mail server on this computer.
 *
 * Outlook.com and Hotmail personal accounts are not supported: Microsoft
 * turned off password SMTP for them on 2024-09-16 and they need OAuth,
 * which would need a Tidegap-owned client id (R20).
 */

import type { DeliverySpec, FieldValues, KindDescriptor, SmtpSecurity } from "../registry.js";
import type { NotificationPayload } from "../payload.js";

/** A plain `local@domain` address: no spaces, CR, LF, `<`, `>`, quotes, commas or semicolons. */
export const EMAIL_ADDRESS = String.raw`[^\s<>@,;"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+`;

const WHOLE_ADDRESS = new RegExp(`^(?:${EMAIL_ADDRESS})$`);

/** An SMTP login: usually an address, but relays use a user name or `apikey` (SendGrid, SES). No whitespace (so no CR or LF). Not a secret: it is shown in full. */
const SMTP_LOGIN = String.raw`\S{1,255}`;

/** A host name or an IPv4 address (no scheme, no port). */
const HOST = String.raw`[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?`;

/** Hosts that never leave this computer: `none` (no TLS) is allowed only to these. */
export function isLoopbackSmtpHost(host: string): boolean {
  return /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i.test(host.trim());
}

/** Microsoft's personal mail domains and SMTP host: password SMTP is off for them. */
const OUTLOOK_PERSONAL = /@(outlook|hotmail|live|msn)\.[a-z.]+$/i;
const OUTLOOK_HOST = /^smtp-mail\.outlook\.com$/i;

const OUTLOOK_TEXT =
  "Outlook.com and Hotmail accounts cannot send through SMTP with a password since September 2024. Use another mail account, or a Microsoft 365 work account whose admin allows SMTP AUTH.";

const SECURITY: readonly SmtpSecurity[] = ["tls", "starttls", "none"];

/** Gmail shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces are not part of it. */
function passwordFor(host: string, password: string | undefined): string | undefined {
  if (!password) return undefined;
  return /^smtp\.gmail\.com$/i.test(host) ? password.replace(/\s+/g, "") : password;
}

/** One line for a header: CR, LF and other control characters become spaces. */
export function headerLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
}

export const email: KindDescriptor = {
  kind: "email",
  label: "Email",
  description: "Mail through your own SMTP account: Gmail, iCloud, Fastmail or any provider.",
  ready: true,
  fields: [
    {
      name: "user",
      label: "Email address",
      input: "text",
      required: true,
      pattern: SMTP_LOGIN,
      maxLength: 255,
      placeholder: "you@example.com",
      invalid: "Type the login with no spaces, usually your email address.",
      help: "Usually your email address; some relays use a username or 'apikey'. It signs in to the mail server, and it is the sender and the recipient unless you change them below.",
    },
    {
      name: "password",
      label: "App password",
      input: "password",
      secret: true,
      keepWith: "host",
      help: "An app password, not your normal password. Leave empty only for a server that needs no login.",
    },
    { name: "host", label: "SMTP server", input: "text", required: true, advanced: true, pattern: HOST, placeholder: "smtp.example.com", invalid: "Type the server name only, like smtp.example.com, with no https:// and no port." },
    { name: "port", label: "Port", input: "number", required: true, advanced: true, default: 465, min: 1, max: 65535 },
    {
      name: "security",
      label: "Security",
      input: "select",
      advanced: true,
      default: "tls",
      options: [
        { value: "tls", label: "SSL/TLS (usually port 465)" },
        { value: "starttls", label: "STARTTLS (usually port 587)" },
        { value: "none", label: "None (only a mail server on this computer)" },
      ],
    },
    { name: "from", label: "From", input: "text", advanced: true, pattern: EMAIL_ADDRESS, placeholder: "Same as the email address", invalid: "Type one plain address, like you@example.com." },
    { name: "to", label: "Send to", input: "text", advanced: true, pattern: EMAIL_ADDRESS, placeholder: "Same as From", invalid: "Type one plain address, like you@example.com." },
  ],
  presets: [
    {
      id: "gmail",
      label: "Gmail",
      values: { host: "smtp.gmail.com", port: 465, security: "tls" },
      note: "Turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords. Spaces in it are fine.",
    },
    {
      id: "icloud",
      label: "iCloud Mail",
      values: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
      note: "At account.apple.com: Sign-In and Security → App-Specific Passwords → Generate. Use your full iCloud address.",
    },
    {
      id: "fastmail",
      label: "Fastmail",
      values: { host: "smtp.fastmail.com", port: 465, security: "tls" },
      note: "Settings → Privacy & Security → App passwords → New, with SMTP access.",
    },
    {
      id: "m365",
      label: "Microsoft 365 (work)",
      values: { host: "smtp.office365.com", port: 587, security: "starttls" },
      note: "Works only if your admin allows SMTP AUTH. Outlook.com and Hotmail personal accounts are not supported.",
    },
  ],
  steps: [
    { text: "Gmail: turn on 2-Step Verification, then create an app password named Tidegap.", link: "https://myaccount.google.com/apppasswords" },
    { text: "iCloud: Sign-In and Security → App-Specific Passwords → Generate.", link: "https://account.apple.com/" },
    { text: "Fastmail: Settings → Privacy & Security → App passwords → New, with SMTP access.", link: "https://www.fastmail.com/help/clients/apppassword.html" },
    { text: "Other providers: find the SMTP server, port and security on their help pages. Outlook.com and Hotmail personal accounts are not supported." },
  ],
  defaultEvents: ["task_failed", "not_ready", "digest"],
  docsAnchor: "notify-email",
  target: (values) => String(values.to || values.from || values.user || "Email"),
  errors: {
    auth: { text: "The mail server refused the user name or password. Gmail, iCloud and Fastmail need an app password.", field: "password" },
    auth_required: { text: "The mail server needs a login. Type the app password.", field: "password" },
    auth_unsupported: { text: "The mail server offers no login method Tidegap knows (PLAIN or LOGIN). Check the server and the security setting.", field: "security" },
    starttls_unsupported: { text: "The mail server does not offer STARTTLS on this port. Pick SSL/TLS, or check the port.", field: "security" },
    tls: { text: "The mail server's certificate is not trusted. Check the server name and the security setting.", field: "host" },
    network: { text: "Tidegap could not reach the mail server. Check the server name and the port.", field: "host" },
    timeout: { text: "The mail server did not answer in time. Check the port and the security setting.", field: "port" },
    smtp_sender: { text: "The mail server refused the sender address. Use your own address in From.", field: "from" },
    smtp_recipient: { text: "The mail server refused the recipient address. Check Send to.", field: "to" },
    smtp_policy: { text: "The mail server refused the mail by policy. Check that the account may send mail through SMTP." },
  },
  validate(values: FieldValues) {
    const host = String(values.host ?? "");
    if (values.security === "none" && !isLoopbackSmtpHost(host)) {
      return { field: "security", text: "Security None works only with a mail server on this computer. Pick SSL/TLS or STARTTLS." };
    }
    if (OUTLOOK_HOST.test(host)) return { field: "host", text: OUTLOOK_TEXT };
    const user = String(values.user ?? "");
    if (OUTLOOK_PERSONAL.test(user)) return { field: "user", text: OUTLOOK_TEXT };
    // A login that is not an address cannot be the sender.
    if (!values.from && !WHOLE_ADDRESS.test(user)) {
      return { field: "from", text: "This login is not an email address. Type the sender address in From." };
    }
    return undefined;
  },
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    const host = String(values.host);
    const user = String(values.user);
    const from = String(values.from || user);
    const password = passwordFor(host, values.password === undefined ? undefined : String(values.password));
    const security = SECURITY.find((s) => s === values.security) ?? "tls";
    return {
      type: "smtp",
      host,
      port: Number(values.port),
      security,
      ...(password ? { user, password } : {}),
      from,
      to: String(values.to || from),
      subject: headerLine(`Tidegap: ${payload.title}`),
      text: payload.text,
    };
  },
};
