interface Props {
  onConfirm: () => void
  onCancel: () => void
  /** The cheap thing, kept reachable — see the note on the third action. */
  onReadOnly: () => void
  /** "6h ago" — the reason the button was offered, repeated where it is spent. */
  reportedAgo: string
}

/**
 * Confirms a wake-up: an MQTT remote command that brings the car's ECUs up so
 * it uploads a fresh reading (api/client.ts::wakeVehicle).
 *
 * Reached from ⟳, and only once the car has been quiet long enough that a
 * re-read cannot help. That is the whole reason this is a dialog rather than
 * the button's plain behaviour: refreshing is free and instant and needs no
 * permission, while this draws on the 12V battery, so the one moment the two
 * swap places is the moment to say what changed.
 *
 * The car's silence is named here rather than the wake's cost alone, because
 * that is the decision being made: a reading this old is the only thing a
 * wake-up can fix, and if it is not old, this dialog does not appear.
 */
export function WakeConfirmModal({ onConfirm, onCancel, onReadOnly, reportedAgo }: Props) {
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
        {/*
          Three actions rather than two, because ⟳ is the only refresh in the
          app: without "Re-read" there would be no way left to ask for a plain
          reading while the car is quiet, and the case where that is worth
          having is real — a car that reported four minutes ago, on a poll
          interval of five, is quiet by the clock and about to answer for free.
        */}
        <div className="sheet-actions">
          <button type="button" className="button is-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button is-quiet" onClick={onReadOnly}>
            Re-read
          </button>
          <button type="button" className="button is-primary" onClick={onConfirm}>
            Wake it
          </button>
        </div>
      </div>
    </div>
  )
}
