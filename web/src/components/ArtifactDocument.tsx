// Document-style artifact renderers — the milestone artifacts (verify, audit,
// security, plan, tasks, implDelta, spec) rendered as readable documents with
// a floating raw-JSON toggle, instead of raw JSON blobs.
import { useMemo, useState } from "react";
import { Box, Flex, HStack, Link, Stack, Text } from "@chakra-ui/react";
import { CheckCircle, XCircle, Circle, AlertTriangle } from "lucide-react";

const INK = "#e4e4e7";
const MUTED = "#9aa1b5";
const RULE = "#262b38";
const GOOD = "#4fd6a8";
const BAD = "#f16a6a";
const WARN = "#f0b429";
const ACCENT = "#7aa2f7";
const FAIL_BG = "rgba(241,106,106,0.10)";
const PASS_BG = "rgba(79,214,168,0.12)";

export const DOCUMENTED = new Set([
  "verify",
  "audit",
  "security",
  "plan",
  "tasks",
  "implDelta",
  "spec",
  "checks:mechanical",
  "checks:remote-ci",
  "checks:scanners",
  "checks:deferred",
]);

// --- shared pieces -----------------------------------------------------------

function Tag({ children, color, bg }: { children: React.ReactNode; color: string; bg: string }) {
  return (
    <Box
      as="span"
      fontSize="10px"
      fontWeight={700}
      px={2}
      py={1}
      borderRadius="sm"
      border="1px solid"
      borderColor={color}
      bg={bg}
      color={color}
      whiteSpace="nowrap"
      fontFamily="ui-monospace, monospace"
    >
      {children}
    </Box>
  );
}

function PassTag({ pass }: { pass: boolean }) {
  return <Tag color={pass ? GOOD : BAD} bg={pass ? PASS_BG : FAIL_BG}>{pass ? "pass" : "fail"}</Tag>;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Box
      as="button"
      fontSize="10px"
      px={2}
      py={1}
      borderRadius="sm"
      border="1px solid"
      borderColor={RULE}
      color={MUTED}
      cursor="pointer"
      _hover={{ color: INK, borderColor: "#3a4358" }}
      fontFamily="system-ui, sans-serif"
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        const finish = (ok: boolean) => {
          setDone(ok);
          setTimeout(() => setDone(false), 1500);
        };
        navigator.clipboard?.writeText(text).then(() => finish(true), () => finish(false));
      }}
    >
      {done ? "Copied ✓" : label}
    </Box>
  );
}

function FilterButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <Box
      as="button"
      fontSize="11px"
      px={2.5}
      py={1}
      borderRadius="full"
      border="1px solid"
      borderColor={active ? INK : RULE}
      bg={active ? INK : "transparent"}
      color={active ? "#151821" : MUTED}
      cursor="pointer"
      _hover={{ color: INK }}
      fontFamily="system-ui, sans-serif"
      onClick={onClick}
    >
      {label} <Text as="span" opacity={0.65}>{count}</Text>
    </Box>
  );
}

function Stamp({ verdict }: { verdict: string }) {
  const ok = verdict === "accepted" || verdict === "pass";
  const failed = verdict === "gaps-found" || verdict === "findings";
  const label = ok ? "Passed" : failed ? "Gaps Found" : verdict;
  const color = ok ? GOOD : failed ? BAD : MUTED;
  const bg = ok ? PASS_BG : failed ? FAIL_BG : "transparent";
  return (
    <Box
      display="inline-block"
      px={4}
      py={2}
      borderRadius="sm"
      border="1px solid"
      borderColor={color}
      color={color}
      bg={bg}
      fontSize="18px"
      fontWeight={700}
      letterSpacing="0.02em"
      fontFamily="system-ui, sans-serif"
    >
      {label}
    </Box>
  );
}

function DocSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box mb={6}>
      <Text fontSize="16px" fontWeight={700} color={INK} mb={3} fontFamily="system-ui, sans-serif">
        {title}
      </Text>
      {children}
    </Box>
  );
}

