import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expiresAtFor, expiryDaysFrom, overlapExpiry, successorExpiry } from "../src/keyRotation.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 30);

describe("headless key expiry", () => {
  test("expiry days are whole days from 1 to the maximum", () => {
    assert.equal(expiryDaysFrom(90, 90), 90);
    assert.equal(expiryDaysFrom(1, 90), 1);
    assert.equal(expiryDaysFrom(0, 90), null);
    assert.equal(expiryDaysFrom(91, 90), null);
    assert.equal(expiryDaysFrom(1.5, 90), null);
    assert.equal(expiryDaysFrom("30", 90), null);
  });

  test("a new key expires the chosen number of days from now", () => {
    assert.equal(expiresAtFor(NOW, 30), NOW + 30 * DAY_MS);
  });

  test("the rotated key keeps 24 hours at most, never more than it had", () => {
    assert.equal(overlapExpiry(NOW + 60 * DAY_MS, NOW, DAY_MS), NOW + DAY_MS);
    assert.equal(overlapExpiry(NOW + 60_000, NOW, DAY_MS), NOW + 60_000);
  });

  test("the successor gets the old key's lifetime, capped at the maximum", () => {
    assert.equal(successorExpiry({ created_at: NOW - 10 * DAY_MS, expires_at: NOW + 20 * DAY_MS }, NOW, 90), NOW + 30 * DAY_MS);
    assert.equal(successorExpiry({ created_at: NOW - DAY_MS, expires_at: NOW + 200 * DAY_MS }, NOW, 90), NOW + 90 * DAY_MS);
  });
});
