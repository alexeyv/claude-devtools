import {
  type Chunk,
  isAIChunk,
  isParsedUserChunkMessage,
  type ParsedMessage,
  type Process,
  type SessionMetrics,
  type SwimlaneChildRow,
  type SwimlaneEvidenceInterval,
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

type AttributedSegmentType = Exclude<SwimlaneSegmentType, 'unattributed'>;

interface EvidenceRange extends TimedRange {
  id: string;
  type: AttributedSegmentType;
  requestId?: string;
  toolUseId?: string;
  processId?: string;
  startMessageId?: string;
  endMessageId?: string;
  label?: string;
  chunkId?: string;
  metrics?: SessionMetrics;
  target?: SwimlaneNavigationTarget;
}

interface RequestRange extends EvidenceRange {
  type: 'assistant-output';
  requestId: string;
  metrics: SessionMetrics;
}

interface ParentSegmentDraft extends TimedRange {
  type: SwimlaneSegmentType;
  evidence?: EvidenceRange;
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

function buildRequestRanges(chunks: Chunk[], messages: ParsedMessage[]): RequestRange[] {
  const chunkByMessageId = new Map<string, string>();
  for (const chunk of chunks) {
    if (!isAIChunk(chunk)) continue;
    for (const response of chunk.responses) {
      chunkByMessageId.set(response.uuid, chunk.id);
    }
  }

  const groups = new Map<string, ParsedMessage[]>();
  messages.forEach((message) => {
    if (
      message.type !== 'assistant' ||
      message.isSidechain ||
      !message.requestId ||
      validTime(message.timestamp) === undefined
    ) {
      return;
    }
    const key = `request:${message.requestId}`;
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  });

  return [...groups.entries()]
    .map(([, group]): RequestRange => {
      const range = numericRange(group.map((message) => validTime(message.timestamp)!))!;
      const requestId = group[0].requestId!;
      const ordered = sortedMessages(group);
      const chunkId = group.map((message) => chunkByMessageId.get(message.uuid)).find(Boolean);
      return {
        id: `assistant-output-${requestId}`,
        type: 'assistant-output',
        start: range.start,
        end: range.end,
        metrics: { ...calculateMetrics(group) },
        requestId,
        startMessageId: ordered[0].uuid,
        endMessageId: ordered.at(-1)!.uuid,
        chunkId,
        target: chunkId ? { kind: 'turn', groupId: chunkId } : undefined,
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

function isSubmission(message: ParsedMessage): boolean {
  return (
    message.type === 'user' && (isParsedUserChunkMessage(message) || toolUseIds(message).length > 0)
  );
}

function buildModelResponseRanges(
  messages: ParsedMessage[],
  requestRanges: RequestRange[]
): EvidenceRange[] {
  const messageById = new Map(messages.map((message) => [message.uuid, message]));
  const ranges: EvidenceRange[] = [];
  for (const request of requestRanges) {
    const firstAssistant = request.startMessageId
      ? messageById.get(request.startMessageId)
      : undefined;
    const submission = firstAssistant?.parentUuid
      ? messageById.get(firstAssistant.parentUuid)
      : undefined;
    const start = submission ? validTime(submission.timestamp) : undefined;
    if (
      !firstAssistant ||
      !submission ||
      !isSubmission(submission) ||
      start === undefined ||
      start > request.start
    ) {
      continue;
    }
    ranges.push({
      id: `model-response-${request.requestId}`,
      type: 'model-response',
      start,
      end: request.start,
      requestId: request.requestId,
      chunkId: request.chunkId,
      startMessageId: submission.uuid,
      endMessageId: firstAssistant.uuid,
      target: request.target,
    });
  }
  return ranges;
}

function buildToolAndHumanRanges(messages: ParsedMessage[]): {
  ranges: EvidenceRange[];
  marks: SwimlaneHitlMark[];
} {
  const parentMessages = sortedMessages(messages.filter((message) => !message.isSidechain));
  const messageById = new Map(parentMessages.map((message) => [message.uuid, message]));
  const resultsByToolId = new Map<string, { index: number; message: ParsedMessage }[]>();
  parentMessages.forEach((message, index) => {
    for (const id of toolUseIds(message)) {
      const results = resultsByToolId.get(id) ?? [];
      results.push({ index, message });
      resultsByToolId.set(id, results);
    }
  });
  const ranges: EvidenceRange[] = [];
  const marks: SwimlaneHitlMark[] = [];
  const seenToolIds = new Set<string>();

  for (let messageIndex = 0; messageIndex < parentMessages.length; messageIndex++) {
    const message = parentMessages[messageIndex];
    const start = validTime(message.timestamp);
    if (start === undefined) continue;
    for (const call of message.toolCalls) {
      if (seenToolIds.has(call.id)) continue;
      seenToolIds.add(call.id);
      const result = resultsByToolId
        .get(call.id)
        ?.find(({ index }) => index >= messageIndex)?.message;
      const resultTime = result ? validTime(result.timestamp) : undefined;
      const isAsk = call.name === 'AskUserQuestion';
      if (isAsk) {
        marks.push({
          id: `human-wait-${call.id}-start`,
          type: 'ask',
          timestamp: new Date(start),
          source: 'explicit-ask',
          toolUseId: call.id,
        });
      }
      if (resultTime === undefined) continue;
      const end = resultTime;
      const id = `${isAsk ? 'human-wait' : 'tool-execution'}-${call.id}`;
      ranges.push({
        id,
        type: isAsk ? 'human-wait' : 'tool-execution',
        start,
        end: Math.max(start, end),
        toolUseId: call.id,
        startMessageId: message.uuid,
        endMessageId: result?.uuid,
        label: call.name,
      });
      if (!isAsk) continue;
      marks.push({
        id: `${id}-answer`,
        type: 'answer',
        timestamp: new Date(resultTime),
        source: 'explicit-ask',
        toolUseId: call.id,
      });
    }
  }

  for (const message of parentMessages.filter(isParsedUserChunkMessage)) {
    const end = validTime(message.timestamp);
    const parent = message.parentUuid ? messageById.get(message.parentUuid) : undefined;
    const start = parent ? validTime(parent.timestamp) : undefined;
    if (parent?.type !== 'assistant' || start === undefined || end === undefined || end <= start) {
      continue;
    }
    const id = `human-resume-${parent.uuid}-${message.uuid}`;
    ranges.push({
      id,
      type: 'human-wait',
      start,
      end,
      requestId: parent.requestId,
      startMessageId: parent.uuid,
      endMessageId: message.uuid,
    });
    marks.push(
      {
        id: `${id}-start`,
        type: 'resume-start',
        timestamp: new Date(start),
        source: 'linked-resume',
      },
      {
        id: `${id}-end`,
        type: 'resume',
        timestamp: new Date(end),
        source: 'linked-resume',
      }
    );
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

function processMatchesIdentity(process: Process, identity: string): boolean {
  return (
    process.id === identity ||
    (process.team !== undefined &&
      `${process.team.memberName}@${process.team.teamName}` === identity)
  );
}

function childMatchesIdentity(child: LogicalChild, identity: string): boolean {
  return child.processes.some((process) => processMatchesIdentity(process, identity));
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

function linkedChildRanges(
  processes: Process[],
  messages: ParsedMessage[],
  childTargets: Map<string, SwimlaneNavigationTarget>
): EvidenceRange[] {
  const allMessagesById = new Map<string, ParsedMessage>();
  for (const message of [...messages, ...processes.flatMap((process) => process.messages)]) {
    allMessagesById.set(message.uuid, message);
  }
  const allMessages = sortedMessages([...allMessagesById.values()]);
  const messageIndexById = new Map(allMessages.map((message, index) => [message.uuid, index]));
  const processByMessageId = new Map<string, Process>();
  const processByLastMessage = new Map<string, Process>();
  for (const process of processes) {
    for (const message of process.messages) processByMessageId.set(message.uuid, process);
    const last = sortedMessages(process.messages).at(-1);
    if (last) processByLastMessage.set(last.uuid, process);
  }

  interface MatchedSpawn {
    end: number;
    id: string;
    identity?: string;
    ownerId: string | null;
    start: number;
  }

  const resultsByToolId = new Map<string, ParsedMessage[]>();
  for (const message of allMessages) {
    for (const id of toolUseIds(message)) {
      const results = resultsByToolId.get(id) ?? [];
      results.push(message);
      resultsByToolId.set(id, results);
    }
  }
  const matchedSpawns: MatchedSpawn[] = [];
  const seenSpawnIds = new Set<string>();
  for (const message of allMessages) {
    const start = validTime(message.timestamp);
    if (start === undefined) continue;
    const callIndex = messageIndexById.get(message.uuid) ?? -1;
    for (const call of message.toolCalls.filter((candidate) => candidate.isTask)) {
      if (seenSpawnIds.has(call.id)) continue;
      seenSpawnIds.add(call.id);
      const result = resultsByToolId.get(call.id)?.find((candidate) => {
        const resultIndex = messageIndexById.get(candidate.uuid) ?? -1;
        const resultTime = validTime(candidate.timestamp);
        return resultIndex >= callIndex && resultTime !== undefined && resultTime >= start;
      });
      const end = result ? validTime(result.timestamp) : undefined;
      if (!result || end === undefined) continue;
      const owner = processByMessageId.get(message.uuid);
      if (message.isSidechain && !owner) continue;
      matchedSpawns.push({
        id: call.id,
        start,
        end,
        ownerId: owner?.id ?? null,
        identity: resultAgentIdentity(result),
      });
    }
  }

  const spawnsByOwner = new Map<string | null, MatchedSpawn[]>();
  for (const spawn of matchedSpawns) {
    spawnsByOwner.set(spawn.ownerId, [...(spawnsByOwner.get(spawn.ownerId) ?? []), spawn]);
  }
  const processesByTaskId = new Map<string, Process[]>();
  const processesByIdentity = new Map<string, Process>();
  const continuationsByProcess = new Map<string, Process[]>();
  for (const process of processes) {
    if (process.parentTaskId) {
      processesByTaskId.set(process.parentTaskId, [
        ...(processesByTaskId.get(process.parentTaskId) ?? []),
        process,
      ]);
    }
    processesByIdentity.set(process.id, process);
    if (process.team) {
      processesByIdentity.set(`${process.team.memberName}@${process.team.teamName}`, process);
    }
    const first = sortedMessages(process.messages)[0];
    const prior = first?.parentUuid ? processByLastMessage.get(first.parentUuid) : undefined;
    if (prior) {
      continuationsByProcess.set(prior.id, [
        ...(continuationsByProcess.get(prior.id) ?? []),
        process,
      ]);
    }
  }

  const linkByProcess = new Map<string, MatchedSpawn>();
  const ownerQueue: (string | null)[] = [null];
  const processedOwners = new Set<string | null>();
  const linkProcess = (process: Process, spawn: MatchedSpawn): void => {
    if (linkByProcess.has(process.id)) return;
    linkByProcess.set(process.id, spawn);
    ownerQueue.push(process.id);
    for (const continuation of continuationsByProcess.get(process.id) ?? []) {
      linkProcess(continuation, spawn);
    }
  };

  while (ownerQueue.length > 0) {
    const ownerId = ownerQueue.shift();
    if (ownerId === undefined) break;
    if (processedOwners.has(ownerId)) continue;
    processedOwners.add(ownerId);
    for (const spawn of spawnsByOwner.get(ownerId) ?? []) {
      for (const process of processesByTaskId.get(spawn.id) ?? []) linkProcess(process, spawn);
      if (spawn.identity) {
        const identityProcess = processesByIdentity.get(spawn.identity);
        if (identityProcess) linkProcess(identityProcess, spawn);
      }
    }
  }

  return processes
    .map((process): EvidenceRange | undefined => {
      const spawn = linkByProcess.get(process.id);
      const processBounds = validProcessRange(process);
      if (!spawn || !processBounds) return undefined;
      const range = {
        start: Math.max(processBounds.start, spawn.start),
        end: Math.min(processBounds.end, spawn.end),
      };
      if (range.end < range.start) return undefined;
      return {
        id: `child-wait-${process.id}`,
        type: 'child-wait' as const,
        start: range.start,
        end: range.end,
        processId: process.id,
        toolUseId: spawn.id,
        target: childTargets.get(process.id),
        label: childLabel({
          id: process.id,
          primaryProcess: process,
          processes: [process],
          messages: process.messages,
          ...range,
          parentId: null,
          hasIdentityOwner: false,
        }),
      };
    })
    .filter((range): range is EvidenceRange => range !== undefined);
}

const evidencePriority: Record<AttributedSegmentType, number> = {
  'human-wait': 5,
  'child-wait': 4,
  'tool-execution': 3,
  'assistant-output': 2,
  'model-response': 1,
};

const segmentSortOrder: Record<SwimlaneSegmentType, number> = {
  'model-response': 0,
  'assistant-output': 1,
  'tool-execution': 2,
  'child-wait': 3,
  'human-wait': 4,
  unattributed: 5,
};

function activeEvidence(
  ranges: EvidenceRange[],
  start: number,
  end: number
): EvidenceRange | undefined {
  return ranges
    .filter((range) => range.start <= start && range.end >= end && range.end > range.start)
    .sort(
      (left, right) =>
        evidencePriority[right.type] - evidencePriority[left.type] ||
        left.end - left.start - (right.end - right.start) ||
        right.start - left.start ||
        left.id.localeCompare(right.id)
    )[0];
}

function buildParentSegments(
  axisStart: number,
  axisEnd: number,
  evidenceRanges: EvidenceRange[],
  requestRanges: RequestRange[]
): SwimlaneParentSegment[] {
  const boundaries = new Set<number>([axisStart, axisEnd]);
  for (const range of evidenceRanges) {
    boundaries.add(Math.max(axisStart, Math.min(axisEnd, range.start)));
    boundaries.add(Math.max(axisStart, Math.min(axisEnd, range.end)));
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const drafts: ParentSegmentDraft[] = [];

  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const evidence = activeEvidence(evidenceRanges, start, end);
    const type: SwimlaneSegmentType = evidence?.type ?? 'unattributed';
    const previous = drafts.at(-1);
    if (
      previous?.type === type &&
      previous.end === start &&
      previous.evidence?.id === evidence?.id
    ) {
      previous.end = end;
      continue;
    }
    drafts.push({ type, start, end, evidence });
  }

  const representedEvidence = new Set(
    drafts.map((draft) => draft.evidence?.id).filter((id): id is string => id !== undefined)
  );
  const metricOwners = new Set<string>();
  const sliceCounts = new Map<string, number>();
  const requestById = new Map(requestRanges.map((range) => [range.requestId, range]));
  const segments: SwimlaneParentSegment[] = drafts.map((draft) => {
    const evidence = draft.evidence;
    if (!evidence) {
      return {
        id: `unattributed-${draft.start}`,
        type: 'unattributed',
        startTime: new Date(draft.start),
        endTime: new Date(draft.end),
        durationMs: draft.end - draft.start,
      };
    }
    const sliceCount = sliceCounts.get(evidence.id) ?? 0;
    sliceCounts.set(evidence.id, sliceCount + 1);
    const request = evidence.requestId ? requestById.get(evidence.requestId) : undefined;
    const ownsMetrics = evidence.type === 'assistant-output' && !metricOwners.has(evidence.id);
    if (ownsMetrics) metricOwners.add(evidence.id);
    return {
      id: sliceCount === 0 ? evidence.id : `${evidence.id}-part-${sliceCount + 1}`,
      type: evidence.type,
      startTime: new Date(draft.start),
      endTime: new Date(draft.end),
      durationMs: draft.end - draft.start,
      evidenceId: evidence.id,
      metrics: ownsMetrics && request ? { ...request.metrics } : undefined,
      requestId: evidence.requestId,
      chunkId: request?.chunkId,
      target: request?.chunkId ? { kind: 'turn', groupId: request.chunkId } : undefined,
    };
  });

  for (const evidence of evidenceRanges.filter((range) => range.start === range.end)) {
    if (representedEvidence.has(evidence.id)) continue;
    const request = evidence.requestId ? requestById.get(evidence.requestId) : undefined;
    const ownsMetrics = evidence.type === 'assistant-output' && request !== undefined;
    segments.push({
      id: evidence.id,
      type: evidence.type,
      startTime: new Date(evidence.start),
      endTime: new Date(evidence.end),
      durationMs: 0,
      evidenceId: evidence.id,
      metrics: ownsMetrics ? { ...request.metrics } : undefined,
      requestId: evidence.requestId,
      chunkId: request?.chunkId,
      target: request?.chunkId ? { kind: 'turn', groupId: request.chunkId } : undefined,
    });
  }

  return segments.sort(
    (left, right) =>
      left.startTime.getTime() - right.startTime.getTime() ||
      segmentSortOrder[left.type] - segmentSortOrder[right.type] ||
      left.id.localeCompare(right.id)
  );
}

function serializeEvidence(range: EvidenceRange): SwimlaneEvidenceInterval {
  return {
    id: range.id,
    type: range.type,
    startTime: new Date(range.start),
    endTime: new Date(range.end),
    durationMs: range.end - range.start,
    requestId: range.requestId,
    toolUseId: range.toolUseId,
    processId: range.processId,
    startMessageId: range.startMessageId,
    endMessageId: range.endMessageId,
    label: range.label,
    metrics: range.metrics ? { ...range.metrics } : undefined,
    target: range.target,
  };
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
  const childTargets = buildChildTargets(chunks);
  const childRows = buildChildRows(processes, mainMessages, axisStart, childTargets);
  const requestRanges = buildRequestRanges(chunks, mainMessages);
  const modelResponseRanges = buildModelResponseRanges(mainMessages, requestRanges);
  const toolAndHuman = buildToolAndHumanRanges(mainMessages);
  const childRanges = linkedChildRanges(processes, messages, childTargets);
  const evidenceRanges: EvidenceRange[] = [
    ...requestRanges,
    ...modelResponseRanges,
    ...toolAndHuman.ranges,
    ...childRanges,
  ].sort(
    (left, right) =>
      left.start - right.start || left.end - right.end || left.id.localeCompare(right.id)
  );

  return {
    startTime: new Date(axisStart),
    endTime: new Date(axisEnd),
    durationMs: axisEnd - axisStart,
    evidence: evidenceRanges.map(serializeEvidence),
    parentSegments: buildParentSegments(axisStart, axisEnd, evidenceRanges, requestRanges),
    hitlMarks: toolAndHuman.marks,
    childRows,
  };
}