function EvidenceBlock({ text, fail }: { text: string; fail?: boolean }) {
  const [open, setOpen] = useState(!!fail);
  return (
    <Box mt={3}>
      <Flex alignItems="center" gap={2} mb={open ? 1 : 0}>
        <Text fontSize="10px" color={MUTED} letterSpacing="wide" fontFamily="system-ui, sans-serif">
          EVIDENCE
        </Text>
        <Box
          as="button"
          fontSize="10px"
          color={ACCENT}
          cursor="pointer"
          fontFamily="system-ui, sans-serif"
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide" : "Show"}
        </Box>
        <CopyButton text={text} label="Copy evidence" />
      </Flex>
      {open && (
        <Text
          fontSize="12px"
          lineHeight={1.7}
          color="#c9cdd8"
          borderLeft="2px solid"
          borderLeftColor={fail ? BAD : RULE}
          pl={3}
          whiteSpace="pre-wrap"
          fontFamily="system-ui, sans-serif"
          wordBreak="break-word"
        >
          {text}
        </Text>
      )}
    </Box>
  );
}

function NotesBlock({ notes }: { notes?: string }) {
  if (!notes) return null;
  return (
    <DocSection title="notes">
      <Box bg="#1b2130" borderLeft="4px solid" borderColor={ACCENT} borderRadius="0 4px 4px 0" p={4}>
        <Text fontSize="12px" lineHeight={1.7} color="#c9cdd8" whiteSpace="pre-wrap" fontFamily="system-ui, sans-serif">
          {notes}
        </Text>
        <Box mt={2}>
          <CopyButton text={notes} label="Copy notes" />
        </Box>
      </Box>
    </DocSection>
  );
}

// --- verify ------------------------------------------------------------------

function VerifyDoc({ data }: { data: any }) {
  const checks: { criterion: string; pass: boolean; evidence: string }[] = data?.checks ?? [];
  const [filter, setFilter] = useState<"all" | "true" | "false">("all");
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  const passCount = checks.filter((c) => c.pass).length;
  const shown = checks.filter((c) => filter === "all" || String(c.pass) === filter);
  return (
    <>
      <Box mb={6} pb={4} borderBottom="1px solid" borderColor={RULE}>
        <Text fontSize="12px" fontStyle="italic" color={MUTED} mb={2} fontFamily="system-ui, sans-serif">
          verdict
        </Text>
        <Stamp verdict={data?.verdict ?? "unknown"} />
      </Box>
      <DocSection title={`checks (${passCount}/${checks.length} pass)`}>
        <Flex gap={2} flexWrap="wrap" mb={2}>
          <FilterButton label="All" count={checks.length} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterButton label="pass" count={passCount} active={filter === "true"} onClick={() => setFilter("true")} />
          <FilterButton label="fail" count={checks.length - passCount} active={filter === "false"} onClick={() => setFilter("false")} />
          <Box flex="1" />
          <FilterButton label="Expand all" count={0} active={false} onClick={() => setAllOpen(true)} />
          <FilterButton label="Collapse all" count={0} active={false} onClick={() => setAllOpen(false)} />
        </Flex>
        {shown.map((c, i) => (
          <CheckCard key={i} criterion={c.criterion} pass={c.pass} evidence={c.evidence} allOpen={allOpen} />
        ))}
        {shown.length === 0 && (
          <Text fontSize="12px" color={MUTED} fontStyle="italic" fontFamily="system-ui, sans-serif">
            No checks match this filter.
          </Text>
        )}
      </DocSection>
      <NotesBlock notes={data?.notes} />
    </>
  );
}

function CheckCard({ criterion, pass, evidence, allOpen }: { criterion: string; pass: boolean; evidence: string; allOpen: boolean | null }) {
  const [open, setOpen] = useState(!pass);
  const isOpen = allOpen === null ? open : allOpen;
  return (
    <Box
      mb={2}
      p={3}
      borderRadius="md"
      bg={pass ? "transparent" : FAIL_BG}
      borderLeft="4px solid"
      borderLeftColor={pass ? RULE : BAD}
    >
      <Flex gap={3} alignItems="flex-start">
        {pass ? (
          <CheckCircle size={18} color={GOOD} style={{ flexShrink: 0, marginTop: 2 }} />
        ) : (
          <XCircle size={18} color={BAD} style={{ flexShrink: 0, marginTop: 2 }} />
        )}
        <Box flex="1" minW={0}>
          <Flex alignItems="flex-start" gap={2} flexWrap="wrap">
            <Text fontSize="13px" fontWeight={600} color={INK} flex="1" minWidth="220px" fontFamily="system-ui, sans-serif">
              {criterion}
            </Text>
            <PassTag pass={pass} />
          </Flex>
          {(isOpen || allOpen !== null) && (
            <EvidenceBlock text={evidence} fail={!pass} />
          )}
        </Box>
      </Flex>
    </Box>
  );
}

