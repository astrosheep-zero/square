// Observe the actual CLI-to-SDK calls while letting the real resource do the work.
import fs from 'node:fs';
import { Square } from '../../dist/square-api.js';

const optionIndex = {
  join: 1, express: 1, catch: 0, history: 0, listen: 1, ignore: 1, unlisten: 1,
  listening: 0, hold: 1, resume: 0, done: 1, status: 0, participants: 0,
};
function traced(resource) {
  return new Proxy(resource, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'participant') return async (...args) => traced(await value.apply(target, args));
      if (typeof value !== 'function') return value;
      if (!Object.hasOwn(optionIndex, key)) return value.bind(target);
      return (...args) => {
        fs.appendFileSync(process.env.SQUARE_JSON_TRACE, `${JSON.stringify({ method: key, options: args[optionIndex[key]] })}\n`);
        return value.apply(target, args);
      };
    },
  });
}
const open = Square.at;
Square.at = async (...args) => traced(await open(...args));
