import type { Toast } from '../hooks/useCommands'

interface Props {
  toasts: Toast[]
  onDismiss: (id: number) => void
}

export function Toasts({ toasts, onDismiss }: Props) {
  if (!toasts.length) return null

  return (
    <div className="toasts" role="log" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast is-${toast.tone}`}
          onClick={() => onDismiss(toast.id)}
        >
          {toast.message}
        </button>
      ))}
    </div>
  )
}
