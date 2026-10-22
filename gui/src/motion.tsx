import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react'
import {animate, MotionConfig, motion, motionValue, useIsPresent, useReducedMotion, useSpring, type Transition, type HTMLMotionProps} from 'motion/react'

// Shared physical responses preserve velocity when an interaction changes direction
export const springs = {
  panel: {type: 'spring', stiffness: 560, damping: 42, mass: 1},
  quick: {type: 'spring', stiffness: 900, damping: 50, mass: .7},
  spatial: {type: 'spring', stiffness: 420, damping: 40, mass: 1},
  canvas: {type: 'spring', stiffness: 480, damping: 44, mass: 1},
} satisfies Record<string, Transition>
export const fade = {duration: .14, ease: [.2, 0, .2, 1]} satisfies Transition

export function StudioMotion({children}: {children: ReactNode}) {
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let pressed: HTMLButtonElement | null = null
    const animations = new Map<HTMLButtonElement, ReturnType<typeof animate>>()
    const respond = (button: HTMLButtonElement, scale: number) => {
      animations.get(button)?.stop()
      const control = animate(button, {scale}, springs.quick)
      animations.set(button, control)
      void control.then(() => {if (animations.get(button) === control) animations.delete(button)})
    }
    const release = () => {
      if (pressed?.isConnected) respond(pressed, 1)
      pressed = null
    }
    const press = (event: PointerEvent | KeyboardEvent) => {
      if (reduced.matches || event instanceof PointerEvent && event.button !== 0) return
      if (event instanceof KeyboardEvent && (event.repeat || ![' ', 'Enter'].includes(event.key))) return
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null
      if (!target || target.disabled || target.closest('[inert]') || target.dataset.motion === 'none') return
      if (event instanceof KeyboardEvent && event.target !== target) return
      release(); pressed = target
      respond(target, target.clientWidth > 160 ? .993 : .973)
    }
    const keyUp = (event: KeyboardEvent) => {if ([' ', 'Enter'].includes(event.key)) release()}
    document.addEventListener('pointerdown', press, true)
    document.addEventListener('pointerup', release, true)
    document.addEventListener('pointercancel', release, true)
    document.addEventListener('keydown', press, true)
    document.addEventListener('keyup', keyUp, true)
    window.addEventListener('blur', release)
    return () => {
      release(); for (const animation of animations.values()) animation.stop()
      document.removeEventListener('pointerdown', press, true)
      document.removeEventListener('pointerup', release, true)
      document.removeEventListener('pointercancel', release, true)
      document.removeEventListener('keydown', press, true)
      document.removeEventListener('keyup', keyUp, true)
      window.removeEventListener('blur', release)
    }
  }, [])
  return <MotionConfig reducedMotion="user" transition={springs.panel}>{children}</MotionConfig>
}

type Camera = {x: number; y: number; scale: number}
export function useStudioCamera() {
  const x = useSpring(0, springs.canvas), y = useSpring(0, springs.canvas), scale = useSpring(1, springs.canvas)
  const reduced = useReducedMotion(), initialized = useRef(false)
  const move = useCallback((next: Camera, direct = false) => {
    const immediate = direct || reduced || !initialized.current
    initialized.current = true
    for (const [value, target] of [[x, next.x], [y, next.y], [scale, next.scale]] as const) {
      if (immediate) value.jump(target)
      else value.set(target)
    }
  }, [x, y, scale, reduced])
  return useMemo(() => ({x, y, scale, move, current: () => ({x: x.get(), y: y.get(), scale: scale.get()})}), [x, y, scale, move])
}

type Box = {x: number; y: number; width: number; height: number}
// A single frame updates nodes, containers and wires together during layout changes
export function useAnimatedGeometry(targets: Record<string, Box>, direct: boolean, namespace: string) {
  const reduced = useReducedMotion()
  const cache = useRef(new Map<string, {values: ReturnType<typeof motionValue<number>>[]; stops: (() => void)[]}>())
  const frame = useRef<number | null>(null), scope = useRef(namespace), latest = useRef(targets), immediate = useRef(direct)
  const [drawn, setDrawn] = useState(targets)
  latest.current = targets; immediate.current = direct || !!reduced
  const signature = JSON.stringify(targets)
  useLayoutEffect(() => {
    const render = () => {
      frame.current = null
      const next: Record<string, Box> = {}
      for (const [id, box] of Object.entries(latest.current)) {
        const entry = cache.current.get(id)
        next[id] = entry ? {x: entry.values[0].get(), y: entry.values[1].get(), width: entry.values[2].get(), height: entry.values[3].get()} : box
      }
      setDrawn(next)
    }
    const schedule = () => {if (!immediate.current && frame.current === null) frame.current = requestAnimationFrame(render)}
    const reset = scope.current !== namespace || immediate.current
    scope.current = namespace
    for (const [id, box] of Object.entries(targets)) {
      let entry = cache.current.get(id)
      const next = [box.x, box.y, box.width, box.height]
      if (!entry) {
        const values = next.map(value => motionValue(value))
        entry = {values, stops: values.map(value => value.on('change', schedule))}
        cache.current.set(id, entry)
      }
      entry.values.forEach((value, index) => {
        if (reset) value.jump(next[index])
        else if (value.get() !== next[index]) void animate(value, next[index], springs.spatial)
      })
    }
    for (const [id, entry] of cache.current) if (!(id in targets)) {
      entry.stops.forEach(stop => stop()); entry.values.forEach(value => value.destroy()); cache.current.delete(id)
    }
    render()
    return () => {if (frame.current !== null) {cancelAnimationFrame(frame.current); frame.current = null}}
  }, [signature, direct, namespace, reduced])
  useEffect(() => () => {
    for (const entry of cache.current.values()) {entry.stops.forEach(stop => stop()); entry.values.forEach(value => value.destroy())}
    cache.current.clear()
  }, [])
  return immediate.current ? targets : Object.fromEntries(Object.entries(targets).map(([id, box]) => [id, drawn[id] || box]))
}

export function PresenceLayer(props: HTMLMotionProps<'div'>) {
  const present = useIsPresent()
  return <motion.div {...props} aria-hidden={!present || props['aria-hidden']} inert={!present || props.inert}/>
}