// --- audit -------------------------------------------------------------------

function AuditDoc({ data }: { data: any }) {
  const findings: { category: string; blocking: boolean; file?: string; issue: string; fix?: string }[] = data?.findings ?? [];
  const blocking = findings.filter((f) => f.blocking);
  const [filter, setFilter] = useState<"all" | "blocking" | "minor">("all");
  const shown = findings.filter((f) => filter === "all" || (filter === "blocking") === f.blocking);
  return (
    <>
      <Box mb={6} pb={4} borderBottom="1px solid" borderColor={RULE}>
        <Text fontSize="12px" fontStyle="italic" color={MUTED} mb={2} fontFamily="system-ui, sans-serif">
          verdict
        </Text>
        <Stamp verdict={data?.verdict ?? "unknown"} />
        {blocking.length > 0 && (
          <Text fontSize="11px" color={BAD} mt={2} fontFamily="system-ui, sans-serif">
            {blocking.length} blocking finding(s) — these force a fix round
          </Text>
        )}
      </Box>
      <DocSection title={`findings (${blocking.length} blocking / ${findings.length - blocking.length} minor)`}>
        <Flex gap={2} flexWrap="wrap" mb={2}>
          <FilterButton label="All" count={findings.length} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterButton label="blocking" count={blocking.length} active={filter === "blocking"} onClick={() => setFilter("blocking")} />
          <FilterButton label="minor" count={findings.length - blocking.length} active={filter === "minor"} onClick={() => setFilter("minor")} />
        </Flex>
        {shown.map((f, i) => (
          <Box key={i} mb={2} p={3} borderRadius="md" bg={f.blocking ? FAIL_BG : "transparent"} borderLeft="4px solid" borderLeftColor={f.blocking ? BAD : RULE}>
            <Flex alignItems="flex-start" gap={2} flexWrap="wrap">
              <Tag color={f.blocking ? BAD : MUTED} bg={f.blocking ? FAIL_BG : "transparent"}>{f.category}</Tag>
              <Text fontSize="12.5px" color={INK} flex="1" minWidth="220px" fontFamily="system-ui, sans-serif">
                {f.file && <Text as="span" color={ACCENT} fontFamily="ui-monospace, monospace" fontSize="11px" mr={2}>{f.file}</Text>}
                {f.issue}
              </Text>
            </Flex>
            {f.fix && (
              <Text fontSize="11.5px" color="#c9cdd8" mt={2} pl={3} borderLeft="2px solid" borderLeftColor={RULE} fontFamily="system-ui, sans-serif">
                fix: {f.fix}
              </Text>
            )}
          </Box>
        ))}
        {findings.length === 0 && (
          <Text fontSize="12px" color={GOOD} fontStyle="italic" fontFamily="system-ui, sans-serif">
            No findings — the deliverables conform to the requirements and rules.
          </Text>
        )}
      </DocSection>
      <NotesBlock notes={data?.notes} />
    </>
  );
}

// --- security ----------------------------------------------------------------

const SEV_COLOR: Record<string, string> = { critical: BAD, high: BAD, medium: WARN, low: MUTED, info: MUTED };

