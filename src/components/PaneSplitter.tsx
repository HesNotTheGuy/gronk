import { useCallback, useEffect, useRef } from 'react'

interface Props {
  /** Current pane width as a percentage of the container. */
  percent: number
  onChange: (percent: number) => void
  min?: number
  max?: number
}

/**
 * Drag handle between the conversation and the preview pane.
 *
 * Reports a PERCENTAGE rather than pixels, so the split survives a window
 * resize instead of the preview swallowing the conversation on a narrower
 * screen. The native view needs no involvement: PreviewPane already reports its
 * own bounding box to the main process, so moving the CSS boundary drags the
 * WebContentsView with it.
 *
 * Pointer capture rather than window listeners, so a fast drag that leaves the
 * handle keeps tracking, and releasing outside the window still ends it.
 */
export function PaneSplitter({ percent, onChange, min = 20, max = 75 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max])

  const apply = useCallback(
    (clientX: number) => {
      const parent = ref.current?.parentElement
      if (!parent) return
      const box = parent.getBoundingClientRect()
      if (box.width <= 0) return
      // Distance from the RIGHT edge: the preview is the right-hand pane, so its
      // width grows as the pointer moves left.
      onChange(clamp(((box.right - clientX) / box.width) * 100))
    },
    [clamp, onChange]
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const down = (e: PointerEvent): void => {
      dragging.current = true
      el.setPointerCapture(e.pointerId)
      // Stops the drag selecting text across the conversation behind it.
      e.preventDefault()
    }
    const move = (e: PointerEvent): void => {
      if (dragging.current) apply(e.clientX)
    }
    const up = (e: PointerEvent): void => {
      dragging.current = false
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    }

    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
  }, [apply])

  return (
    <div
      ref={ref}
      className="pane-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      // Keyboard is not decoration here: a pointer drag is the only other way to
      // reach this, which leaves it unusable without a mouse.
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onChange(clamp(percent + 2))
        else if (e.key === 'ArrowRight') onChange(clamp(percent - 2))
        else return
        e.preventDefault()
      }}
    />
  )
}
