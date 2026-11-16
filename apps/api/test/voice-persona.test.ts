import assert from "node:assert/strict";
import test from "node:test";
import {
  emergencyBackendInstructions,
  emergencyVoiceInstructions,
  emergencyVoiceTools,
} from "../src/emergency-voice.js";
import { voiceAgentInstructions } from "../src/voice-agent.js";
import {
  liveGreeting,
  liveVoiceInstructions,
  voiceCareStyle,
  voiceLanguageStyle,
} from "../src/voice-persona.js";

test("Alex follows the caller's language in both scenarios", () => {
  for (const prompt of [liveVoiceInstructions, emergencyVoiceInstructions])
    assert.ok(prompt.includes(voiceLanguageStyle));
  assert.match(voiceLanguageStyle, /reply in the language they are speaking/);
  assert.match(liveGreeting, /speak in any language/);
  for (const prompt of [voiceAgentInstructions, emergencyBackendInstructions])
    assert.match(prompt, /Keep your (?:own )?results in English/);
});

test("language support keeps the English approval phrase the readback gate listens for", () => {
  assert.match(
    liveVoiceInstructions,
    /say exactly in English 'Press one to approve or two to cancel\.'/,
  );
});

test("emergency tools receive language-neutral values", () => {
  const params = (name: string) =>
    emergencyVoiceTools.find((tool) => tool.name === name)!.parameters as {
      properties: Record<string, { description?: string }>;
    };
  assert.match(
    params("send_emergency_contact_code").properties.relationship!.description!,
    /plain English word/,
  );
  assert.match(
    params("verify_emergency_contact_code").properties.code!.description!,
    /numerals 0-9/,
  );
});

test("both phone scenarios share the personal-connection style", () => {
  for (const prompt of [liveVoiceInstructions, emergencyVoiceInstructions])
    assert.ok(prompt.includes(voiceCareStyle));
  assert.match(voiceCareStyle, /use their first name once/);
  assert.doesNotMatch(liveVoiceInstructions, /or the caller's name/);
});

test("Alex uses details already given and only says it is checking when it is", () => {
  assert.match(voiceCareStyle, /check whether they already answered it/);
  assert.match(voiceCareStyle, /at most once per lookup/);
  assert.match(emergencyVoiceInstructions, /if they give both together, take both/);
  assert.match(emergencyVoiceInstructions, /if you did not hear exactly eight, do not say 'great'/);
});

test("a spoken name stays conversational and never weakens verification", () => {
  assert.match(voiceCareStyle, /never guess one or take one from records/);
  assert.match(liveVoiceInstructions, /never replaces the keypad code/);
  assert.match(liveVoiceInstructions, /Never ask them to say their code aloud/);
  assert.match(
    emergencyVoiceInstructions,
    /never disclose the registered contact's name or relationship/,
  );
  assert.match(emergencyVoiceInstructions, /Using the name they said never means it matched/);
});
