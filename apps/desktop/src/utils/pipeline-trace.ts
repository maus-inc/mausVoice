export type PipelineStage =
  | "stopped"
  | "audioFinalized"
  | "transcribed"
  | "polished"
  | "reviewing"
  | "inserted"
  | "persisted";

export type PipelineTrace = {
  startedAt: number;
  marks: Partial<Record<PipelineStage, number>>;
};

const STAGE_ORDER: PipelineStage[] = [
  "stopped",
  "audioFinalized",
  "transcribed",
  "polished",
  "reviewing",
  "inserted",
  "persisted",
];

export const startPipelineTrace = (
  now: number = performance.now(),
): PipelineTrace => ({ startedAt: now, marks: {} });

export const markPipeline = (
  trace: PipelineTrace | null | undefined,
  stage: PipelineStage,
  now: number = performance.now(),
): void => {
  if (!trace) return;
  trace.marks[stage] = now;
};

export type PipelineSummary = {
  totalMs: number;
  stages: Record<string, number>;
};

export const summarizePipeline = (
  trace: PipelineTrace | null | undefined,
  now: number = performance.now(),
): PipelineSummary | null => {
  if (!trace) return null;
  const start = trace.marks.stopped ?? trace.startedAt;
  const stages: Record<string, number> = {};
  let previous = start;
  for (const stage of STAGE_ORDER) {
    const at = trace.marks[stage];
    if (at == null) continue;
    stages[stage] = Math.max(0, at - previous);
    previous = at;
  }
  return { totalMs: Math.max(0, now - start), stages };
};

export type TimingAggregate = {
  samples: number;
  stages: Record<string, number[]>;
};

export const appendTimingSample = (
  previous: TimingAggregate | undefined,
  summary: PipelineSummary,
  maxSamples = 20,
): TimingAggregate => {
  const stages: Record<string, number[]> = {
    ...previous?.stages,
  };
  for (const [stage, ms] of Object.entries(summary.stages)) {
    stages[stage] = [...(stages[stage] ?? []), ms].slice(-maxSamples);
  }
  return { samples: (previous?.samples ?? 0) + 1, stages };
};

export const medianTiming = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};
