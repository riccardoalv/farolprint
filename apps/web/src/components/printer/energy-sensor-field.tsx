import { useQuery } from '@tanstack/react-query';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { m } from '@/lib/i18n';
import { appSettingsQuery, haEnergySensorsQuery } from '@/lib/queries';

const NONE = 'none';

export function EnergySensorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const settings = useQuery(appSettingsQuery);
    const ha = settings.data?.homeAssistant;
    const configured = Boolean(ha?.url && ha?.token);
    const sensors = useQuery({ ...haEnergySensorsQuery, enabled: configured });
    const list = sensors.data ?? [];
    const options =
        value && !list.some((s) => s.entityId === value)
            ? [{ entityId: value, name: value, kwh: null }, ...list]
            : list;
    return (
        <div className="grid gap-2">
            <Label>{m.energy_sensor()}</Label>
            {configured ? (
                <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
                    <SelectTrigger className="w-full rounded-full" aria-label={m.energy_sensor()}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={NONE}>{m.energy_sensor_none()}</SelectItem>
                        {options.map((s) => (
                            <SelectItem key={s.entityId} value={s.entityId}>
                                {s.kwh === null ? s.name : `${s.name} · ${m.energy_kwh({ kwh: s.kwh.toFixed(2) })}`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : null}
            <p className="px-4 text-xs text-muted-foreground">
                {configured ? m.energy_sensor_hint() : m.energy_sensor_setup()}
            </p>
            {sensors.isError && <p className="px-4 text-xs text-destructive">{sensors.error.message}</p>}
        </div>
    );
}
