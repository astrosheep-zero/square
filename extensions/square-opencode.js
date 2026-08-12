import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';

export default async function squareOpenCodePlugin() {
  return {
    'shell.env': async (input, output) => {
      if (input.sessionID) output.env.OPENCODE_SESSION_ID = input.sessionID;
    },

    'tool.execute.after': async (input, output) => {
      try {
        presentPendingAtBoundary(
          input.sessionID,
          (context) => {
            output.output = `${output.output}${output.output === '' ? '' : '\n\n'}${context}`;
          }
        );
      } catch {
        // A failed admission remains available at a later boundary.
      }
    },
  };
}