function SecurityDoc({ data }: { data: any }) {
  const findings: any[] = data?.findings ?? [];
  const gate = findings.filter((f) => f.severity === "critical" || f.severity === "high");
  const [filter, setFilter] = useState<"all" | "gate" | "rest">("all");
  const shown = findings.filter((f) =>
    filter === "all" || (filter === "gate" ? gate.includes(f) : !gate.includes(f)),
  );
  return (
    <>
      <Box mb={6} pb={4} borderBottom="1px solid" borderColor={RULE}>
        <Text fontSize="12px" fontStyle="italic" color={MUTED} mb={2} fontFamily="system-ui, sans-serif">
          verdict
        </Text>
        <Stamp verdict={data?.verdict ?? "unknown"} />
        <Text fontSize="11px" color={MUTED} mt={2} fontFamily="system-ui, sans-serif">
          {gate.filter((f) => f.fixable_in_scope).length} fixable gate finding(s) · {findings.length - gate.length} below the gate
        </Text>
      </Box>
      <DocSection title={`findings (${findings.length})`}>
        <Flex gap={2} flexWrap="wrap" mb={2}>
          <FilterButton label="All" count={findings.length} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterButton label="critical/high" count={gate.length} active={filter === "gate"} onClick={() => setFilter("gate")} />
          <FilterButton label="medium & below" count={findings.length - gate.length} active={filter === "rest"} onClick={() => setFilter("rest")} />
        </Flex>
        {shown.map((f, i) => (
          <Box key={f.id ?? i} mb={2} p={3} borderRadius="md" bg={SEV_COLOR[f.severity] === BAD ? FAIL_BG : "transparent"} borderLeft="4px solid" borderLeftColor={SEV_COLOR[f.severity] ?? RULE}>
            <Flex alignItems="flex-start" gap={2} flexWrap="wrap">
              <Tag color={SEV_COLOR[f.severity] ?? MUTED} bg="transparent">{f.severity}</Tag>
              <Tag color={MUTED} bg="transparent">{f.source}</Tag>
              <Text fontSize="12.5px" fontWeight={600} color={INK} flex="1" minWidth="200px" fontFamily="system-ui, sans-serif">
                {f.title}
              </Text>
              <Tag color={f.fixable_in_scope ? WARN : MUTED} bg="transparent">
                {f.fixable_in_scope ? "fixable in scope" : "owner action"}
              </Tag>
            </Flex>
            {f.file && (
              <Text fontSize="11px" color={ACCENT} mt={1} fontFamily="ui-monospace, monospace">
                {f.file}
              </Text>
            )}
            <Text fontSize="12px" color="#c9cdd8" mt={1} pl={3} borderLeft="2px solid" borderLeftColor={RULE} whiteSpace="pre-wrap" fontFamily="system-ui, sans-serif">
              {f.evidence}
            </Text>
            {f.fix && (
              <Text fontSize="11.5px" color={MUTED} mt={1} fontFamily="system-ui, sans-serif">
                fix: {f.fix}
              </Text>
            )}
          </Box>
        ))}
        {findings.length === 0 && (
          <Text fontSize="12px" color={GOOD} fontStyle="italic" fontFamily="system-ui, sans-serif">
            No findings — scanners and manual probes came back clean.
          </Text>
        )}
      </DocSection>
      <NotesBlock notes={data?.notes} />
    </>
  );
}

// --- plan / tasks / implDelta / spec ----------------------------------------

function List({ items, color = "#c9cdd8", mark = "•" }: { items: string[]; color?: string; mark?: string }) {
  return (
    <Stack gap={1}>
      {items.map((it, i) => (
        <Text key={i} fontSize="12px" color={color} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
          {mark} {it}
        </Text>
      ))}
    </Stack>
  );
}

function PlanDoc({ data }: { data: any }) {
  const files: any[] = data?.files ?? [];
  return (
    <>
      <DocSection title="summary">
        <Text fontSize="13px" color={INK} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
          {data?.task_summary}
        </Text>
      </DocSection>
      {data?.approach && (
        <DocSection title="approach">
          <Text fontSize="12px" color="#c9cdd8" fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
            {data.approach}
          </Text>
        </DocSection>
      )}
      {data?.divergence && (
        <DocSection title="divergence">
          <Box bg="rgba(240,180,41,0.10)" borderLeft="4px solid" borderColor={WARN} borderRadius="0 4px 4px 0" p={3}>
            <Text fontSize="12px" color={WARN} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
              {data.divergence}
            </Text>
          </Box>
        </DocSection>
      )}
      {files.length > 0 && (
        <DocSection title={`files (${files.length})`}>
          {files.map((f, i) => (
            <Box key={i} py={2} borderBottom="1px solid" borderColor={RULE}>
              <Text fontSize="12px" color={ACCENT} fontFamily="ui-monospace, monospace">
                {f.path}
              </Text>
              <Text fontSize="11.5px" color={MUTED} fontFamily="system-ui, sans-serif">
                {f.purpose}
                {f.task ? ` · task: ${f.task}` : ""}
              </Text>
            </Box>
          ))}
        </DocSection>
      )}
      {(data?.acceptance_criteria?.length ?? 0) > 0 && (
        <DocSection title={`acceptance criteria (${data.acceptance_criteria.length})`}>
          <List items={data.acceptance_criteria} />
        </DocSection>
      )}
    </>
  );
}

