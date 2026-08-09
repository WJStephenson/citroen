interface Props {
  onConfirm: () => void
  onCancel: () => void
  /** "6h ago" — the reason the button was offered, repeated where it is spent. */
  reportedAgo: string
}

/**
 * Confirms a wake-up: an MQTT remote command that brings the car's ECUs up so
 * it uploads a fresh reading (api/client.ts::wakeVehicle).
 *
 * This modal used to guard the ⟳ button, on the belief that an ordinary
 * refresh woke the car. It did not — refreshing reads a record Stellantis is
 * already holding, and confirming it taught the wrong lesson twice over: that
 * looking at the car costs something, and that the cost had been paid. So the
 * confirmation moved to the call that genuinely draws on the 12V battery, and
 * the ⟳ button lost its.
 *
 * The car's silence is named here rather than the wake's cost alone, because
 * that is the decision being made: a reading this old is the only thing a
 * wake-up can fix, and if it is not old, there is nothing here worth spending.
 */
export function WakeConfirmModal({ onConfirm, onCancel, reportedAgo }: Props) {
  return (
    <div className="sheet-backdrop" onClick={onCancel} role="presentation">
      <div
        className="sheet"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm wake-up"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Wake the car?</h2>
        <p className="note">
          The car last reported {reportedAgo}. Waking it brings its ECUs up to send a fresh
          reading, which draws on the 12V battery — it is the only thing that gets newer data out
          of a car that has gone quiet, and the only thing in this app that touches it.
        </p>
        <p className="note">It takes up to 90 seconds, and Stellantis rate-limits it.</p>
        <div className="sheet-actions">
          <button type="button" className="button is-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button is-primary" onClick={onConfirm}>
            Wake it
          </button>
        </div>
      </div>
    </div>
  )
}
