import {
  type Chunk,
  isAIChunk,
  isParsedRealUserMessage,
  type ParsedMessage,
  type Process,
  type SessionMetrics,
  type SwimlaneChildRow,
  type SwimlaneHitlMark,
  type SwimlaneModel,
  type SwimlaneNavigationTarget,
  type SwimlaneParentSegment,
  type SwimlaneSegmentType,
} from '@main/types';
import { calculateMetrics, getTaskCalls } from '@main/utils/jsonl';

interface TimedRange {
  start: number;
  end: number;
}

interface WorkRange extends TimedRange {
  id: string;
  requestId?: string;
  chunkId?: string;
  metrics: SessionMetrics;
}

interface HitlRange extends TimedRange {
  id: string;
  source: 'explicit-ask' | 'inferred-resume';
  toolUseId?: string;
}

interface ParentSegmentDraft extends TimedRange {
  type: SwimlaneSegmentType;
  work?: WorkRange;
}

interface LogicalChild {
  id: string;
  primaryProcess: Process;
  processes: Process[];
  messages: ParsedMessage[];
  start: number;
  end: number;
  parentId: string | null;
  hasIdentityOwner: boolean;
}

const EPOCH = 0;

function numericRange(values: Iterable<number>): TimedRange | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    start = start === undefined || value < start ? value : start;
    end = end === undefined || value > end ? value : end;
  }
  return start === undefined || end === undefined ? undefined : { start, end };
}

function validTime(date: Date | undefined): number | undefined {
  if (!date) return undefined;
  const value = date.getTime();
  return Number.isFinite(value) ? value : undefined;
}

function sortedMessages(messages: ParsedMessage[]): ParsedMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort(
      (left, right) =>
        (validTime(left.message.timestamp) ?? EPOCH) -
          (validTime(right.message.timestamp) ?? EPOCH) || left.index - right.index
    )
    .map(({ message }) => message);
}

function validProcessRange(process: Process): TimedRange | undefined {
  const times: number[] = [];
  const declaredStart = validTime(process.startTime);
  const declaredEnd = validTime(process.endTime);
  if (declaredStart !== undefined) times.push(declaredStart);
  if (declaredEnd !== undefined) times.push(declaredEnd);
  for (const message of process.messages) {
    const time = validTime(message.timestamp);
    if (time !== undefined) times.push(time);
  }
  return numericRange(times);
}

function processRange(process: Process, fallbackTime = EPOCH): TimedRange {
  return validProcessRange(process) ?? { start: fallbackTime, end: fallbackTime };
}