function TasksDoc({ data }: { data: any }) {
  const tasks: any[] = data?.tasks ?? [];
  return (
    <>
      {tasks.map((t) => (
        <Box key={t.id} mb={3} p={3} borderRadius="md" border="1px solid" borderColor={RULE}>
          <Flex alignItems="center" gap={2} flexWrap="wrap" mb={1}>
            <Text fontSize="13px" fontWeight={700} color={ACCENT} fontFamily="ui-monospace, monospace">
              {t.id}
            </Text>
            <Text fontSize="12.5px" fontWeight={600} color={INK} fontFamily="system-ui, sans-serif">
              {t.title}
            </Text>
            <Tag color={MUTED} bg="transparent">{t.size}</Tag>
          </Flex>
          <Text fontSize="12px" color="#c9cdd8" fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
            {t.description}
          </Text>
          {t.files?.length > 0 && (
            <Text fontSize="11px" color={MUTED} mt={1} fontFamily="ui-monospace, monospace">
              files: {t.files.join(", ")}
            </Text>
          )}
          {t.dependsOn?.length > 0 && (
            <Text fontSize="11px" color={MUTED} mt={0.5} fontFamily="ui-monospace, monospace">
              depends on: {t.dependsOn.join(", ")}
            </Text>
          )}
          {(t.acceptance_criteria?.length ?? 0) > 0 && (
            <Box mt={2}>
              <List items={t.acceptance_criteria} mark="□" />
            </Box>
          )}
        </Box>
      ))}
    </>
  );
}

const COMPLETION_COLOR: Record<string, string> = { done: GOOD, partial: WARN, skipped: BAD };

function ImplDeltaDoc({ data }: { data: any }) {
  return (
    <>
      <DocSection title="summary">
        <Text fontSize="13px" color={INK} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
          {data?.summary}
        </Text>
      </DocSection>
      {(data?.files_written?.length ?? 0) > 0 && (
        <DocSection title={`files written (${data.files_written.length})`}>
          <Flex gap={1.5} flexWrap="wrap">
            {data.files_written.map((f: string) => (
              <Box key={f} px={2} py={1} borderRadius="sm" border="1px solid" borderColor={RULE} bg="#1b2130">
                <Text fontSize="11px" color={INK} fontFamily="ui-monospace, monospace">
                  {f}
                </Text>
              </Box>
            ))}
          </Flex>
        </DocSection>
      )}
      {(data?.task_completion?.length ?? 0) > 0 && (
        <DocSection title="task completion">
          {data.task_completion.map((t: any) => (
            <Flex key={t.task} alignItems="center" gap={2} py={1.5} borderBottom="1px solid" borderColor={RULE}>
              <Tag color={COMPLETION_COLOR[t.status] ?? MUTED} bg="transparent">{t.status}</Tag>
              <Text fontSize="12px" color={INK} fontFamily="ui-monospace, monospace">
                {t.task}
              </Text>
              {t.note && (
                <Text fontSize="11px" color={MUTED} fontFamily="system-ui, sans-serif" flex="1" textAlign="right">
                  {t.note}
                </Text>
              )}
            </Flex>
          ))}
        </DocSection>
      )}
      {data?.notes && (
        <DocSection title="notes">
          <Text fontSize="12px" color="#c9cdd8" fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
            {data.notes}
          </Text>
        </DocSection>
      )}
    </>
  );
}

function SpecDoc({ data }: { data: any }) {
  return (
    <>
      <DocSection title="summary">
        <Text fontSize="13px" color={INK} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
          {data?.summary}
        </Text>
      </DocSection>
      {(data?.decisions?.length ?? 0) > 0 && (
        <DocSection title={`locked decisions (${data.decisions.length})`}>
          {data.decisions.map((d: any, i: number) => (
            <Box key={i} py={1.5} borderBottom="1px solid" borderColor={RULE}>
              <Text fontSize="12px" fontWeight={600} color={INK} fontFamily="system-ui, sans-serif">
                {d.topic}
              </Text>
              <Text fontSize="11.5px" color="#c9cdd8" fontFamily="system-ui, sans-serif">
                {d.decision}
              </Text>
            </Box>
          ))}
        </DocSection>
      )}
      {(data?.acceptance_criteria?.length ?? 0) > 0 && (
        <DocSection title={`acceptance criteria (${data.acceptance_criteria.length})`}>
          <List items={data.acceptance_criteria} mark="☐" />
        </DocSection>
      )}
      {(data?.out_of_scope?.length ?? 0) > 0 && (
        <DocSection title="out of scope">
          <List items={data.out_of_scope} color={MUTED} />
        </DocSection>
      )}
    </>
  );
}

