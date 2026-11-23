import type { QueueEta, QueueEtaWait, QueueItemDto } from '@farolprint/shared';
import type { PrinterWithLive } from '@/lib/api';
import { formatEta } from '@/lib/format';
import { m } from '@/lib/i18n';

const ETA_WAIT_LABEL: Record<QueueEtaWait, (inputs: { printer: string }) => string> = {
    bed_clear: m.queue_eta_bed_clear,
    manual: m.queue_eta_manual,
};

export function etaText(
    eta: QueueEta,
    printers: Pick<PrinterWithLive, 'id' | 'name'>[],
    now: string | number | Date = Date.now(),
): string {
    const printer = printers.find((p) => p.id === eta.printerId)?.name ?? eta.printerId;
    if (eta.startAt && eta.endAt) {
        return m.queue_eta_range({ printer, start: formatEta(eta.startAt, now), end: formatEta(eta.endAt, now) });
    }
    if (eta.startAt) return m.queue_eta_start({ printer, start: formatEta(eta.startAt, now) });
    if (eta.wait) return ETA_WAIT_LABEL[eta.wait]({ printer });
    return m.queue_eta_unknown({ printer });
}

export function queueEnd(items: Pick<QueueItemDto, 'eta'>[], printerId: string): string | null {
    const last = items.findLast((item) => item.eta?.printerId === printerId);
    return last?.eta?.endAt ?? null;
}
