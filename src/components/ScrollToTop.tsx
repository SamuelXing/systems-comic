import { useLayoutEffect } from 'react'
import { useLocation } from 'react-router-dom'

/* A new page should start at the top.

   React Router swaps the component tree but never touches the scroll
   position, so following a link from halfway down the catalog dropped you
   halfway down the deep-dive — chapter 7 of Postgres, before you had read
   chapter 1. Only two pages scrolled themselves; every other route inherited
   wherever the previous one happened to be.

   Keyed on pathname, deliberately not on hash: the deep-dive tables of
   contents are real `#anchor` links, and resetting on every hash change
   would yank the reader back to the top the instant they clicked one. When a
   hash IS present — a shared deep link — the anchor wins.

   The anchor is not necessarily there yet, though. Every deep-dive is a
   lazy chunk, so on a cold load (or a cross-page link such as "Chapter 7 of
   the Kafka deep-dive" from the Postgres page) this effect runs while the
   Suspense fallback is still on screen and getElementById finds nothing;
   the browser's own hash scroll fails for the same reason. So we keep
   looking, one frame at a time, until the element appears or two seconds
   have passed. */
export default function ScrollToTop() {
  const { pathname, hash } = useLocation()

  useLayoutEffect(() => {
    if (!hash) {
      window.scrollTo(0, 0)
      return
    }
    const id = decodeURIComponent(hash.slice(1))
    let cancelled = false
    let frames = 0
    const tryScroll = () => {
      if (cancelled) return
      const el = document.getElementById(id)
      if (el) {
        el.scrollIntoView()
        return
      }
      if (frames++ < 120) requestAnimationFrame(tryScroll)
    }
    tryScroll()
    return () => {
      cancelled = true
    }
  }, [pathname, hash])

  return null
}
