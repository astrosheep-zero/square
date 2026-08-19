import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { automaticSessionEnd, automaticSessionStart } from '../dist/automatic-session.js';

export default async function squareOpenCodePlugin() {
  const joining = new Map();
  return {
    event: async ({ event }) => {
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const sessionID = event.properties?.sessionID;
        const cwd = event.properties?.info?.directory || process.cwd();
        if (sessionID) {
          try {
            const context = await automaticSessionStart('opencode', sessionID, cwd);
            if (context) joining.set(sessionID, context);
          } catch { /* startup remains bounded */ }
        }
      } else if (event.type === 'session.deleted') {
        const sessionID = event.properties?.sessionID;
        const cwd = event.properties?.info?.directory || process.cwd();
        if (sessionID) {
          joining.delete(sessionID);
          await automaticSessionEnd('opencode', sessionID, cwd);
        }
      }
    },
    'shell.env': async (input, output) => {
      if (input.sessionID) output.env.OPENCODE_SESSION_ID = input.sessionID;
    },

    'tool.execute.after': async (input, output) => {
      try {
        const joined = joining.get(input.sessionID);
        if (joined) {
          joining.delete(input.sessionID);
          output.output = `${output.output}${output.output === '' ? '' : '\n\n'}${joined}`;
        }
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
