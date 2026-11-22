import fs from 'node:fs';
import path from 'node:path';

export interface StagedReplacement {
  rollback(): void;
  finalize(): void;
}

/** Replace a file or directory while retaining the previous value for rollback. */
export function stageReplacement(root: string, populate: (stage: string) => void): StagedReplacement {
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const stage = `${root}.${token}.stage`;
  const backup = `${root}.${token}.previous`;
  let replaced = false;
  let hadOriginal = false;

  fs.mkdirSync(path.dirname(root), { recursive: true });
  try {
    populate(stage);
    hadOriginal = fs.existsSync(root);
    if (hadOriginal) fs.renameSync(root, backup);
    fs.renameSync(stage, root);
    replaced = true;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (hadOriginal && fs.existsSync(backup) && !fs.existsSync(root)) fs.renameSync(backup, root);
    throw error;
  }

  return {
    rollback() {
      if (replaced) fs.rmSync(root, { recursive: true, force: true });
      if (hadOriginal && fs.existsSync(backup)) fs.renameSync(backup, root);
    },
    finalize() {
      fs.rmSync(backup, { recursive: true, force: true });
    },
  };
}