// --- driver pseudo-artifacts (mechanical / remote CI / scanners / deferred) ---

const DRIVER_STATUS_COLOR: Record<string, string> = { pass: GOOD, fail: BAD, skip: MUTED };

function StatusRows({ rows }: { rows: { id: string; title?: string; status: string; evidence: string }[] }) {
  return (
    <>
      {rows.map((c, i) => (
        <Flex key={c.id ?? i} gap={3} alignItems="flex-start" py={2.5} borderBottom="1px solid" borderColor={RULE}>
          <Tag color={DRIVER_STATUS_COLOR[c.status] ?? MUTED} bg="transparent">{c.status}</Tag>
          <Box flex="1" minW={0}>
            <Text fontSize="12.5px" fontWeight={600} color={INK} fontFamily="ui-monospace, monospace">
              {c.id}
              {c.title ? <Text as="span" color={MUTED} fontWeight={400} fontFamily="system-ui, sans-serif"> — {c.title}</Text> : null}
            </Text>
            <Text fontSize="11.5px" color="#c9cdd8" mt={0.5} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap" wordBreak="break-word">
              {c.evidence}
            </Text>
          </Box>
        </Flex>
      ))}
    </>
  );
}

function MechanicalDoc({ data }: { data: any }) {
  const checks: any[] = data?.checks ?? [];
  const failed = checks.filter((c) => c.status === "fail").length;
  return (
    <>
      <Box mb={6} pb={4} borderBottom="1px solid" borderColor={RULE}>
        <Text fontSize="12px" fontStyle="italic" color={MUTED} mb={2} fontFamily="system-ui, sans-serif">
          driver ground truth — round {data?.round ?? "?"}
        </Text>
        <Stamp verdict={failed > 0 ? "gaps-found" : "pass"} />
        <Text fontSize="11px" color={MUTED} mt={2} fontFamily="system-ui, sans-serif">
          {failed} failure(s) · deterministic — these gate regardless of any model verdict
        </Text>
      </Box>
      <DocSection title={`checks (${checks.length})`}>
        <StatusRows rows={checks} />
      </DocSection>
    </>
  );
}

function RemoteCiDoc({ data }: { data: any }) {
  const runs: any[] = data?.runs ?? [];
  const ok = data?.status === "pass";
  return (
    <>
      <Box mb={6} pb={4} borderBottom="1px solid" borderColor={RULE}>
        <Text fontSize="12px" fontStyle="italic" color={MUTED} mb={2} fontFamily="system-ui, sans-serif">
          driver-observed hosted CI — round {data?.round ?? "?"}
        </Text>
        <Stamp verdict={ok ? "pass" : data?.status === "fail" ? "gaps-found" : "skipped"} />
        <Text fontSize="11.5px" color="#c9cdd8" mt={2} fontFamily="system-ui, sans-serif" whiteSpace="pre-wrap">
          {data?.evidence}
        </Text>
      </Box>
      {runs.length > 0 && (
        <DocSection title={`runs (${runs.length})`}>
          {runs.map((r, i) => (
            <Box key={i} py={2.5} borderBottom="1px solid" borderColor={RULE}>
              <Flex alignItems="center" gap={2} flexWrap="wrap">
                <Tag color={r.conclusion === "success" ? GOOD : BAD} bg="transparent">
                  {r.conclusion ?? r.status}
                </Tag>
                <Text fontSize="12px" color={INK} fontFamily="system-ui, sans-serif">
                  {r.name}
                </Text>
                {r.url && (
                  <Link href={r.url} target="_blank" rel="noreferrer" fontSize="11px" color={ACCENT} fontFamily="ui-monospace, monospace">
                    ↗
                  </Link>
                )}
              </Flex>
              {r.log && (
                <Text fontSize="11.5px" color="#c9cdd8" mt={1} pl={3} borderLeft="2px solid" borderLeftColor={BAD} whiteSpace="pre-wrap" fontFamily="system-ui, sans-serif">
                  {String(r.log).slice(0, 1200)}
                </Text>
              )}
            </Box>
          ))}
        </DocSection>
      )}
    </>
  );
}

