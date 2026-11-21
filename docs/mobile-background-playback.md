# Background playback in a mobile browser

What the player does so a book keeps playing when the listener leaves the
tab, and what no web app can do. Written for the Android Chrome report
("the media notification disappears after a couple of minutes and playback
can't resume").

## What the player does

One `<audio>` element lives in the root layout
(`src/components/playback-provider.tsx`). It is created once and never
re-created, keyed, or unmounted by a route change. The player page points it
at a source and reports the book clock; walking to Library, Voices, or any
other page leaves the element exactly where it was, and shows a slim mini
player.

The Media Session is installed in the same shell:

- `MediaMetadata` with the book title, the chapter as artist, the voice as
  album, and `icon-512.png` as artwork.
- `play`, `pause`, `seekbackward`, `seekforward`, `seekto`, `previoustrack`,
  and `nexttrack` handlers. They are installed once and read the live page
  actions, so they keep working across books and after the player page
  unmounts.
- `playbackState` (`playing` / `paused`) and `setPositionState` as the
  playhead moves, so the notification's scrubber shows real time.

`src` is never cleared on `pause`, `visibilitychange`, or `pagehide`. It is
released by exactly three things: the mini player's Close button, a
different book's source, and a book that may no longer play.

The listening position keeps moving after the player page unmounts. The page
owns the paced save while it is mounted (local row plus server row, in
`usePlaybackResume`). Once the listener walks to Library, the shell's own
5-second clock (`saveShellResume` in `src/lib/player/shell-resume.ts`) writes
the same `ec-resume:<jobId>` row, on the book clock, and stamps a fresh
`updatedAt` so `preferResume` prefers it. Without that clock the stored
position froze at the moment of navigation and closing the tab from the mini
player reopened the book at that stale spot. Exactly one writer is active at a
time: the shell stands down whenever a page report is mounted.

If the platform frees the buffer of a paused tab — Chrome does this, and the
element then reports `NETWORK_NO_SOURCE` with an empty `currentSrc` — a
Play from the lock screen re-assigns the same `src` to the same element,
waits for metadata, seeks back to the saved position, and only then plays
(`reacquire` in the shell, decided by `shouldReacquireSource`). The element
is the same object, so the platform session survives.

The element is not routed through Web Audio. A cross-origin `<audio>` source
would play silence through a graph, and a graph that is suspended in the
background would mute the session. Any AudioContext the app does open is
tracked (`src/lib/player/audio-graph.ts`) and resumed before a shell Play.

## What browsers allow

| | Android Chrome | iOS Safari | Desktop Chrome / Firefox / Safari |
|--|--|--|--|
| Audio continues when the tab is backgrounded | Yes, while the page is alive | Yes, while the page is alive | Yes |
| Notification / lock-screen controls | Yes, via Media Session | Yes, best effort | Desktop media hub, best effort |
| Survives the browser being swiped away | **No** | **No** | No |
| Continues past ~5 minutes of a *paused* tab | Usually, once resumed with the re-acquire above | Usually | n/a |
| `setPositionState` scrubber | Chrome, Edge | iOS 15+ | Partial |
| `seekto` handler | Chrome 78+ | iOS 15+ | Partial; a missing action is skipped, not fatal |
| Survives an OS low-memory kill of the tab | **No** | **No** | No |

## What cannot be fixed in a mobile browser

1. **A web page is not a native media app.** Once Chrome or Safari discards
   the tab (memory pressure, a long idle period, the user swiping the app
   away), there is no JavaScript left to run and the notification goes with
   it. Spotify keeps playing because its playback is a foreground service in
   the OS, not a page. No web API lets a page register one.
2. **Autoplay after a long pause is not guaranteed.** A resume triggered
   from the notification is a user gesture on Android, so `play()` is
   allowed. A resume triggered by a timer, or by code after the tab has been
   frozen, is not, and some builds reject it silently.
3. **The exact idle time before Chrome parks a paused tab is not
   specified** and varies with the device, its memory, and Chrome's version.
   The re-acquire path makes the resume work when it happens; it cannot stop
   it happening.
4. **iOS reports less.** `setPositionState` and the seek handlers are
   best effort, and the lock screen can show a paused session without the
   scrubber on some versions.
5. **A book made of parts stops at the end of its part** once the player
   page has unmounted: walking to the next part needs the page's own
   handler. The book clock still seeks correctly through the notification
   (the shell keeps the book-clock offset). A finished book is one file and
   does not have this limit.

For uninterrupted background playback over hours, an audio-book listener
needs a native app or a downloaded file played by the platform's own media
app. The web player is the best a page can do, and these are the pieces that
made it materially better.
