interface Props {
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Manual refresh is a `live` read (see App.tsx's liveRefresh), which wakes the
 * car's ECUs to answer rather than serving psa_car_controller's cache — the
 * same cost background polling is throttled to avoid (see useVehicle.ts). A
 * confirm step here is what pull-to-refresh's easy repeatability could not
 * have, short of losing the gesture entirely.
 */
export function RefreshConfirmModal({ onConfirm, onCancel }: Props) {
  return (
    <div className="sheet-backdrop" onClick={onCancel} role="presentation">
      <div
        className="sheet"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm refresh"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Refresh from the car?</h2>
        <p className="note">
          This wakes the car to read live data, which draws on its 12V battery. Background
          updates read the bridge&apos;s last known state instead and never wake it.
        </p>
        <div className="sheet-actions">
          <button type="button" className="button is-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button is-primary" onClick={onConfirm}>
            Refresh anyway
          </button>
        </div>
      </div>
    </div>
  )
}