function buildWorkRanges(chunks: Chunk[], messages: ParsedMessage[]): WorkRange[] {
  const chunkByMessageId = new Map<string, string>();
  for (const chunk of chunks) {
    if (!isAIChunk(chunk)) continue;
    for (const response of chunk.responses) {
      chunkByMessageId.set(response.uuid, chunk.id);
    }
  }

  const groups = new Map<string, ParsedMessage[]>();
  messages.forEach((message, index) => {
    if (
      message.type !== 'assistant' ||
      message.isSidechain ||
      validTime(message.timestamp) === undefined
    ) {
      return;
    }
    const key = message.requestId ? `request:${message.requestId}` : `message:${index}`;
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  });

  return [...groups.entries()]
    .map(([key, group]): WorkRange => {
      const range = numericRange(group.map((message) => validTime(message.timestamp)!))!;
      const requestId = group[0].requestId;
      return {
        id: requestId ? `work-${requestId}` : `work-${group[0].uuid || 'message'}-${key}`,
        start: range.start,
        end: range.end,
        metrics: { ...calculateMetrics(group) },
        requestId,
        chunkId: group.map((message) => chunkByMessageId.get(message.uuid)).find(Boolean),
      };
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function buildChildTargets(chunks: Chunk[]): Map<string, SwimlaneNavigationTarget> {
  const candidatesByProcess = new Map<string, Map<string, SwimlaneNavigationTarget>>();

  for (const chunk of chunks) {
    if (!isAIChunk(chunk)) continue;
    for (const process of chunk.processes) {
      const spawnId = process.parentTaskId ?? '';
      const target: SwimlaneNavigationTarget = {
        kind: 'subagent',
        groupId: chunk.id,
        processId: process.id,
        spawnId,
      };
      const candidates =
        candidatesByProcess.get(process.id) ?? new Map<string, SwimlaneNavigationTarget>();
      candidates.set(`${target.groupId}\0${target.processId}\0${spawnId}`, target);
      candidatesByProcess.set(process.id, candidates);
    }
  }

  const targets = new Map<string, SwimlaneNavigationTarget>();
  for (const [processId, candidates] of candidatesByProcess) {
    if (candidates.size === 1) targets.set(processId, [...candidates.values()][0]);
  }
  return targets;
}

function toolUseIds(message: ParsedMessage): string[] {
  const ids = new Set<string>();
  if (message.sourceToolUseID) ids.add(message.sourceToolUseID);
  for (const result of message.toolResults) ids.add(result.toolUseId);
  const resultId = message.toolUseResult?.toolUseId;
  if (typeof resultId === 'string') ids.add(resultId);
  return [...ids];
}

function uncoveredRanges(start: number, end: number, explicitRanges: HitlRange[]): TimedRange[] {
  const covering = explicitRanges
    .filter((range) => range.end > start && range.start < end)
    .map((range) => ({ start: Math.max(start, range.start), end: Math.min(end, range.end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const uncovered: TimedRange[] = [];
  let cursor = start;
  for (const range of covering) {
    if (range.start > cursor) uncovered.push({ start: cursor, end: range.start });
    if (range.end > cursor) cursor = range.end;
  }
  if (cursor < end) uncovered.push({ start: cursor, end });
  return uncovered;
}

function buildHitlRanges(
  messages: ParsedMessage[],
  workRanges: WorkRange[],
  axisEnd: number
): { ranges: HitlRange[]; marks: SwimlaneHitlMark[] } {
  const parentMessages = sortedMessages(messages.filter((message) => !message.isSidechain));
  const ranges: HitlRange[] = [];
  const marks: SwimlaneHitlMark[] = [];
  const seenAskIds = new Set<string>();

  for (let messageIndex = 0; messageIndex < parentMessages.length; messageIndex++) {
    const message = parentMessages[messageIndex];
    const start = validTime(message.timestamp);
    if (start === undefined) continue;
    for (const call of message.toolCalls.filter(
      (toolCall) => toolCall.name === 'AskUserQuestion'
    )) {
      if (seenAskIds.has(call.id)) continue;
      seenAskIds.add(call.id);
      let answer: ParsedMessage | undefined;
      for (
        let candidateIndex = messageIndex;
        candidateIndex < parentMessages.length;
        candidateIndex++
      ) {
        const candidate = parentMessages[candidateIndex];
        if (toolUseIds(candidate).includes(call.id)) {
          answer = candidate;
          break;
        }
      }
      const answerTime = answer ? validTime(answer.timestamp) : undefined;
      const end = answerTime ?? axisEnd;
      const id = `ask-${call.id}`;
      ranges.push({
        id,
        start,
        end: Math.max(start, end),
        source: 'explicit-ask',
        toolUseId: call.id,
      });
      marks.push({
        id: `${id}-start`,
        type: 'ask',
        timestamp: new Date(start),
        source: 'explicit-ask',
        toolUseId: call.id,
      });
      if (answerTime !== undefined) {
        marks.push({
          id: `${id}-answer`,
          type: 'answer',
          timestamp: new Date(answerTime),
          source: 'explicit-ask',
          toolUseId: call.id,
        });
      }
    }
  }

  const inferredByWorkEnd = new Map<number, number>();
  for (const message of parentMessages.filter(isParsedRealUserMessage)) {
    const resumeTime = validTime(message.timestamp);
    if (resumeTime === undefined) continue;
    let precedingWork: WorkRange | undefined;
    for (const work of workRanges) {
      if (work.end < resumeTime && (precedingWork === undefined || work.end > precedingWork.end)) {
        precedingWork = work;
      }
    }
    if (!precedingWork) continue;
    const existingResume = inferredByWorkEnd.get(precedingWork.end);
    if (existingResume === undefined || resumeTime < existingResume) {
      inferredByWorkEnd.set(precedingWork.end, resumeTime);
    }
  }

  const explicitRanges = ranges.filter((range) => range.source === 'explicit-ask');
  for (const [resumeStart, resumeEnd] of inferredByWorkEnd) {
    if (resumeEnd <= resumeStart) continue;
    for (const { start, end } of uncoveredRanges(resumeStart, resumeEnd, explicitRanges)) {
      const id = `resume-${start}-${end}`;
      ranges.push({ id, start, end, source: 'inferred-resume' });
      marks.push(
        {
          id: `${id}-start`,
          type: 'resume-start',
          timestamp: new Date(start),
          source: 'inferred-resume',
        },
        {
          id: `${id}-end`,
          type: 'resume',
          timestamp: new Date(end),
          source: 'inferred-resume',
        }
      );
    }
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  marks.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  return { ranges, marks };
}

function unionContinuations(processes: Process[], fallbackTime: number): LogicalChild[] {
  const parents = processes.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    let cursor = index;
    while (parents[cursor] !== cursor) {
      const next = parents[cursor];
      parents[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  const processByLastUuid = new Map<string, number>();
  processes.forEach((process, index) => {
    const lastMessage = sortedMessages(process.messages).at(-1);
    if (lastMessage?.uuid) processByLastUuid.set(lastMessage.uuid, index);
  });
  processes.forEach((process, index) => {
    const parentUuid = sortedMessages(process.messages)[0]?.parentUuid;
    const previous = parentUuid ? processByLastUuid.get(parentUuid) : undefined;
    if (previous !== undefined) union(previous, index);
  });

  const grouped = new Map<number, Process[]>();
  processes.forEach((process, index) => {
    const root = find(index);
    grouped.set(root, [...(grouped.get(root) ?? []), process]);
  });

  return [...grouped.entries()].map(([rootIndex, group]) => {
    const primaryProcess = processes[rootIndex];
    const ordered = [...group].sort(
      (left, right) =>
        processRange(left, fallbackTime).start - processRange(right, fallbackTime).start
    );
    const ranges = ordered.map((process) => processRange(process, fallbackTime));
    const logicalRange = numericRange(ranges.flatMap((range) => [range.start, range.end]))!;
    return {
      id: primaryProcess.id,
      primaryProcess,
      processes: ordered,
      messages: sortedMessages(ordered.flatMap((process) => process.messages)),
      start: logicalRange.start,
      end: logicalRange.end,
      parentId: null,
      hasIdentityOwner: false,
    };
  });
}

function resultAgentIdentity(message: ParsedMessage): string | undefined {
  const result = message.toolUseResult;
  const identity = result?.agentId ?? result?.agent_id;
  return typeof identity === 'string' ? identity : undefined;
}

function childMatchesIdentity(child: LogicalChild, identity: string): boolean {
  return child.processes.some(
    (process) =>
      process.id === identity ||
      (process.team !== undefined &&
        `${process.team.memberName}@${process.team.teamName}` === identity)
  );
}

function assignChildParents(children: LogicalChild[], rootMessages: ParsedMessage[]): void {
  const owners = [
    {
      id: null as string | null,
      messages: sortedMessages(rootMessages),
      ranges: [] as TimedRange[],
    },
    ...children.map((child) => ({
      id: child.id,
      messages: sortedMessages(child.messages),
      ranges: child.processes
        .map(validProcessRange)
        .filter((range): range is TimedRange => range !== undefined),
    })),
  ];
  const spawnEvents = new Map<
    string,
    { id: string; ownerId: string | null; time: number; messageIndex: number }
  >();

  for (const owner of owners) {
    const spawnIds = new Set(getTaskCalls(owner.messages).map((call) => call.id));
    for (let messageIndex = 0; messageIndex < owner.messages.length; messageIndex++) {
      const message = owner.messages[messageIndex];
      const time = validTime(message.timestamp);
      if (time === undefined) continue;
      const ownerCanSpawn =
        owner.id === null || owner.ranges.some((range) => range.start <= time && time <= range.end);
      if (!ownerCanSpawn) continue;
      for (const call of message.toolCalls) {
        if (spawnIds.has(call.id) && !spawnEvents.has(call.id)) {
          spawnEvents.set(call.id, { id: call.id, ownerId: owner.id, time, messageIndex });
        }
      }
    }
  }

  const usedSpawnIds = new Set<string>();
  for (const owner of owners) {
    for (let messageIndex = 0; messageIndex < owner.messages.length; messageIndex++) {
      const message = owner.messages[messageIndex];
      const identity = resultAgentIdentity(message);
      if (!identity) continue;
      for (const sourceId of toolUseIds(message)) {
        const event = spawnEvents.get(sourceId);
        if (
          event?.ownerId !== owner.id ||
          event.messageIndex > messageIndex ||
          usedSpawnIds.has(sourceId)
        ) {
          continue;
        }
        const child = children.find(
          (candidate) => candidate.id !== owner.id && childMatchesIdentity(candidate, identity)
        );
        if (!child) continue;
        usedSpawnIds.add(sourceId);
        if (!child.hasIdentityOwner) {
          child.parentId = owner.id;
          child.hasIdentityOwner = true;
        }
        break;
      }
    }
  }

  const unmatchedChildren = children
    .filter((child) => !child.hasIdentityOwner)
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
  for (const child of unmatchedChildren) {
    const fallback = [...spawnEvents.values()]
      .filter(
        (event) =>
          !usedSpawnIds.has(event.id) && event.ownerId !== child.id && event.time <= child.start
      )
      .sort(
        (left, right) =>
          right.time - left.time ||
          String(left.ownerId).localeCompare(String(right.ownerId)) ||
          left.id.localeCompare(right.id)
      )[0];
    child.parentId = fallback?.ownerId ?? null;
    if (fallback) usedSpawnIds.add(fallback.id);
  }
}

function childLabel(child: LogicalChild): string {
  const candidates = [
    child.primaryProcess,
    ...child.processes.filter((process) => process !== child.primaryProcess),
  ];
  const withMetadata = candidates.find(
    (process) => process.team || process.description || process.subagentType
  );
  return (
    withMetadata?.team?.memberName ??
    withMetadata?.description ??
    withMetadata?.subagentType ??
    child.primaryProcess.id
  );
}

function buildChildRows(
  processes: Process[],
  rootMessages: ParsedMessage[],
  fallbackTime: number,
  childTargets: Map<string, SwimlaneNavigationTarget>
): SwimlaneChildRow[] {
  const children = unionContinuations(processes, fallbackTime);
  assignChildParents(children, rootMessages);
  const childById = new Map(children.map((child) => [child.id, child]));
  for (const child of children) {
    const ancestors = new Set<string>([child.id]);
    let parentId = child.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) {
        child.parentId = null;
        break;
      }
      ancestors.add(parentId);
      parentId = childById.get(parentId)?.parentId ?? null;
    }
  }
  const byParent = new Map<string | null, LogicalChild[]>();
  for (const child of children) {
    const siblings = byParent.get(child.parentId) ?? [];
    siblings.push(child);
    siblings.sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
    byParent.set(child.parentId, siblings);
  }

  const rows: SwimlaneChildRow[] = [];
  const visited = new Set<string>();
  const append = (child: LogicalChild, depth: number): void => {
    if (visited.has(child.id)) return;
    visited.add(child.id);
    rows.push({
      id: child.id,
      label: childLabel(child),
      parentRowId: child.parentId,
      depth,
      activations: child.processes.map((process) => {
        const range = processRange(process, fallbackTime);
        return {
          id: process.id,
          processId: process.id,
          startTime: new Date(range.start),
          endTime: new Date(range.end),
          durationMs: range.end - range.start,
          metrics: { ...process.metrics },
          target: childTargets.get(process.id),
        };
      }),
    });
    for (const nested of byParent.get(child.id) ?? []) append(nested, depth + 1);
  };

  for (const child of byParent.get(null) ?? []) append(child, 0);
  for (const child of children) append(child, 0);
  return rows;
}

function activeRange<T extends TimedRange>(ranges: T[], start: number, end: number): T | undefined {
  return ranges.find(
    (range) => range.start <= start && range.end >= end && range.end > range.start
  );
}

function activeWorkRange(
  workRanges: WorkRange[],
  start: number,
  end: number
): WorkRange | undefined {
  let selected: WorkRange | undefined;
  for (const range of workRanges) {
    if (range.start > start || range.end < end || range.end <= range.start) continue;
    if (
      selected === undefined ||
      range.start > selected.start ||
      (range.start === selected.start && range.end < selected.end) ||
      (range.start === selected.start &&
        range.end === selected.end &&
        range.id.localeCompare(selected.id) < 0)
    ) {
      selected = range;
    }
  }
  return selected;
}

function buildParentSegments(
  axisStart: number,
  axisEnd: number,
  workRanges: WorkRange[],
  hitlRanges: HitlRange[],
  childRanges: TimedRange[]
): SwimlaneParentSegment[] {
  const boundaries = new Set<number>([axisStart, axisEnd]);
  for (const ranges of [workRanges, hitlRanges, childRanges]) {
    for (const range of ranges) {
      boundaries.add(Math.max(axisStart, Math.min(axisEnd, range.start)));
      boundaries.add(Math.max(axisStart, Math.min(axisEnd, range.end)));
    }
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const drafts: ParentSegmentDraft[] = [];
  const workPoints = new Set(
    workRanges.filter((range) => range.start === range.end).map((range) => range.start)
  );

  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const work = activeWorkRange(workRanges, start, end);
    const hitl = activeRange(hitlRanges, start, end);
    const child = activeRange(childRanges, start, end);
    const type: SwimlaneSegmentType = work
      ? 'work'
      : hitl
        ? 'HITL-wait'
        : child
          ? 'child-wait'
          : 'idle';
    const previous = drafts.at(-1);
    if (
      previous?.type === type &&
      previous.end === start &&
      !workPoints.has(start) &&
      (type !== 'work' || work?.id === previous.work?.id)
    ) {
      previous.end = end;
      continue;
    }
    drafts.push({ type, start, end, work });
  }

  const representedWork = new Set(
    drafts.map((draft) => draft.work?.id).filter((id): id is string => id !== undefined)
  );
  const metricOwners = new Set<string>();
  const sliceCounts = new Map<string, number>();
  const segments: SwimlaneParentSegment[] = drafts.map((draft) => {
    const work = draft.work;
    if (!work) {
      return {
        id: `${draft.type}-${draft.start}`,
        type: draft.type,
        startTime: new Date(draft.start),
        endTime: new Date(draft.end),
        durationMs: draft.end - draft.start,
      };
    }
    const sliceCount = sliceCounts.get(work.id) ?? 0;
    sliceCounts.set(work.id, sliceCount + 1);
    const ownsMetrics = !metricOwners.has(work.id);
    metricOwners.add(work.id);
    return {
      id: sliceCount === 0 ? work.id : `${work.id}-part-${sliceCount + 1}`,
      type: 'work',
      startTime: new Date(draft.start),
      endTime: new Date(draft.end),
      durationMs: draft.end - draft.start,
      metrics: ownsMetrics ? { ...work.metrics } : undefined,
      requestId: work.requestId,
      chunkId: work.chunkId,
      target: work.chunkId ? { kind: 'turn', groupId: work.chunkId } : undefined,
    };
  });

  for (const work of workRanges) {
    if (representedWork.has(work.id)) continue;
    metricOwners.add(work.id);
    segments.push({
      id: work.id,
      type: 'work',
      startTime: new Date(work.start),
      endTime: new Date(work.start),
      durationMs: 0,
      metrics: { ...work.metrics },
      requestId: work.requestId,
      chunkId: work.chunkId,
      target: work.chunkId ? { kind: 'turn', groupId: work.chunkId } : undefined,
    });
  }

  return segments.sort(
    (left, right) =>
      left.startTime.getTime() - right.startTime.getTime() ||
      (left.type === 'work' ? -1 : right.type === 'work' ? 1 : 0)
  );
}

/** Build the pure, message-free wall-clock projection used by SessionDetail. */
export function buildSwimlane(
  chunks: Chunk[],
  processes: Process[],
  messages: ParsedMessage[]
): SwimlaneModel {
  const mainMessages = messages.filter((message) => !message.isSidechain);
  const processRanges = processes
    .map(validProcessRange)
    .filter((range): range is TimedRange => range !== undefined);
  const timestampCandidates: number[] = [];
  for (const message of mainMessages) {
    const time = validTime(message.timestamp);
    if (time !== undefined) timestampCandidates.push(time);
  }
  for (const range of processRanges) timestampCandidates.push(range.start, range.end);
  const axisRange = numericRange(timestampCandidates);
  const axisStart = axisRange?.start ?? EPOCH;
  const axisEnd = axisRange?.end ?? EPOCH;
  const childRows = buildChildRows(processes, mainMessages, axisStart, buildChildTargets(chunks));
  const workRanges = buildWorkRanges(chunks, mainMessages);
  const hitl = buildHitlRanges(mainMessages, workRanges, axisEnd);

  return {
    startTime: new Date(axisStart),
    endTime: new Date(axisEnd),
    durationMs: axisEnd - axisStart,
    parentSegments: buildParentSegments(axisStart, axisEnd, workRanges, hitl.ranges, processRanges),
    hitlMarks: hitl.marks,
    childRows,
  };
}
