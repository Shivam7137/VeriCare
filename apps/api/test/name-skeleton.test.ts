import assert from "node:assert/strict";
import test from "node:test";
import { nameSkeleton } from "../src/emergency-lookup.js";

test("names that differ only by a misheard vowel or a silent letter compare equal", () => {
  assert.equal(nameSkeleton("Maya Chan"), nameSkeleton("Maya Chen"));
  assert.equal(nameSkeleton("  maya   CHEN "), nameSkeleton("Maya Chen"));
  assert.equal(nameSkeleton("Shivam Sha"), nameSkeleton("Shivam Shah"));
});

test("different consonants or first letters stay different", () => {
  assert.notEqual(nameSkeleton("Maya Chang"), nameSkeleton("Maya Chen"));
  assert.notEqual(nameSkeleton("Maya Shen"), nameSkeleton("Maya Chen"));
  assert.notEqual(nameSkeleton("Maya Chen"), nameSkeleton("Maya Chen Li"));
});
