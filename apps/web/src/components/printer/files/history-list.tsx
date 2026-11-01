import type { PrintJobDto } from '@farolprint/shared';
import { useQuery } from '@tanstack/react-query';
import { Camera, Tag } from 'lucide-react';
import { parseFilename } from '@/lib/filename';
import { formatDate, formatDuration, formatMoney } from '@/lib/format';
import { m } from '@/lib/i18n';
import { failureReasonLabel, jobStatusLabel } from '@/lib/labels';
import { appSettingsQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { confirmationDialogStore } from '@/stores/confirmation-dialog';
import { FailureDialog } from './failure-dialog';

export function HistoryList({
    printerId,
    jobs,
    printerNames,
}: {
    printerId: string;
    jobs: PrintJobDto[];
    printerNames?: Record<string, string>;
}) {
    const settings = useQuery(appSettingsQuery);
    const currency = settings.data?.currency ?? 'EUR';
    if (!jobs.length) return <p className="text-sm text-muted-foreground">{m.history_empty()}</p>;
    const openFailure = (job: PrintJobDto) =>
        confirmationDialogStore.actions.openDialog({
            title: m.history_edit_failure(),
            description: parseFilename(job.filename).name,
            content: <FailureDialog printerId={job.printerId || printerId} job={job} />,
        });
    return (
        <ul className="divide-y divide-border">
            {jobs.map((j) => {
                const failed = j.status === 'cancelled' || j.status === 'error';
                return (
                    <li key={j.id} className="flex items-center gap-4 py-3 text-sm">
                        <span
                            className={cn(
                                'size-2.5 shrink-0 rounded-full',
                                j.status === 'completed'
                                    ? 'bg-primary'
                                    : j.status === 'printing'
                                      ? 'bg-chart-3'
                                      : 'bg-muted-foreground/50',
                            )}
                        />
                        <div className="min-w-0 flex-1">
                            <div className="truncate font-medium" title={j.filename}>
                                {parseFilename(j.filename).name}
                            </div>
                            {failed && (
                                <button
                                    type="button"
                                    onClick={() => openFailure(j)}
                                    className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                                >
                                    <Tag className="size-3" />
                                    {failureReasonLabel(j.failureReason)}
                                    {j.hasSnapshot && <Camera className="size-3" />}
                                    {j.note ? <span className="truncate">· {j.note}</span> : null}
                                </button>
                            )}
                        </div>
                        <span className="text-muted-foreground">
                            {printerNames?.[j.printerId] ? `${printerNames[j.printerId]} · ` : ''}
                            {formatDate(j.startedAt)}
                        </span>
                        <span className="w-20 text-right tabular-nums text-muted-foreground">
                            {formatDuration(j.durationSec ?? 0)}
                        </span>
                        <span className="hidden w-20 text-right tabular-nums text-muted-foreground md:inline">
                            {j.energyKwh === null ? '' : m.energy_kwh({ kwh: j.energyKwh.toFixed(2) })}
                        </span>
                        <span className="hidden w-20 text-right tabular-nums text-muted-foreground sm:inline">
                            {j.cost ? formatMoney(j.cost.total, currency) : ''}
                        </span>
                        <span className="w-16 text-right text-muted-foreground">{jobStatusLabel(j.status)}</span>
                    </li>
                );
            })}
        </ul>
    );
}
