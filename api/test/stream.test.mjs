import assert from "node:assert/strict";
import { test } from "node:test";
import { newStreamTicket, streamResumeFrom, streamTicketFrom } from "../src/stream.ts";

function streamRequest(protocols) {
  return new Request("https://backchannels.example/stream/workspace", { headers: { "sec-websocket-protocol": protocols.join(", ") } });
}

test("stream resume capability is optional and accepts a bare protocol", () => {
  assert.deepEqual(streamResumeFrom(new Request("https://backchannels.example/stream/workspace")), { canResume: false });
  assert.deepEqual(streamResumeFrom(streamRequest(["bc-stream"])), { canResume: false });
  assert.deepEqual(streamResumeFrom(streamRequest(["bc-stream", "bc-resume"])), { canResume: true });
});

for (const cursorText of ["0", "42", "00042", "999999999999999"]) {
  test(`stream resume cursor accepts ${cursorText} with or without the bare capability`, () => {
    for (const protocols of [[`bc-resume.${cursorText}`], ["bc-resume", `bc-resume.${cursorText}`]]) {
      assert.deepEqual(streamResumeFrom(streamRequest(protocols)), { canResume: true, cursor: Number(cursorText) });
    }
  });
}

for (const invalidProtocol of ["bc-resume.", "bc-resume.-1", "bc-resume.+1", "bc-resume.1.0", "bc-resume.1e2", "bc-resume.1000000000000000", "bc-resume.42x", "bc-resume.4 2", "bc-resume-extra", "BC-resume.42"]) {
  test(`stream resume ignores malformed protocol ${JSON.stringify(invalidProtocol)}`, () => {
    const request = streamRequest([invalidProtocol]);
    assert.deepEqual(streamResumeFrom(request), { canResume: false });
    assert.deepEqual(streamResumeFrom(streamRequest([invalidProtocol, "bc-resume"])), { canResume: true });
    assert.deepEqual(streamResumeFrom(streamRequest([invalidProtocol, "bc-resume.7"])), { canResume: true, cursor: 7 });
  });
}

test("resume protocols preserve ticket parsing and the required stream protocol", () => {
  const ticket = newStreamTicket();
  assert.equal(streamTicketFrom(streamRequest(["bc-stream", ticket, "bc-resume", "bc-resume.7"])), ticket);
  assert.equal(streamTicketFrom(streamRequest([ticket, "bc-resume", "bc-resume.7"])), null);
  assert.equal(streamTicketFrom(streamRequest(["bc-stream", "not-a-ticket", "bc-resume.7"])), null);
});
