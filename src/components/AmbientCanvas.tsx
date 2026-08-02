import { useEffect, useRef } from 'react'
import { useTheme } from '../hooks/useTheme'

export type AmbientMode = 'precondition' | 'lights' | 'horn' | null

interface Props {
  mode: AmbientMode
  /** 1 for a command in flight, lower for a sustained background state. */
  intensity?: number
}

/**
 * Full-screen ambient layer behind the UI, giving each in-flight command its
 * own character:
 *
 *   precondition — warm and cool air streaks wafting across the screen
 *   lights       — soft glows rippling outward
 *   horn         — sharp, fast concentric sound waves
 *
 * Canvas rather than CSS: these are dozens of independently-phased elements,
 * which as DOM nodes would mean dozens of composited layers on a phone.
 *
 * The layer is inert — fixed, pointer-events: none, painted under the app —
 * so it can never intercept a tap meant for a control.
 */
export function AmbientCanvas({ mode, intensity = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const theme = useTheme()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !mode) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const light = theme === 'light'

    let width = 0
    let height = 0
    // Capping DPR: a phone at 3x costs 9x the fill rate for no visible gain
    // on soft, low-contrast gradients.
    const dpr = Math.min(2, window.devicePixelRatio || 1)

    const resize = () => {
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    /** Warm/cool pair for the air streaks; dimmer on a light surface. */
    const warm = light ? '255, 96, 76' : '255, 116, 96'
    const cool = light ? '54, 142, 255' : '104, 178, 255'
    /* Headlights are warm-white; the horn is neutral. Keeps the two ring
       effects distinguishable at a glance even though the motion differs. */
    const glow =
      mode === 'lights'
        ? light
          ? '150, 130, 90'
          : '255, 241, 214'
        : light
          ? '120, 120, 130'
          : '255, 255, 255'

    const streaks = Array.from({ length: 14 }, (_, i) => ({
      y: (i + 0.5) / 14,
      x: Math.random(),
      speed: 0.045 + Math.random() * 0.06,
      amp: 8 + Math.random() * 22,
      freq: 0.004 + Math.random() * 0.005,
      // Long and overlapping, so they read as air moving across the screen
      // rather than as a row of dashes.
      len: 0.4 + Math.random() * 0.45,
      weight: 6 + Math.random() * 16,
      warm: i % 2 === 0,
      phase: Math.random() * Math.PI * 2,
    }))

    const drawStreaks = (t: number, alpha: number) => {
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
      for (const s of streaks) {
        const x = ((s.x + t * s.speed) % 1.4) * width - width * 0.2
        const span = s.len * width
        const baseY = s.y * height

        // Fade in and out along the streak so it has no hard ends.
        const grad = ctx.createLinearGradient(x, 0, x + span, 0)
        const rgb = s.warm ? warm : cool
        const peak = alpha * (light ? 0.16 : 0.3)
        grad.addColorStop(0, `rgba(${rgb}, 0)`)
        grad.addColorStop(0.5, `rgba(${rgb}, ${peak})`)
        grad.addColorStop(1, `rgba(${rgb}, 0)`)

        ctx.strokeStyle = grad
        ctx.lineWidth = s.weight
        ctx.lineCap = 'round'
        ctx.beginPath()
        for (let i = 0; i <= 16; i++) {
          const px = x + (span * i) / 16
          const py = baseY + Math.sin(px * s.freq + s.phase + t * 0.6) * s.amp
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.stroke()
      }
    }

    /** Concentric rings. Soft and slow for lights; thin and fast for the horn. */
    const drawRings = (t: number, alpha: number, sharp: boolean) => {
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
      const cx = width / 2
      const cy = height * 0.42
      const max = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy))
      const period = sharp ? 0.9 : 1.8
      const count = sharp ? 4 : 3

      for (let i = 0; i < count; i++) {
        const progress = ((t / period) + i / count) % 1
        const radius = progress * max
        if (radius < 1) continue
        const fade = 1 - progress
        const a = alpha * fade * (sharp ? 0.5 : 0.32) * (light ? 0.5 : 1)

        if (sharp) {
          // Hard, thin edge — a pressure wave rather than a glow.
          ctx.strokeStyle = `rgba(${glow}, ${a})`
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(cx, cy, radius, 0, Math.PI * 2)
          ctx.stroke()
        } else {
          // Wide, soft band that bleeds on both sides of its own radius.
          const inner = Math.max(0, radius - 90)
          const grad = ctx.createRadialGradient(cx, cy, inner, cx, cy, radius + 40)
          grad.addColorStop(0, `rgba(${glow}, 0)`)
          grad.addColorStop(0.65, `rgba(${glow}, ${a})`)
          grad.addColorStop(1, `rgba(${glow}, 0)`)
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.arc(cx, cy, radius + 40, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    let raf = 0
    const start = performance.now()

    const frame = (now: number) => {
      const t = (now - start) / 1000
      ctx.clearRect(0, 0, width, height)
      const alpha = intensity

      if (mode === 'precondition') drawStreaks(t, alpha)
      else drawRings(t, alpha, mode === 'horn')

      ctx.globalCompositeOperation = 'source-over'
      if (!reduced) raf = requestAnimationFrame(frame)
    }

    // Reduced motion still gets the colour wash, just frozen — the state stays
    // legible without anything moving.
    raf = requestAnimationFrame(frame)

    /*
     * Pre-conditioning can run for many minutes, so this loop would otherwise
     * keep painting on a backgrounded phone for the whole time. rAF is already
     * throttled when hidden, but stopping outright means zero wake-ups.
     */
    const onVisibility = () => {
      cancelAnimationFrame(raf)
      if (document.visibilityState === 'visible') raf = requestAnimationFrame(frame)
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [mode, intensity, theme])

  if (!mode) return null

  return <canvas ref={canvasRef} className={`ambient is-${mode}`} aria-hidden="true" />
}
