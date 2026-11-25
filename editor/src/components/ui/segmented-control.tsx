import * as React from "react"
import { haptic } from "@/lib/haptics"
import { Field, FieldLabel } from "@ui-sdk/react/field"
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control"

// Drag the pill across the segments: it follows the pointer, the segment
// under it is chosen as it passes, and it snaps into place on release. A
// press without movement is left to the segment's own click.
function useSegmentDrag(select: (value: string) => void, commit: () => void) {
  const drag = React.useRef<{ x: number; id: number; moved: boolean } | null>(null)
  const segments = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-kit="segment"]')]

  const follow = (root: HTMLElement, clientX: number) => {
    const all = segments(root)
    if (!all.length) return
    const x = clientX - root.getBoundingClientRect().left
    const under = all.find((segment) => x < segment.offsetLeft + segment.offsetWidth) ?? all[all.length - 1]
    const first = all[0].offsetLeft
    const last = all[all.length - 1].offsetLeft
    const left = Math.min(last, Math.max(first, x - under.offsetWidth / 2))
    root.style.setProperty("--drag-left", `${left}px`)
    if (under.dataset.value) select(under.dataset.value)
  }

  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      drag.current = { x: event.clientX, id: event.pointerId, moved: false }
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const current = drag.current
      if (!current || current.id !== event.pointerId) return
      const root = event.currentTarget
      if (!current.moved) {
        if (Math.abs(event.clientX - current.x) < 4) return
        current.moved = true
        root.setPointerCapture(event.pointerId)
        root.dataset.dragging = ""
      }
      follow(root, event.clientX)
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      const root = event.currentTarget
      if (drag.current?.moved) root.releasePointerCapture(event.pointerId)
      const moved = drag.current?.moved
      drag.current = null
      delete root.dataset.dragging
      root.style.removeProperty("--drag-left")
      if (moved) commit()
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
      const moved = drag.current?.moved
      drag.current = null
      delete event.currentTarget.dataset.dragging
      event.currentTarget.style.removeProperty("--drag-left")
      if (moved) commit()
    },
  }
}

// DeckStudio: options may carry labels, and `value` makes it controlled.
type SegmentOption = string | { value: string; label: React.ReactNode }
function Segmented({
  label,
  options,
  defaultValue,
  value: controlled,
  onValueChange,
  hideLabel,
}: {
  label: string
  options: SegmentOption[]
  defaultValue?: string
  value?: string
  onValueChange?: (value: string) => void
  hideLabel?: boolean
}) {
  const [stored, setValue] = React.useState(defaultValue ?? "")
  // DeckStudio: while dragging, the indicator follows the pointer but nothing is reported until
  // release, and each value is reported once (a controlled value may lag behind the server).
  const [dragValue, setDragValue] = React.useState<string | null>(null)
  const dragging = React.useRef(false)
  const lastSent = React.useRef<string | null>(null)
  const value = dragValue ?? controlled ?? stored
  const report = (next: string) => {
    setValue(next)
    if (next === (controlled ?? stored) || next === lastSent.current) return
    lastSent.current = next
    onValueChange?.(next)
  }
  React.useEffect(() => {
    lastSent.current = null // the controlled value caught up
  }, [controlled])
  const select = (next: string) => {
    if (next !== value) haptic("selection")
    if (dragging.current) return setDragValue(next)
    report(next)
  }
  const drag = useSegmentDrag(
    (next) => {
      dragging.current = true
      select(next)
    },
    () => {
      dragging.current = false
      setDragValue((v) => {
        if (v != null) queueMicrotask(() => report(v))
        return null
      })
    },
  )
  return (
    <Field data-kit="field">
      <FieldLabel data-kit={hideLabel ? "visually-hidden" : "label"}>{label}</FieldLabel>
      <SegmentedControl
        data-kit="segmented"
        value={value}
        onValueChange={(next) => next && select(next)}
        {...drag}
      >
        <SegmentedControlIndicator data-kit="segmented-indicator" />
        {options.map((option) => {
          const { value: v, label: l } = typeof option === "string" ? { value: option, label: option } : option
          return (
            <SegmentedControlItem key={v} value={v} data-kit="segment" data-value={v}>
              <span data-kit="led" aria-hidden />
              {l}
            </SegmentedControlItem>
          )
        })}
      </SegmentedControl>
    </Field>
  )
}

export { Segmented }
