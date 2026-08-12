/**
 * What to tell someone after an update.
 *
 * Hand-written, one entry per released version, and deliberately not generated. A
 * generator that reads commit subjects or the changelog will publish whatever is in them,
 * including the one kind of thing that must not be published — see the rule below. Writing
 * these by hand costs a few minutes per release and removes that failure entirely.
 *
 * House style, because these are read by someone who does not know how the app works:
 * no file names, no function names, no internal terms, no issue numbers. Say what the
 * person would have noticed. "Attached images no longer get left behind when you move your
 * data folder" — not the name of the thing that moves them.
 *
 * ── The security rule, which is not negotiable ──────────────────────────────────────
 *
 * Never describe a security fix. Not the mechanism, not the trigger, not what was
 * possible before, not the area of the app. Set `security: true` and the panel prints one
 * line: "Security and stability improvements."
 *
 * The reasoning is specific. The people at risk from a detailed security note are the ones
 * who have NOT updated yet, and on a desktop app that is most of them for days. A note
 * explaining what a fix prevents tells an attacker what to try against everyone still on
 * the old build. Chrome withholds bug detail until most users have the fix; Apple does not
 * describe an issue until a patch is out. Users need to know an update matters. Nobody
 * needs to know why.
 *
 * If you are unsure whether an entry gives something away, leave it out and ask — before
 * it is written into this file, not after.
 */

export interface ReleaseNote {
  version: string
  /** Things the user would notice. */
  changed: string[]
  /** Repairs, described from the outside. */
  fixed: string[]
  /**
   * This release contains security fixes. Prints one fixed line and nothing else about
   * them. Never accompany this with a description.
   */
  security?: boolean
}

/**
 * Newest first. A version with no entry shows nothing, which is what keeps unreleased
 * builds — and the screenshot fixtures, which run as `0.0.0-test` — from showing a panel.
 */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.4.1',
    changed: [],
    fixed: [
      'When a turn fails, the message no longer guesses at why. It said a failure probably meant you were out of usage for the week, which was wrong and sent people to check the wrong thing.',
      'History from one conversation can no longer appear in another. Opening a session while another was still starting up could show you the wrong conversation.'
    ]
  },
  {
    version: '0.4.0',
    changed: [
      'Sessions keep running when you look at another one. Several can run at once, the sidebar marks which are working and which are waiting on you, and each can be stopped on its own.',
      'A message typed while the agent is working is held instead of refused. It sends when the turn finishes, and stopping a turn keeps the rest waiting rather than firing them.',
      'What you have typed stays with the conversation you typed it in — including going back to the home screen and returning.',
      'A Changes panel showing what the agent altered in the open folder, and notes you can keep per project.'
    ],
    fixed: [
      'Reopening a session can no longer replace its history with a shorter copy. This was real: conversations were losing messages.',
      'Long conversations stay fast. Opening one used to read every conversation you had ever had, which on a large store froze the window for about a minute.',
      'Attached images are no longer left behind when you move your data folder.',
      'A sign-in that stalls in the browser no longer switches off the device-code option, which was the way out of it.',
      'Reading an older part of a conversation is no longer interrupted when the session finishes loading.'
    ]
  }
]
