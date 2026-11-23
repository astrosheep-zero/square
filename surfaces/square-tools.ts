import * as api from '../api/square-api.js';
import { isSquareError, SquareError } from '../core/model.js';
import type { OperationControl, OperationError } from '../api/types.js';
import { OPERATIONS, issueText, type Input, type OperationBinding } from './operations.js';
import { operationText, renderFailureLines, type FailureReport } from './operation-presentation.js';

export const SQUARE_TOOLS = OPERATIONS.map(operation => ({
  name: operation.name, description: operation.summary, inputSchema: operation.inputSchema, run: operation.run,
}));
type ToolBinding = Pick<OperationBinding, 'cwd' | 'ledgerLocation' | 'clock'> & { identity: ReturnType<OperationBinding['identity']> };

function failureReport(error: unknown, signal?: AbortSignal): FailureReport {
  const normalized: FailureReport = signal?.aborted
    ? { code: 'cancelled', message: 'The Square operation was cancelled' }
    : isSquareError(error)
      ? { code: error.code, message: error.message, facts: error.facts }
      : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
  const operation = error instanceof Error ? (error as OperationError).operation : undefined;
  return operation === undefined ? normalized : { ...normalized, operation };
}

export async function runSquareTool(tool: typeof SQUARE_TOOLS[number], args: Input, control: OperationControl,
  bind: () => Promise<ToolBinding> | ToolBinding,
): Promise<{ text: string; isError?: true }> {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) return { isError: true, text: issueText(parsed.error) };
  let squarePath = typeof args.location === 'string' ? args.location : undefined;
  try {
    const { identity, ...binding } = await bind();
    return { text: await tool.run({ ...binding, api, surface: 'tool', text: operationText, identity: () => identity,
      opened: location => { squarePath = location; } }, parsed.data, control) };
  } catch (error) {
    return { isError: true, text: renderFailureLines(failureReport(error, control.signal), {
      squarePath, name: typeof args.as === 'string' ? args.as : undefined, surface: 'tool',
    }).join('\n') };
  }
}

export function squareToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SQUARE_TOOLS?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false' || raw === 'none') return false;
  throw new SquareError('invalid_args', 'Invalid SQUARE_TOOLS: expected 0, 1, true, false, or none.');
}

export const SQUARE_TOOL_INSTRUCTIONS = 'List nearby squares and your joined names with list. Pass location for a single square. Join once. Then express to speak, and perceive to take in what reached you. History looks back without taking anything in.';
