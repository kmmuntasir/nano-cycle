import { useCallback, useEffect, useState } from "react";
import { Box, Flex, HStack, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { DangerOutlineButton, OutlineButton, PrimaryButton, WarningButton } from "../ui/buttons";
import ModelPicker from "../ui/ModelPicker";
import { api, ticketsApi } from "../api";
import type { InboxItem, ModelInfo, RunState, Ticket, TicketStore } from "../api";

const STATUS_ICON: Record<string, { glyph: string; color: string }> = {
  draft: { glyph: "○", color: "#8b91a0" },
  clarifying: { glyph: "◌", color: "#7aa2f7" },
  clarified: { glyph: "◆", color: "#7aa2f7" },
  queued: { glyph: "◇", color: "#8b91a0" },
  running: { glyph: "▶", color: "#7aa2f7" },
  done: { glyph: "✓", color: "#4fd6a8" },
  blocked: { glyph: "⛔", color: "#f16a6a" },
};

const QUEUE_STATE_HINT: Record<string, string> = {
  idle: "Idle — add tickets, then run a clarify wave",
  clarifying: "PM clarification wave in flight — answer in the Inbox below",
  "awaiting-release": "Specs locked — review them and release the queue",
  running: "Delivering tickets sequentially",
  paused: "Paused — the current ticket finishes, then the queue waits",
};

export default function TicketsView({ project, models, onOpenRun }: { project: string; models: ModelInfo[]; onOpenRun: (runId: string) => void }) {
  const [store, setStore] = useState<TicketStore | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newDeps, setNewDeps] = useState("");
  const [showModels, setShowModels] = useState(false);
  const [waveModels, setWaveModels] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    ticketsApi.store(project).then(setStore).catch((e) => setErr(String(e)));
    ticketsApi.inbox(project).then((r) => setInbox(r.items)).catch(() => {});
  }, [project]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = useCallback(
    async (body: { action: string; ticketIds?: string[]; ticketId?: string; orderedIds?: string[] }) => {
      setBusy(true);
      setErr(null);
      try {
        await ticketsApi.queue(project, body);
        refresh();
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    },
    [project, refresh],
  );

  if (!store) {
    return (
      <Box border="1px dashed" borderColor="line" borderRadius="md" p={6} textAlign="center">
        <Text fontSize="13px" color="#c9cdd8" fontFamily="system-ui, sans-serif">Loading tickets…</Text>
      </Box>
    );
  }

  const q = store.queue;
  const rows = [...store.tickets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const clarified = rows.filter((t) => t.status === "clarified");
  const blocked = rows.filter((t) => t.status === "blocked");
  const doneCount = rows.filter((t) => t.status === "done").length;

  return (
    <Stack gap={3}>
      {/* queue panel */}
      <Box border="1px solid" borderColor="line" borderRadius="lg" bg="surface" p={4}>
        <Flex gap={2} alignItems="center" flexWrap="wrap">
          <Text fontSize="14px" fontWeight={700} fontFamily="system-ui, sans-serif">
            Ticket Queue
          </Text>
          <Box px={2} py={0.5} borderRadius="sm" border="1px solid" borderColor={q.state === "running" ? "#2b3a5c" : "line"} bg={q.state === "running" ? "#1b2130" : "transparent"}>
            <Text fontSize="11px" color={q.state === "running" ? "#7aa2f7" : "muted"} fontFamily="ui-monospace, monospace">
              {q.state}
            </Text>
          </Box>
          <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
            {QUEUE_STATE_HINT[q.state] ?? ""}
          </Text>
          <Box flex="1" />
          <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
            {doneCount}/{rows.length} done
            {blocked.length > 0 ? ` · ${blocked.length} blocked` : ""}
          </Text>
        </Flex>

        <HStack mt={3} flexWrap="wrap">
          <PrimaryButton
            disabled={busy || clarified.length === 0 || q.state === "running"}
            onClick={() => act({ action: "release" })}
            title="Queue every clarified ticket for sequential delivery (build → verify → security per ticket)."
          >
            ▶ Release {clarified.length > 0 ? `${clarified.length} Ticket(s)` : ""}
          </PrimaryButton>
          {q.state !== "paused" ? (
            <OutlineButton disabled={busy || q.state !== "running"} onClick={() => act({ action: "pause" })}>
              Pause Queue
            </OutlineButton>
          ) : (
            <PrimaryButton disabled={busy} onClick={() => act({ action: "resume" })}>
              Resume Queue
            </PrimaryButton>
          )}
          <OutlineButton
            disabled={busy || rows.every((t) => !["draft", "blocked", "clarified", "failed"].includes(t.status))}
            onClick={async () => {
              if (!showModels) { setShowModels(true); return; }
              setBusy(true);
              try {
                await ticketsApi.queue(project, { action: "config", models: waveModels });
                const ids = rows.filter((t) => ["draft", "blocked", "clarified", "failed"].includes(t.status)).map((t) => t.id);
                const out = await ticketsApi.queue(project, { action: "clarify", ticketIds: ids, models: waveModels });
                if (out.error) setErr(out.error);
                setShowModels(false);
                refresh();
              } finally { setBusy(false); }
            }}
            title="Start PM clarification runs for every draft/blocked/clarified ticket — answer them together in the Inbox."
          >
            {showModels ? "Start Wave →" : "◎ Clarify Wave"}
          </OutlineButton>
          <Box flex="1" />
          <OutlineButton disabled={busy} onClick={refresh}>⟳ Refresh</OutlineButton>
        </HStack>

        {showModels && (
          <Box mt={3} border="1px solid" borderColor="line" borderRadius="md" p={3}>
            <Text fontSize="10px" color="muted" mb={2} fontFamily="system-ui, sans-serif">
              Models for the wave (leave "auto" to use the project default)
            </Text>
            <Flex gap={2} flexWrap="wrap">
              {["clarify", "builder", "verifier", "security"].map((role) => (
                <Box key={role}>
                  <Text fontSize="10px" color="muted" mb={1} fontFamily="system-ui, sans-serif">{role}</Text>
                  <ModelPicker
                    value={waveModels[role] ?? "auto"}
                    models={models}
                    onChange={(v) => setWaveModels({ ...waveModels, [role]: v === "auto" ? "auto" : v })}
                    compact
                    ariaLabel={`${role} model for wave`}
                  />
                </Box>
              ))}
            </Flex>
          </Box>
        )}

        {err && (
          <Text fontSize="11px" color="#f16a6a" mt={2} fontFamily="system-ui, sans-serif">
            {err}
          </Text>
        )}
      </Box>

      {/* PM inbox */}
      {inbox.length > 0 && (
        <Box border="1px solid" borderColor="#f0b429" borderRadius="lg" bg="surface" p={4}>
          <HStack mb={3}>
            <Text fontSize="14px" fontWeight={700} color="#f0b429" fontFamily="system-ui, sans-serif">
              📥 PM Inbox — {inbox.length} ticket(s) awaiting your answers
            </Text>
          </HStack>
          <Stack gap={3}>
            {inbox.map((item) => (
              <InboxTicket
                key={item.runId}
                item={item}
                onAnswer={async (answers) => {
                  await api.answers(item.runId, answers);
                  refresh();
                }}
              />
            ))}
          </Stack>
        </Box>
      )}

      {/* ticket table */}
      <Box border="1px solid" borderColor="line" borderRadius="lg" bg="surface" p={4}>
        <Flex alignItems="center" mb={3} flexWrap="wrap" gap={2}>
          <Text fontSize="14px" fontWeight={700} fontFamily="system-ui, sans-serif">
            Backlog — {store.project}
          </Text>
          <Box flex="1" />
          <OutlineButton onClick={() => setShowCreate(!showCreate)}>＋ Ticket</OutlineButton>
          <OutlineButton onClick={() => setShowImport(!showImport)}>⤓ Import</OutlineButton>
        </Flex>

        {showCreate && (
          <Stack gap={2} mb={4} border="1px solid" borderColor="line" borderRadius="md" p={3}>
            <Input
              placeholder="Title"
              value={newTitle}
              onChange={(e) => setNewTitle((e.target as HTMLInputElement).value)}
              bg="surface2" borderColor="line" color="ink" fontSize="12px"
            />
            <Textarea
              placeholder="Description — what done looks like. This becomes the PM's brief and the requirements source."
              value={newDesc}
              onChange={(e) => setNewDesc((e.target as HTMLTextAreaElement).value)}
              rows={3}
              bg="surface2" borderColor="line" color="ink" fontSize="12px"
            />
            <Input
              placeholder="Depends on (comma-separated ticket ids, optional)"
              value={newDeps}
              onChange={(e) => setNewDeps((e.target as HTMLInputElement).value)}
              bg="surface2" borderColor="line" color="ink" fontSize="12px"
            />
            <HStack>
              <PrimaryButton
                size="xs"
                disabled={!newTitle.trim()}
                onClick={async () => {
                  try {
                    await ticketsApi.create(project, {
                      title: newTitle,
                      description: newDesc,
                      dependsOn: newDeps.split(",").map((s) => s.trim()).filter(Boolean),
                    });
                    setNewTitle(""); setNewDesc(""); setNewDeps(""); setShowCreate(false);
                    refresh();
                  } catch (e) { setErr(String(e)); }
                }}
              >
                Create Ticket
              </PrimaryButton>
              <OutlineButton size="xs" onClick={() => setShowCreate(false)}>Cancel</OutlineButton>
            </HStack>
          </Stack>
        )}

        {showImport && (
          <Stack gap={2} mb={4} border="1px solid" borderColor="line" borderRadius="md" p={3}>
            <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
              Paste a features markdown doc (## F01 — Title sections), or import from a file in the project:
            </Text>
            <Textarea
              placeholder="# Features&#10;## F01 — …"
              value={importText}
              onChange={(e) => setImportText((e.target as HTMLTextAreaElement).value)}
              rows={5}
              bg="surface2" borderColor="line" color="ink" fontSize="12px" fontFamily="ui-monospace, monospace"
            />
            <HStack>
              <PrimaryButton
                size="xs"
                disabled={!importText.trim()}
                onClick={async () => {
                  try {
                    const r = await ticketsApi.import(project, { markdown: importText });
                    setImportText(""); setShowImport(false);
                    setErr(`Imported ${r.tickets.length} ticket(s) from ${r.sourceDoc ?? "markdown"}`);
                    refresh();
                  } catch (e) { setErr(String(e)); }
                }}
              >
                Import Markdown
              </PrimaryButton>
              <OutlineButton
                size="xs"
                onClick={async () => {
                  try {
                    const r = await ticketsApi.import(project, { path: "docs/features.md" });
                    setImportText(""); setShowImport(false);
                    setErr(`Imported ${r.tickets.length} ticket(s) from ${r.sourceDoc}`);
                    refresh();
                  } catch (e) { setErr(String(e)); }
                }}
              >
                Import docs/features.md
              </OutlineButton>
              <OutlineButton size="xs" onClick={() => setShowImport(false)}>Cancel</OutlineButton>
            </HStack>
          </Stack>
        )}

        {rows.length === 0 ? (
          <Text fontSize="12px" color="muted" fontFamily="system-ui, sans-serif">
            No tickets yet — create one or import the project's features doc.
          </Text>
        ) : (
          <Stack gap={1.5}>
            {rows.map((t) => (
              <TicketRow
                key={t.id}
                t={t}
                onOpenRun={onOpenRun}
                onDelete={async () => { await ticketsApi.remove(project, t.id); refresh(); }}
                onRetry={async () => { await act({ action: "retry", ticketId: t.id }); refresh(); }}
                onReclarify={async () => { await act({ action: "reclarify", ticketId: t.id }); refresh(); }}
              />
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

function TicketRow({
  t, onOpenRun, onDelete, onRetry, onReclarify,
}: {
  t: Ticket;
  onOpenRun: (runId: string) => void;
  onDelete: () => void;
  onRetry: () => void;
  onReclarify: () => void;
}) {
  const meta = STATUS_ICON[t.status] ?? STATUS_ICON.draft;
  return (
    <Flex alignItems="flex-start" gap={2} py={2} px={2} borderRadius="md" border="1px solid" borderColor={t.status === "blocked" ? "#5c2a2a" : "line"} bg={t.status === "running" ? "#141b2e" : "transparent"} flexWrap="wrap">
      <Text fontSize="13px" color={meta.color} fontFamily="ui-monospace, monospace" title={t.status} mt="2px">
        {meta.glyph}
      </Text>
      <Box flex="1" minW="220px">
        <HStack gap={2} flexWrap="wrap">
          <Text fontSize="12px" fontWeight={700} color={ACCENT(t.status)} fontFamily="ui-monospace, monospace">
            {t.id}
          </Text>
          <Text fontSize="12.5px" color={INKC} fontFamily="system-ui, sans-serif">
            {t.title}
          </Text>
          {t.dependsOn.length > 0 && (
            <Text fontSize="10px" color="muted" fontFamily="ui-monospace, monospace">
              ⟵ depends on {t.dependsOn.join(", ")}
            </Text>
          )}
        </HStack>
        {t.blockedReason && (
          <Text fontSize="10.5px" color="#f16a6a" fontFamily="system-ui, sans-serif">
            blocked: {t.blockedReason}
          </Text>
        )}
        <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
          {t.status}
          {t.runId ? " · run " + t.runId : ""}
        </Text>
      </Box>
      <HStack gap={1.5} flexWrap="wrap" alignItems="center">
        {t.runId && (
          <OutlineButton size="xs" onClick={() => onOpenRun(t.runId!)}>
            Open Run
          </OutlineButton>
        )}
        {t.status === "blocked" && (
          <>
            <OutlineButton size="xs" onClick={onRetry} title="Resume the parked run from disk (gates and session kept).">
              Retry
            </OutlineButton>
            <OutlineButton size="xs" onClick={onReclarify} title="Start a fresh PM clarification run seeded with the old spec and the blocker.">
              Re-clarify
            </OutlineButton>
          </>
        )}
        {["draft", "blocked"].includes(t.status) && (
          <DangerOutlineButton size="xs" onClick={onDelete}>✕</DangerOutlineButton>
        )}
      </HStack>
    </Flex>
  );
}
const ACCENT = (_s: string) => "#7aa2f7";
const INKC = "#e4e4e7";

/** One inbox ticket: its pending questions + an answer form. */
function InboxTicket({ item, onAnswer }: { item: InboxItem; onAnswer: (answers: Record<string, string>) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <Box border="1px solid" borderColor="line" borderRadius="md" p={3}>
      <HStack mb={2} flexWrap="wrap">
        <Text fontSize="12px" fontWeight={700} color="#7aa2f7" fontFamily="ui-monospace, monospace">
          {item.ticketId ?? item.runId}
        </Text>
        <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
          Round {item.round} · {item.questions.length} question(s)
        </Text>
      </HStack>
      <Stack gap={2}>
        {item.questions.map((q, i) => (
          <Box key={q.id}>
            <Text fontSize="12px" fontWeight={600} fontFamily="system-ui, sans-serif">
              {i + 1}. {q.question}
            </Text>
            {q.options && q.options.length > 0 && (
              <HStack flexWrap="wrap" gap={1.5} mt={1.5}>
                {q.options.map((o) => {
                  const active = drafts[q.id] === o.label;
                  return (
                    <Box
                      key={o.label}
                      as="button"
                      px={2} py={1} fontSize="11px" borderRadius="sm"
                      border="1px solid"
                      borderColor={active ? "#7aa2f7" : "line"}
                      bg={active ? "#1b2130" : "transparent"}
                      color={active ? "#7aa2f7" : "muted"}
                      onClick={() => setDrafts({ ...drafts, [q.id]: o.label })}
                      fontFamily="system-ui, sans-serif"
                      title={o.tradeoff ?? o.label}
                    >
                      {o.label}
                      {o.recommended ? " ★" : ""}
                    </Box>
                  );
                })}
              </HStack>
            )}
            <Input
              value={drafts[q.id] ?? q.suggested ?? ""}
              onChange={(e) => setDrafts({ ...drafts, [q.id]: (e.target as HTMLInputElement).value })}
              placeholder="Your answer…"
              mt={1.5}
              bg="surface2" borderColor="line" color="ink" fontSize="12px"
              _placeholder={{ color: "#8b91a0" }}
            />
          </Box>
        ))}
      </Stack>
      <HStack mt={3}>
        <PrimaryButton
          size="xs"
          onClick={() =>
            onAnswer(Object.fromEntries(item.questions.map((q) => [q.id, drafts[q.id] ?? q.suggested ?? "(no answer)"])))
          }
        >
          Submit Answers
        </PrimaryButton>
      </HStack>
    </Box>
  );
}
