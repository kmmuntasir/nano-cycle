import { useCallback, useEffect, useState } from "react";
import { Box, Flex, HStack, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  CheckSquare,
  Circle,
  Diamond,
  Download,
  Inbox,
  LoaderCircle,
  MessagesSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Scale,
  Settings,
  Square,
  Star,
  X,
} from "lucide-react";
import { DangerOutlineButton, OutlineButton, PrimaryButton, WarningButton } from "../ui/buttons";
import ModelPicker from "../ui/ModelPicker";
import { SelectEl, selectStyleMini } from "../ui/controls";
import { api, ticketsApi } from "../api";
import type { InboxItem, ModelInfo, RunState, Ticket, TicketStore } from "../api";

const STATUS_ICON: Record<string, { Icon: typeof Circle; color: string; spin?: boolean; fill?: boolean }> = {
  draft: { Icon: Circle, color: "var(--chakra-colors-muted)" },
  clarifying: { Icon: LoaderCircle, color: "var(--chakra-colors-accent)", spin: true },
  clarified: { Icon: Diamond, color: "var(--chakra-colors-accent)", fill: true },
  queued: { Icon: Diamond, color: "var(--chakra-colors-muted)" },
  running: { Icon: Play, color: "var(--chakra-colors-accent)", fill: true },
  done: { Icon: Check, color: "var(--chakra-colors-good)" },
  blocked: { Icon: Ban, color: "var(--chakra-colors-bad)" },
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
  const [showConfig, setShowConfig] = useState(false);
  const [cfgDraft, setCfgDraft] = useState<TicketStore["config"] | null>(null);
  const [showReview, setShowReview] = useState(false);

  const refresh = useCallback(() => {
    ticketsApi.store(project).then(setStore).catch((e) => setErr(String(e)));
    ticketsApi.inbox(project).then((r) => setInbox(r.items)).catch(() => {});
  }, [project]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // The App's socket dispatches every broadcast here — queue/tickets messages
  // refresh instantly instead of waiting for the 4s poll.
  useEffect(() => {
    const onWs = (e: Event) => {
      const msg = (e as CustomEvent<{ type?: string; project?: string }>).detail;
      if (msg?.type === "queue" || msg?.type === "tickets") {
        if (!msg.project || msg.project === project) refresh();
      }
    };
    window.addEventListener("nano-ws", onWs);
    return () => window.removeEventListener("nano-ws", onWs);
  }, [project, refresh]);

  const act = useCallback(
    async (body: { action: string; ticketIds?: string[]; ticketId?: string; orderedIds?: string[]; models?: Record<string, string>; options?: Record<string, unknown> }) => {
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

  // Direct "Run now" (plan §6): a plain v2 run seeded from the ticket text —
  // bypasses the queue, respects the tree lock, uses the queue config's models.
  const runNow = useCallback(
    async (t: Ticket) => {
      setBusy(true);
      setErr(null);
      try {
        const cfg = store?.config;
        const s = await api.start([t.title, t.description].filter(Boolean).join("\n\n"), project, cfg?.models ?? {}, {
          maxFixRounds: cfg?.options.maxFixRounds,
          git: cfg?.options.git,
          audit: cfg?.options.audit,
          remoteChecks: cfg?.options.remoteChecks,
          security: cfg?.options.security,
          ticketId: t.id,
        });
        onOpenRun(s.id);
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    },
    [project, store, onOpenRun],
  );

  // Reorder among QUEUED tickets (§6): swap with the adjacent queued ticket and
  // persist the full display order; the pump promotes by it.
  // NOTE: must live ABOVE the !store early return — hooks may not be
  // conditional, or the hook count changes between renders (React #310).
  const move = useCallback(
    async (t: Ticket, dir: -1 | 1) => {
      if (!store) return;
      const ordered = [...store.tickets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const queuedPositions = ordered.map((x, k) => ({ x, k })).filter(({ x }) => x.status === "queued");
      const pos = queuedPositions.findIndex(({ x }) => x.id === t.id);
      const neighbor = queuedPositions[pos + dir];
      if (pos < 0 || !neighbor) return;
      const i = ordered.findIndex((x) => x.id === t.id);
      [ordered[i], ordered[neighbor.k]] = [ordered[neighbor.k], ordered[i]];
      await act({ action: "reorder", orderedIds: ordered.map((x) => x.id) });
    },
    [store, act],
  );

  if (!store) {
    return (
      <Box border="1px dashed" borderColor="line" borderRadius="md" p={6} textAlign="center">
        <Text fontSize="13px" color="ink" fontFamily="system-ui, sans-serif">Loading tickets…</Text>
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
          <Box px={2} py={0.5} borderRadius="sm" border="1px solid" borderColor={q.state === "running" ? "accent" : "line"} bg={q.state === "running" ? "surface2" : "transparent"}>
            <Text fontSize="11px" color={q.state === "running" ? "accent" : "muted"} fontFamily="ui-monospace, monospace">
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
            onClick={() => setShowReview(true)}
            title="Review every locked spec in a batch, then release the selected tickets for sequential delivery."
          >
            <Box as="span" display="inline-flex" alignItems="center" gap={1.5}>
              <Scale size={13} /> Review &amp; Release{clarified.length > 0 ? ` ${clarified.length}` : ""}
            </Box>
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
            disabled={busy || rows.every((t) => !["draft", "blocked", "clarified"].includes(t.status))}
            onClick={async () => {
              if (!showModels) { setShowModels(true); return; }
              setBusy(true);
              try {
                await ticketsApi.queue(project, { action: "config", models: waveModels });
                const ids = rows.filter((t) => ["draft", "blocked", "clarified"].includes(t.status)).map((t) => t.id);
                const out = await ticketsApi.queue(project, { action: "clarify", ticketIds: ids, models: waveModels });
                if (out.error) setErr(out.error);
                setShowModels(false);
                refresh();
              } finally { setBusy(false); }
            }}
            title="Start PM clarification runs for every draft/blocked/clarified ticket — answer them together in the Inbox."
          >
            {showModels ? "Start Wave →" : (
              <Box as="span" display="inline-flex" alignItems="center" gap={1.5}>
                <MessagesSquare size={13} /> Clarify Wave
              </Box>
            )}
          </OutlineButton>
          <Box flex="1" />
          <OutlineButton
            disabled={busy}
            onClick={() => {
              if (!showConfig) setCfgDraft(JSON.parse(JSON.stringify(store.config)) as TicketStore["config"]);
              setShowConfig(!showConfig);
            }}
            title="Queue-mode run defaults — models, fix rounds, security, git. Every wave/promotion runs with these."
          >
            <Box as="span" display="inline-flex" alignItems="center" gap={1.5}>
              <Settings size={13} /> Config
            </Box>
          </OutlineButton>
          <OutlineButton disabled={busy} onClick={refresh}>
            <Box as="span" display="inline-flex" alignItems="center" gap={1.5}>
              <RefreshCw size={13} /> Refresh
            </Box>
          </OutlineButton>
        </HStack>

        {showConfig && cfgDraft && (
          <Box mt={3} border="1px solid" borderColor="line" borderRadius="md" p={3}>
            <Text fontSize="10px" color="muted" mb={2} fontFamily="system-ui, sans-serif">
              Queue config — run defaults for every wave and promotion (the queue always runs with plan approval OFF; the spec is the owner gate)
            </Text>
            <Flex gap={2} flexWrap="wrap" mb={2}>
              {["clarify", "builder", "verifier", "security"].map((role) => (
                <Box key={role}>
                  <Text fontSize="10px" color="muted" mb={1} fontFamily="system-ui, sans-serif">{role}</Text>
                  <ModelPicker
                    value={cfgDraft.models[role] ?? "auto"}
                    models={models}
                    onChange={(v) => setCfgDraft({ ...cfgDraft, models: { ...cfgDraft.models, [role]: v } })}
                    compact
                    ariaLabel={`${role} model`}
                  />
                </Box>
              ))}
            </Flex>
            <Flex gap={3} flexWrap="wrap" alignItems="flex-end">
              <Box>
                <Text fontSize="10px" color="muted" mb={1} fontFamily="system-ui, sans-serif">Fix rounds (0–5)</Text>
                <Input
                  type="number" min={0} max={5} width="90px" value={String(cfgDraft.options.maxFixRounds)}
                  onChange={(e) => {
                    const n = Math.max(0, Math.min(5, Number((e.target as HTMLInputElement).value) || 0));
                    setCfgDraft({ ...cfgDraft, options: { ...cfgDraft.options, maxFixRounds: n } });
                  }}
                  bg="surface2" borderColor="line" color="ink" fontSize="12px"
                />
              </Box>
              <Box>
                <Text fontSize="10px" color="muted" mb={1} fontFamily="system-ui, sans-serif">Security</Text>
                <SelectEl
                  css={{ ...selectStyleMini, width: "130px" }}
                  value={cfgDraft.options.security}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, options: { ...cfgDraft.options, security: (e.target as HTMLSelectElement).value as TicketStore["config"]["options"]["security"] } })}
                >
                  <option value="off">off</option>
                  <option value="scan">scan</option>
                  <option value="scan+vapt">scan+vapt</option>
                </SelectEl>
              </Box>
              {([
                ["git", "Git (branch + verdict-gated merge)"],
                ["audit", "Audit phase"],
                ["remoteChecks", "Remote CI"],
              ] as const).map(([key, label]) => (
                <Box
                  key={key}
                  as="button"
                  px={2} py={1.5} fontSize="11px" borderRadius="sm"
                  border="1px solid"
                  borderColor={cfgDraft.options[key] ? "accent" : "line"}
                  bg={cfgDraft.options[key] ? "surface2" : "transparent"}
                  color={cfgDraft.options[key] ? "accent" : "muted"}
                  onClick={() => setCfgDraft({ ...cfgDraft, options: { ...cfgDraft.options, [key]: !cfgDraft.options[key] } })}
                  fontFamily="system-ui, sans-serif"
                >
                  <Box as="span" display="inline-flex" alignItems="center" gap={1}>
                    {cfgDraft.options[key] ? <CheckSquare size={12} /> : <Square size={12} />} {label}
                  </Box>
                </Box>
              ))}
              <PrimaryButton
                size="xs"
                onClick={async () => {
                  await act({ action: "config", models: cfgDraft.models, options: cfgDraft.options as unknown as Record<string, unknown> });
                  setShowConfig(false);
                }}
              >
                Save Config
              </PrimaryButton>
            </Flex>
          </Box>
        )}

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
          <Text fontSize="11px" color="bad" mt={2} fontFamily="system-ui, sans-serif">
            {err}
          </Text>
        )}
      </Box>

      {/* release gate — the ONE deliberate human moment: batch spec review */}
      {showReview && clarified.length > 0 && (
        <ReleaseReview
          tickets={clarified}
          busy={busy}
          onClose={() => setShowReview(false)}
          onRelease={async (ids) => {
            await act({ action: "release", ticketIds: ids });
            setShowReview(false);
          }}
        />
      )}

      {/* PM inbox */}
      {(inbox.length > 0 || q.state === "clarifying") && (
        <Box border="1px solid" borderColor={inbox.length > 0 ? "warn" : "line"} borderRadius="lg" bg="surface" p={4}>
          <HStack mb={3}>
            <Box as="span" display="inline-flex" alignItems="center" gap={1.5} fontSize="14px" fontWeight={700} color={inbox.length > 0 ? "warn" : "muted"} fontFamily="system-ui, sans-serif">
              <Inbox size={15} />
              {inbox.length > 0 ? `PM Inbox — ${inbox.length} ticket(s) awaiting your answers` : "PM Inbox"}
            </Box>
          </HStack>
          {inbox.length === 0 ? (
            <Text fontSize="11px" color="muted" fontFamily="system-ui, sans-serif">
              no questions pending — the PMs are still investigating
            </Text>
          ) : (
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
          )}
        </Box>
      )}

      {/* ticket table */}
      <Box border="1px solid" borderColor="line" borderRadius="lg" bg="surface" p={4}>
        <Flex alignItems="center" mb={3} flexWrap="wrap" gap={2}>
          <Text fontSize="14px" fontWeight={700} fontFamily="system-ui, sans-serif">
            Backlog — {store.project}
          </Text>
          <Box flex="1" />
          <OutlineButton onClick={() => setShowCreate(!showCreate)}>
            <Box as="span" display="inline-flex" alignItems="center" gap={1}>
              <Plus size={12} /> Ticket
            </Box>
          </OutlineButton>
          <OutlineButton onClick={() => setShowImport(!showImport)}>
            <Box as="span" display="inline-flex" alignItems="center" gap={1}>
              <Download size={12} /> Import
            </Box>
          </OutlineButton>
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
              Paste a features doc — headings (## F01 — Title 🔴) or checkbox lists (- [x] **F01 — Title**) — or import from a file in the project. Other formats: import via an agent (nano-cycle MCP).
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
                    setErr(`Imported ${r.created.length} ticket(s)${r.skipped.length ? `, skipped ${r.skipped.length} existing` : ""} from ${r.sourceDoc ?? "markdown"}`);
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
                    setErr(`Imported ${r.created.length} ticket(s)${r.skipped.length ? `, skipped ${r.skipped.length} existing` : ""} from ${r.sourceDoc}`);
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
            {rows.map((t) => {
              const queuedIds = rows.filter((x) => x.status === "queued").map((x) => x.id);
              return (
              <TicketRow
                key={t.id}
                t={t}
                isFirstQueued={queuedIds[0] === t.id}
                isLastQueued={queuedIds[queuedIds.length - 1] === t.id}
                onOpenRun={onOpenRun}
                onDelete={async () => { await ticketsApi.remove(project, t.id); refresh(); }}
                onRetry={async () => { await act({ action: "retry", ticketId: t.id }); refresh(); }}
                onReclarify={async () => { await act({ action: "reclarify", ticketId: t.id }); refresh(); }}
                onRunNow={runNow}
                onMove={move}
                onEdit={async (patch) => {
                  try {
                    await ticketsApi.update(project, t.id, patch);
                    refresh();
                  } catch (e) { setErr(String(e)); }
                }}
              />
              );
            })}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

function TicketRow({
  t, onOpenRun, onDelete, onRetry, onReclarify, onRunNow, onMove, onEdit, isFirstQueued, isLastQueued,
}: {
  t: Ticket;
  onOpenRun: (runId: string) => void;
  onDelete: () => void;
  onRetry: () => void;
  onReclarify: () => void;
  onRunNow: (t: Ticket) => void;
  onMove: (t: Ticket, dir: -1 | 1) => void;
  onEdit: (patch: Partial<Ticket>) => void;
  isFirstQueued: boolean;
  isLastQueued: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [description, setDescription] = useState(t.description);
  const [dependsOn, setDependsOn] = useState(t.dependsOn.join(", "));
  const [order, setOrder] = useState(String(t.order ?? 0));
  const meta = STATUS_ICON[t.status] ?? STATUS_ICON.draft;
  const editable = !["running", "clarifying"].includes(t.status);
  const StatusIcon = meta.Icon;
  return (
    <Flex alignItems="flex-start" gap={2} py={2} px={2} borderRadius="md" border="1px solid" borderColor={t.status === "blocked" ? "bad" : "line"} bg={t.status === "running" ? "surface2" : "transparent"} flexWrap="wrap">
      <Box mt="2px" color={meta.color} style={meta.spin ? { animation: "ncSpin 1.2s linear infinite" } : undefined} title={t.status}>
        <StatusIcon size={14} fill={meta.fill ? "currentColor" : "none"} />
      </Box>
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
          <Text fontSize="10.5px" color="bad" fontFamily="system-ui, sans-serif">
            blocked: {t.blockedReason}
          </Text>
        )}
        <Text fontSize="10px" color="muted" fontFamily="system-ui, sans-serif">
          {t.status}
          {t.runId ? " · run " + t.runId : ""}
        </Text>
        {editing && (
          <Stack gap={2} mt={2}>
            <Input
              placeholder="Title" value={title}
              onChange={(e) => setTitle((e.target as HTMLInputElement).value)}
              bg="surface2" borderColor="line" color="ink" fontSize="12px"
            />
            <Textarea
              placeholder="Description" value={description} rows={3}
              onChange={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              bg="surface2" borderColor="line" color="ink" fontSize="12px"
            />
            <Flex gap={2} flexWrap="wrap" alignItems="center">
              <Input
                placeholder="Depends on (comma-separated ids)" value={dependsOn} flex="1" minW="200px"
                onChange={(e) => setDependsOn((e.target as HTMLInputElement).value)}
                bg="surface2" borderColor="line" color="ink" fontSize="12px"
              />
              <Input
                placeholder="Order" value={order} width="80px"
                onChange={(e) => setOrder((e.target as HTMLInputElement).value)}
                bg="surface2" borderColor="line" color="ink" fontSize="12px"
              />
              <PrimaryButton
                size="xs"
                onClick={() => {
                  onEdit({
                    title,
                    description,
                    dependsOn: dependsOn.split(",").map((s) => s.trim()).filter(Boolean),
                    order: Number(order) || 0,
                  });
                  setEditing(false);
                }}
              >
                Save
              </PrimaryButton>
              <OutlineButton size="xs" onClick={() => setEditing(false)}>Cancel</OutlineButton>
            </Flex>
          </Stack>
        )}
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
        {t.status === "queued" && (
          <>
            <OutlineButton size="xs" disabled={isFirstQueued} onClick={() => onMove(t, -1)} title="Move earlier in the build order (queued tickets only).">
              <ArrowUp size={12} />
            </OutlineButton>
            <OutlineButton size="xs" disabled={isLastQueued} onClick={() => onMove(t, 1)} title="Move later in the build order (queued tickets only).">
              <ArrowDown size={12} />
            </OutlineButton>
          </>
        )}
        {["draft", "blocked"].includes(t.status) && (
          <OutlineButton size="xs" onClick={() => onRunNow(t)} title="Start a plain run for this ticket now — bypasses the queue, respects the tree lock.">
            <Box as="span" display="inline-flex" alignItems="center" gap={1}>
              <Play size={12} /> Run
            </Box>
          </OutlineButton>
        )}
        {editable && (
          <OutlineButton size="xs" onClick={() => setEditing(!editing)} title="Edit title, description, dependencies, order.">
            <Pencil size={12} />
          </OutlineButton>
        )}
        {["draft", "blocked"].includes(t.status) && (
          <DangerOutlineButton size="xs" onClick={onDelete}>
            <X size={12} />
          </DangerOutlineButton>
        )}
      </HStack>
    </Flex>
  );
}
const ACCENT = (_s: string) => "accent";
const INKC = "ink";

/** One inbox ticket: its pending questions + an answer form. */
function InboxTicket({ item, onAnswer }: { item: InboxItem; onAnswer: (answers: Record<string, string>) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <Box border="1px solid" borderColor="line" borderRadius="md" p={3}>
      <HStack mb={2} flexWrap="wrap">
        <Text fontSize="12px" fontWeight={700} color="accent" fontFamily="ui-monospace, monospace">
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
                      borderColor={active ? "accent" : "line"}
                      bg={active ? "surface2" : "transparent"}
                      color={active ? "accent" : "muted"}
                      onClick={() => setDrafts({ ...drafts, [q.id]: o.label })}
                      fontFamily="system-ui, sans-serif"
                      title={o.tradeoff ?? o.label}
                    >
                      {o.label}
                      {o.recommended ? <Star size={11} /> : null}
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
              _placeholder={{ color: "muted" }}
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

interface SpecDigest {
  summary?: string;
  decisions?: { topic: string; decision: string }[];
  acceptance_criteria?: string[];
}

/** The release gate (§7): every clarified ticket's spec in one batch — review,
 *  uncheck anything not ready, release the selected tickets into the queue. */
function ReleaseReview({ tickets, busy, onClose, onRelease }: {
  tickets: Ticket[];
  busy: boolean;
  onClose: () => void;
  onRelease: (ids: string[]) => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(tickets.map((t) => [t.id, true])));
  const [specs, setSpecs] = useState<Record<string, SpecDigest | null>>({});
  const idsKey = tickets.map((t) => t.id).join(",");
  useEffect(() => {
    let live = true;
    for (const t of tickets) {
      if (!t.runId) continue;
      api.getRun(t.runId)
        .then((r) => {
          if (!live) return;
          const spec = (r.state.artifacts as Record<string, unknown>).spec as SpecDigest | undefined;
          setSpecs((s) => ({ ...s, [t.id]: spec ?? null }));
        })
        .catch(() => {
          if (live) setSpecs((s) => ({ ...s, [t.id]: null }));
        });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  const selected = tickets.filter((t) => checked[t.id] !== false);
  return (
    <Box border="1px solid" borderColor="accent" borderRadius="lg" bg="surface" p={4}>
      <HStack mb={3} flexWrap="wrap">
        <Box as="span" display="inline-flex" alignItems="center" gap={1.5} fontSize="14px" fontWeight={700} color="accent" fontFamily="system-ui, sans-serif">
          <Scale size={15} /> Release Gate — review {tickets.length} locked spec(s)
        </Box>
        <Box flex="1" />
        <OutlineButton size="xs" onClick={onClose}>
          <Box as="span" display="inline-flex" alignItems="center" gap={1}>
            <X size={12} /> Close
          </Box>
        </OutlineButton>
      </HStack>
      <Stack gap={2}>
        {tickets.map((t) => {
          const spec = t.runId ? specs[t.id] : null;
          const on = checked[t.id] !== false;
          return (
            <Box key={t.id} border="1px solid" borderColor={on ? "line" : "bad"} borderRadius="md" p={3}>
              <Flex gap={2} alignItems="flex-start">
                <Box
                  as="button"
                  mt="2px"
                  onClick={() => setChecked({ ...checked, [t.id]: !on })}
                  fontSize="14px"
                  color={on ? "accent" : "muted"}
                  title={on ? "Release this ticket" : "Hold this ticket back"}
                >
                  {on ? <CheckSquare size={15} /> : <Square size={15} />}
                </Box>
                <Box flex="1">
                  <HStack gap={2} flexWrap="wrap">
                    <Text fontSize="12px" fontWeight={700} color="accent" fontFamily="ui-monospace, monospace">{t.id}</Text>
                    <Text fontSize="12.5px" color="ink" fontFamily="system-ui, sans-serif">{t.title}</Text>
                  </HStack>
                  {spec === undefined ? (
                    <Text fontSize="10.5px" color="muted" fontFamily="system-ui, sans-serif" mt={1}>loading spec…</Text>
                  ) : spec === null ? (
                    <Text fontSize="10.5px" color="muted" fontFamily="system-ui, sans-serif" mt={1}>
                      no spec on the run (clarify-off ticket) — review the ticket text itself
                    </Text>
                  ) : (
                    <Box mt={1}>
                      <Text fontSize="11.5px" color="ink" fontFamily="system-ui, sans-serif">{spec.summary}</Text>
                      {(spec.decisions ?? []).length > 0 && (
                        <Text fontSize="10.5px" color="muted" fontFamily="system-ui, sans-serif" mt={1}>
                          {(spec.decisions ?? []).map((d) => `${d.topic}: ${d.decision}`).join(" · ")}
                        </Text>
                      )}
                      {(spec.acceptance_criteria ?? []).length > 0 && (
                        <Stack gap={0.5} mt={1}>
                          <Text fontSize="10px" color="muted" fontWeight={700} fontFamily="system-ui, sans-serif">acceptance criteria</Text>
                          {(spec.acceptance_criteria ?? []).map((c, i) => (
                            <Text key={i} fontSize="10.5px" color="ink" fontFamily="system-ui, sans-serif">- {c}</Text>
                          ))}
                        </Stack>
                      )}
                    </Box>
                  )}
                </Box>
              </Flex>
            </Box>
          );
        })}
      </Stack>
      <HStack mt={3}>
        <PrimaryButton
          disabled={busy || selected.length === 0}
          onClick={() => onRelease(selected.map((t) => t.id))}
          title="Queue the selected tickets for sequential delivery (build → verify → security per ticket)."
        >
          <Box as="span" display="inline-flex" alignItems="center" gap={1.5}>
            <Play size={13} /> Release {selected.length} Ticket(s) →
          </Box>
        </PrimaryButton>
      </HStack>
    </Box>
  );
}
