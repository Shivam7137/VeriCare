import { isIP } from "node:net";

export const E164_NUMBER = /^\+[1-9]\d{1,14}$/;

/** Server-only configuration. Only voiceReadiness() may be returned to clients. */
export interface VoiceConfig {
  mode: "simulated" | "twilio";
  liveEnabled: boolean;
  accountSid: string | undefined;
  authToken: string | undefined;
  phoneNumber: string | undefined;
  openaiApiKey: string | undefined;
  publicBaseUrl: string | undefined;
  allowedNumbers: string[];
  realtimeModel: string;
  voice: string;
  invalid: string[];
}

function publicOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return;
    if (
      !host.includes(".") ||
      /(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)
    )
      return;
    if (isIP(host) === 4) {
      const [first, second, third] = host.split(".").map(Number) as [number, number, number];
      if (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        first >= 224 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && (second === 168 || (second === 0 && (third === 0 || third === 2)))) ||
        (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
        (first === 203 && second === 0 && third === 113)
      )
        return;
    }
    // Require a public DNS name or IPv4 literal. This also excludes mapped/private IPv6 literals.
    if (isIP(host) === 6) return;
    if (
      host.length > 253 ||
      host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}

export function readVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  const mode = value("VOICE_MODE") ?? "simulated";
  const enabled = value("VOICE_LIVE_ENABLED");
  const accountSid = value("TWILIO_ACCOUNT_SID");
  const phoneNumber = value("TWILIO_PHONE_NUMBER");
  const baseUrl = value("VOICE_PUBLIC_BASE_URL");
  const numbers =
    value("VOICE_ALLOWED_NUMBERS")
      ?.split(",")
      .map((number) => number.trim()) ?? [];
  const realtimeModel = value("OPENAI_REALTIME_MODEL") ?? "gpt-realtime";
  const voice = value("OPENAI_VOICE") ?? "marin";
  const invalid: string[] = [];
  if (mode !== "simulated" && mode !== "twilio") invalid.push("VOICE_MODE");
  if (enabled && enabled !== "true" && enabled !== "false") invalid.push("VOICE_LIVE_ENABLED");
  if (accountSid && !/^AC[0-9a-f]{32}$/i.test(accountSid)) invalid.push("TWILIO_ACCOUNT_SID");
  if (phoneNumber && !E164_NUMBER.test(phoneNumber)) invalid.push("TWILIO_PHONE_NUMBER");
  if (numbers.some((number) => !E164_NUMBER.test(number))) invalid.push("VOICE_ALLOWED_NUMBERS");
  const publicBaseUrl = baseUrl ? publicOrigin(baseUrl) : undefined;
  if (baseUrl && !publicBaseUrl) invalid.push("VOICE_PUBLIC_BASE_URL");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(realtimeModel))
    invalid.push("OPENAI_REALTIME_MODEL");
  if (
    ![
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "sage",
      "shimmer",
      "verse",
      "marin",
      "cedar",
    ].includes(voice)
  )
    invalid.push("OPENAI_VOICE");
  return {
    mode: mode === "twilio" ? "twilio" : "simulated",
    liveEnabled: enabled === "true",
    accountSid,
    authToken: value("TWILIO_AUTH_TOKEN"),
    phoneNumber,
    openaiApiKey: value("VOICE_OPENAI_API_KEY") ?? value("OPENAI_API_KEY"),
    publicBaseUrl,
    allowedNumbers: [...new Set(numbers.filter((number) => E164_NUMBER.test(number)))],
    realtimeModel,
    voice,
    invalid,
  };
}

export function voiceReadiness(config: VoiceConfig): {
  mode: VoiceConfig["mode"];
  liveEnabled: boolean;
  ready: boolean;
  liveReady: boolean;
  missing: string[];
  invalid: string[];
  allowlistedNumberCount: number;
} {
  const requirements: [string, boolean][] = [
    ["VOICE_MODE", config.mode === "twilio"],
    ["VOICE_LIVE_ENABLED", config.liveEnabled],
    ["TWILIO_ACCOUNT_SID", Boolean(config.accountSid)],
    ["TWILIO_AUTH_TOKEN", Boolean(config.authToken)],
    ["TWILIO_PHONE_NUMBER", Boolean(config.phoneNumber)],
    ["OPENAI_API_KEY", Boolean(config.openaiApiKey)],
    ["VOICE_PUBLIC_BASE_URL", Boolean(config.publicBaseUrl)],
    ["VOICE_ALLOWED_NUMBERS", config.allowedNumbers.length > 0],
  ];
  const missing = requirements.filter(([, present]) => !present).map(([name]) => name);
  const liveReady = missing.length === 0 && config.invalid.length === 0;
  return {
    mode: config.mode,
    liveEnabled: config.liveEnabled,
    ready: config.invalid.length === 0 && (config.mode === "simulated" || liveReady),
    liveReady,
    missing,
    invalid: [...config.invalid],
    allowlistedNumberCount: config.allowedNumbers.length,
  };
}
