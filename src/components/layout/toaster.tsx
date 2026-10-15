import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { useToastStore } from '@/stores/toast-store';
import { cn } from '@/lib/utils';

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'error' ? TriangleAlert : Info;
        return (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-3 text-sm shadow-lg">
            <Icon className={cn('mt-0.5 size-4 shrink-0', t.tone === 'success' && 'text-success', t.tone === 'error' && 'text-destructive', t.tone === 'info' && 'text-primary')} />
            <p className="flex-1 leading-snug" data-selectable>
              {t.message}
            </p>
            {t.action && (
              <button
                type="button"
                className="shrink-0 text-xs font-semibold text-primary hover:underline"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" aria-label="Dismiss" className="shrink-0 opacity-50 hover:opacity-100" onClick={() => dismiss(t.id)}>
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
