import type { ReactElement } from 'react';
import { useStore } from '../store/store';
import { Toast } from '../components/Toast';
import o from '../components/overlays.module.css';

/** Bottom-centre stack. Newest on top; each toast is Esc-dismissable when focused. */
export function Toaster(): ReactElement | null {
  const toasts = useStore((st) => st.toasts);
  const dismiss = useStore((st) => st.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className={o.toaster} aria-label="Notifications">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}
