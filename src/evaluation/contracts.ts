export interface EvaluationTask {
  id: string;
  category: "ts-only" | "python-only" | "mixed" | "memory-needed" | "memory-not-needed";
  query: string;
  goldFiles: string[];
  goldSymbols: string[];
  goldEdges?: string[];
  goldUnresolved?: string[];
  goldMemories?: string[];
  memoryExpected: boolean;
}

export interface EvaluationTrace {
  taskId: string;
  strategyId: "A" | "B" | "C" | "D";
  orderedFiles: string[];
  orderedSymbols: string[];
  orderedMemories: string[];
  searchStages: string[];
  toolCalls: number;
  fileReads: number;
  estimatedTokens: number;
  edges: { true: number; false: number; gold: number; unresolved: number };
  memoryLeak: number;
  staleEvidence: number;
}

export interface EvaluationStrategy {
  id: EvaluationTrace["strategyId"];
  run(task: EvaluationTask): Promise<EvaluationTrace>;
}

export interface EvaluationScore {
  fileRecallAtK: number;
  symbolRecallAtK: number;
  mrr: number;
  ndcg: number;
  edgePrecision: number;
  edgeRecall: number;
  falseEdges: number;
  unresolved: number;
  toolCalls: number;
  fileReads: number;
  estimatedTokens: number;
  staleEvidence: number;
  memoryRecall: number;
  memoryLeak: number;
}

export interface EvaluationScorer {
  score(tasks: EvaluationTask[], traces: EvaluationTrace[], k: number): EvaluationScore;
}
