import { migrateHostLedger, verifyHostLedger, type HostLedgerReport } from '../host-ledger-migration.js';
import { type CommandSpec, usage } from './context.js';

function renderReport(report: HostLedgerReport): string {
  const lines = [
    `host ledger: ${report.status}`,
    `presence: ${report.presence} · evidence: ${report.evidence}`,
  ];
  if (report.presenceRevision !== undefined) {
    lines.push(`revisions: presence ${report.presenceRevision} · evidence ${report.evidenceRevision}`);
  }
  if (report.ready !== undefined) lines.push(`readiness: ${report.ready ? 'ready' : 'not ready'}`);
  if (report.sources !== undefined) {
    for (const kind of ['presence', 'evidence'] as const) {
      const source = report.sources[kind];
      lines.push(`${kind}.ndjsonl: ${source.records} accepted · ${source.ignored} ignored · ${source.rejected} rejected · sha256 ${source.sha256 ?? 'absent'}`);
    }
  }
  if (report.status === 'legacy') {
    if (report.ready) lines.push('Stop all Square hosts before conversion.', 'square ledger migrate');
    else lines.push('Unsafe legacy records; conversion refused.');
  }
  return lines.join('\n') + '\n';
}

export const ledgerCommand: CommandSpec<'verify' | 'migrate', HostLedgerReport> = {
  parse(argv, context) {
    if (argv.length !== 1 || (argv[0] !== 'verify' && argv[0] !== 'migrate')) usage(context.command);
    return argv[0];
  },
  execute(intent, context) {
    const options = { env: context.env };
    return intent === 'verify' ? verifyHostLedger(options) : migrateHostLedger(options);
  },
  present(result) {
    process.stdout.write(renderReport(result));
    if (result.ready === false) process.exitCode = 2;
  },
};
