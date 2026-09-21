// Standalone Chat Manager & formatting unit tests. Run: node tests/chat.test.mjs
import assert from "node:assert";
import fs from "node:fs";
import { createChatManager, formatSessionEntries } from "../host/chat.mjs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n")[0]}`);
  }
};

const broadcastMessages = [];
const mockBroadcast = (msg) => {
  broadcastMessages.push(msg);
};

const modelRuntime = await ModelRuntime.create();
const chatManager = createChatManager({ modelRuntime, broadcast: mockBroadcast });

console.log("[test] running chat manager tests...");

await test("formatSessionEntries: user and assistant message formatting", () => {
  const sampleEntries = [
    {
      type: "model_change",
      id: "e1",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
      timestamp: "2026-09-21T05:00:00.000Z",
    },
    {
      type: "thinking_level_change",
      id: "e2",
      thinkingLevel: "high",
      timestamp: "2026-09-21T05:00:01.000Z",
    },
    {
      type: "session_info",
      id: "e3",
      name: "Custom Session Title",
      timestamp: "2026-09-21T05:00:02.000Z",
    },
    {
      type: "message",
      id: "e4",
      timestamp: "2026-09-21T05:00:03.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Please edit src/index.js" }],
      },
    },
    {
      type: "message",
      id: "e5",
      timestamp: "2026-09-21T05:00:04.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to inspect and edit the file." },
          { type: "text", text: "I will edit the file now." },
          {
            type: "toolCall",
            id: "call_101",
            name: "edit",
            arguments: { path: "src/index.js", edits: [] },
          },
        ],
        model: "claude-3-5-sonnet",
        provider: "anthropic",
        usage: { input: 150, output: 80, cacheRead: 50 },
      },
    },
    {
      type: "message",
      id: "e6",
      timestamp: "2026-09-21T05:00:05.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_101",
        toolName: "edit",
        content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
        isError: false,
        details: {
          diff: "--- a/src/index.js\n+++ b/src/index.js\n@@ -1,2 +1,2 @@\n-old\n+new",
          firstChangedLine: 1,
        },
      },
    },
  ];

  const formatted = formatSessionEntries(sampleEntries);
  assert.strictEqual(formatted.sessionTitle, "Custom Session Title");
  assert.strictEqual(formatted.currentModel, "anthropic/claude-3-5-sonnet");
  assert.strictEqual(formatted.currentThinkingLevel, "high");
  assert.strictEqual(formatted.messages.length, 2);

  const userMsg = formatted.messages[0];
  assert.strictEqual(userMsg.role, "user");
  assert.strictEqual(userMsg.content, "Please edit src/index.js");

  const assistantMsg = formatted.messages[1];
  assert.strictEqual(assistantMsg.role, "assistant");
  assert.strictEqual(assistantMsg.thinking, "I need to inspect and edit the file.");
  assert.strictEqual(assistantMsg.content, "I will edit the file now.");
  assert.strictEqual(assistantMsg.toolCalls.length, 1);

  const tc = assistantMsg.toolCalls[0];
  assert.strictEqual(tc.name, "edit");
  assert.ok(tc.result);
  assert.strictEqual(tc.result.toolCallId, "call_101");
  assert.strictEqual(tc.result.isError, false);
  assert.ok(tc.result.details.diff.includes("-old"));
  assert.ok(tc.result.details.diff.includes("+new"));
  assert.strictEqual(assistantMsg.usage.input, 150);
  assert.strictEqual(assistantMsg.usage.output, 80);
  assert.strictEqual(assistantMsg.usage.cacheRead, 50);
});

await test("chatManager: createSession, listSessions, getSession, renameSession, deleteSession", async () => {
  broadcastMessages.length = 0;
  const session = await chatManager.createSession("sandbox", {
    title: "Test Unit Session",
    thinkingLevel: "medium",
  });

  assert.ok(session.id);
  assert.strictEqual(session.title, "Test Unit Session");
  assert.strictEqual(session.thinkingLevel, "medium");

  const loaded = await chatManager.getSession("sandbox", session.id);
  assert.strictEqual(loaded.id, session.id);
  assert.strictEqual(loaded.title, "Test Unit Session");
  assert.strictEqual(loaded.messages.length, 0);

  const renamed = await chatManager.renameSession("sandbox", session.id, "Renamed Unit Title");
  assert.strictEqual(renamed.title, "Renamed Unit Title");

  const reloaded = await chatManager.getSession("sandbox", session.id);
  assert.strictEqual(reloaded.title, "Renamed Unit Title");

  const list = await chatManager.listSessions("sandbox");
  assert.ok(Array.isArray(list));

  const del = await chatManager.deleteSession("sandbox", session.id);
  assert.strictEqual(del.ok, true);

  await assert.rejects(async () => {
    await chatManager.getSession("sandbox", session.id);
  }, /not found/);
});

await test("chatManager: abortSession handles active or idle session", async () => {
  const session = await chatManager.createSession("sandbox", { title: "Abort Test" });
  const abortRes = await chatManager.abortSession("sandbox", session.id);
  assert.strictEqual(abortRes.ok, true);
  await chatManager.deleteSession("sandbox", session.id);
});

const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} chat tests passed\n`);
if (passed !== results.length) process.exit(1);
