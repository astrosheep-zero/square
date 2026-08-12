import {
  diagnoseSquare,
  type DiagnoseResult,
} from './artifact.js';
import {
  type StoredAct,
  type SquareDoc,
} from './model.js';

export interface RepairAction {
  message: string;
}

export interface RepairResult {
  doc: SquareDoc;
  actions: RepairAction[];
  quarantinedBlocks: string[];
}

export interface PlanRepairResult {
  diagnosis: DiagnoseResult;
  repaired?: RepairResult;
}

export function planRepair(text: string): PlanRepairResult {
  const diagnosis = diagnoseSquare(text);
  if (diagnosis.unfixable) return { diagnosis };

  const actions: RepairAction[] = [];
  const diagnosedFirstIndex = diagnosis.acts[0]?.act.index ?? 0;
  const preservesStableIndexes = diagnosis.acts.every(({ act }, index) => act.index === diagnosedFirstIndex + index);
  const acts: StoredAct[] = diagnosis.acts.map(({ act }, index) => ({
    ...act,
    index: preservesStableIndexes ? act.index! : index,
  }));
  if (!preservesStableIndexes) {
    actions.push({ message: 'renumbered act indexes to be contiguous' });
  }
  if (diagnosis.quarantined.length > 0) {
    actions.push({ message: `quarantined ${diagnosis.quarantined.length} unparseable act block(s)` });
  }
  const nextActIndex = acts.length > 0 ? acts[acts.length - 1].index! + 1 : 0;

  const doc: SquareDoc = {
    hardCap: diagnosis.hardCap,
    throttlePerMinute: diagnosis.throttlePerMinute,
    preamble: diagnosis.preamble,
    warmup: diagnosis.warmup,
    acts,
    runtime: {
      version: 2,
      nextActIndex,
      cursors: {},
      deliveryReceipts: {},
      leases: {},
      notifyLeases: {},
    },
  };

  return { diagnosis, repaired: { doc, actions, quarantinedBlocks: diagnosis.quarantined.map((q) => q.raw) } };
}
