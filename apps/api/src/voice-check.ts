import { readVoiceConfig, voiceReadiness } from "./voice-config.js";

// Configuration inspection only: never instantiate a provider or print secret values.
const readiness = voiceReadiness(readVoiceConfig());
console.log(JSON.stringify(readiness, null, 2));
if (!readiness.ready) process.exitCode = 1;