function ScannersDoc({ data }: { data: any }) {
  const scanners: any[] = data?.scanners ?? [];
  const failed = scanners.filter((x) => x.status === "fail").length;
  return (
    <>
      <Box mb={6} pb={4} borderBottom="1px solid" borderColor={RULE}>
        <Text fontSize="12px" fontStyle="italic" color={MUTED} mb={2} fontFamily="system-ui, sans-serif">
          deterministic scanner suite — round {data?.round ?? "?"}
        </Text>
        <Stamp verdict={failed > 0 ? "gaps-found" : "pass"} />
      </Box>
      <DocSection title={`scanners (${scanners.length})`}>
        <StatusRows rows={scanners} />
      </DocSection>
      {scanners.some((x: any) => ((x.findings ?? []) as any[]).length > 0) && (
        <DocSection title="scanner findings">
          {scanners.flatMap((x) => x.findings ?? []).map((f: any, i: number) => (
            <Box key={f.id ?? i} mb={2} p={3} borderRadius="md" bg={FAIL_BG} borderLeft="4px solid" borderLeftColor={BAD}>
              <Flex alignItems="center" gap={2} flexWrap="wrap">
                <Tag color={BAD} bg="transparent">{f.severity ?? "high"}</Tag>
                <Text fontSize="12.5px" fontWeight={600} color={INK} fontFamily="system-ui, sans-serif">
                  {f.title}
                </Text>
              </Flex>
              <Text fontSize="11.5px" color="#c9cdd8" mt={1} fontFamily="system-ui, sans-serif">
                {f.evidence}
              </Text>
            </Box>
          ))}
        </DocSection>
      )}
    </>
  );
}

function DeferredDoc({ data }: { data: any }) {
  const list: any[] = Array.isArray(data) ? data : [];
  return (
    <DocSection title={`deferred to owner (${list.length})`}>
      {list.length === 0 ? (
        <Text fontSize="12px" color={GOOD} fontStyle="italic" fontFamily="system-ui, sans-serif">
          Nothing deferred — every criterion was verifiable in this environment.
        </Text>
      ) : (
        list.map((d, i) => (
          <Box key={i} py={2.5} borderBottom="1px solid" borderColor={RULE}>
            <Flex alignItems="center" gap={2} flexWrap="wrap">
              <Tag color={WARN} bg="transparent">[{d.env}]</Tag>
              <Text fontSize="12px" color={INK} fontFamily="system-ui, sans-serif">
                {d.criterion}
              </Text>
            </Flex>
            {d.evidence && (
              <Text fontSize="11.5px" color={MUTED} mt={1} fontFamily="system-ui, sans-serif">
                {d.evidence}
              </Text>
            )}
          </Box>
        ))
      )}
    </DocSection>
  );
}

const RENDERERS: Record<string, (p: { data: any }) => React.ReactElement> = {
  verify: VerifyDoc,
  audit: AuditDoc,
  security: SecurityDoc,
  plan: PlanDoc,
  tasks: TasksDoc,
  implDelta: ImplDeltaDoc,
  spec: SpecDoc,
  "checks:mechanical": MechanicalDoc,
  "checks:remote-ci": RemoteCiDoc,
  "checks:scanners": ScannersDoc,
  "checks:deferred": DeferredDoc,
};

/** Document view with a floating raw-JSON toggle (top right). */
export default function ArtifactDocument({ name, data, raw }: { name: string; data: unknown; raw: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const Renderer = RENDERERS[name];
  return (
    <Box position="relative">
      <Box position="sticky" top={0} zIndex={4} display="flex" justifyContent="flex-end" pointerEvents="none" mb={-7}>
        <Box
          pointerEvents="auto"
          px={3}
          py={1.5}
          borderRadius="full"
          border="1px solid"
          borderColor={showRaw ? ACCENT : RULE}
          bg="#1b2130"
          color={showRaw ? ACCENT : MUTED}
          fontSize="11px"
          cursor="pointer"
          boxShadow="0 2px 12px rgba(0,0,0,0.45)"
          fontFamily="system-ui, sans-serif"
          _hover={{ color: INK }}
          onClick={() => setShowRaw(!showRaw)}
          title="Toggle between the document view and the raw JSON"
        >
          {showRaw ? "📄 Document" : "{ } Raw JSON"}
        </Box>
      </Box>
      {showRaw || !Renderer ? (
        <Box as="pre" fontSize="12px" whiteSpace="pre-wrap" m={0} mt={2} fontFamily="ui-monospace, monospace" color={INK}>
          {raw}
        </Box>
      ) : (
        <Box pt={2}>
          <Renderer data={data} />
        </Box>
      )}
    </Box>
  );
}
