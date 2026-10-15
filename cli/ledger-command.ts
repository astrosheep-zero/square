import { gcHostLedger, type LedgerMaintenanceReport } from '../ledger-maintenance.js';
import { migrateHostLedger, verifyHostLedger, type HostLedgerReport } from '../host-ledger-migration.js';
import { type CommandSpec, usage } from './context.js';

type LedgerIntent = { readonly action: 'verify' | 'migrate' } | { readonly action: 'gc'; readonly dryRun: boolean };
type LedgerResult = HostLedgerReport | LedgerMaintenanceReport;

function renderReport(report: HostLedgerReport): string {
  const lines = [
    `host ledger: ${report.status}`,
    `root: ${report.rootPath}`,
    `presence: ${report.presence} · evidence: ${report.evidence}`,
  ];
  if (report.presenceRevision !== undefined) {
    lines.push(`revisions: presence ${report.presenceRevision} · evidence ${report.evidenceRevision}`);
  }
  if (report.status === 'upgraded') lines.push('SQLite schema upgraded in place; records, order and revisions preserved.');
  if (report.ready !== undefined) lines.push(`readiness: ${report.ready ? 'ready' : 'not ready'}`);
  if (report.sources !== undefined) {
    for (const kind of ['presence', 'evidence'] as const) {
      const source = report.sources[kind];
      lines.push(`${kind}.ndjsonl: ${source.records} accepted · ${source.ignored} ignored · ${source.rejected} rejected · sha256 ${source.sha256 ?? 'absent'}`);
    }
  }
  if (report.status === 'legacy') {
    if (report.ready) lines.push(
      'Stop agent sessions and MCP services using Square with this ledger before conversion.',
      'Keep them stopped until migration and verification succeed; then start them with the updated Square version.',
      'Next: migrate, then verify.',
      'square ledger migrate',
      'square ledger verify',
    );
    else lines.push('Unsafe legacy records; conversion refused. Preserve the sources and resolve the rejected records before retrying verification.');
  }
  if (report.status === 'migrated' || report.status === 'upgraded') {
    lines.push('Keep affected sessions and MCP services stopped until verification succeeds.',
      'After verification, start them with the updated Square version.', 'square ledger verify');
  }
  return lines.join('\n') + '\n';
}

/** Counts only: unreadable locations are summarized, never printed, so no payload or credential can leak. */
function renderMaintenance(report: LedgerMaintenanceReport): string {
  return [
    `host ledger: gc${report.dryRun ? ' (dry run)' : ''}`,
    `eligible: ${report.eligible} · retired: ${report.retired} · cas misses: ${report.casMisses}`,
    `unreadable artifacts: ${report.unavailableArtifacts.length}`,
    ...(report.dryRun ? ['Dry run: nothing retired; ledger and artifacts unchanged.'] : []),
    '',
  ].join('\n');
}

export const ledgerCommand: CommandSpec<LedgerIntent, LedgerResult> = {
  parse(argv, context) {
    if (argv[0] === 'gc') {
      if (argv.length === 1) return { action: 'gc', dryRun: false };
      if (argv.length === 2 && argv[1] === '--dry-run') return { action: 'gc', dryRun: true };
      return usage(context.command);
    }
    if (argv.length !== 1 || (argv[0] !== 'verify' && argv[0] !== 'migrate')) usage(context.command);
    return { action: argv[0] };
  },
  execute(intent, context) {
    if (intent.action === 'gc') return gcHostLedger({ env: context.env, dryRun: intent.dryRun });
    const options = { env: context.env };
    return intent.action === 'verify' ? verifyHostLedger(options) : migrateHostLedger(options);
  },
  present(result) {
    if ('dryRun' in result) {
      process.stdout.write(renderMaintenance(result));
      return;
    }
    process.stdout.write(renderReport(result));
    if (result.ready === false) process.exitCode = 2;
  },
};
