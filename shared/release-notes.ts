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
    version: '0.5.2',
    changed: [
      'The sidebar makes it clear where one project’s sessions end and the next begins, and the small print under each session is legible — it was below the readable contrast for text that size.',
      'The account button opens your usage page. It used to say grok.com and quietly re-run sign-in, so it read as a link and did something else. Signing in again lives in Settings, beside sign-out.',
      'The message box is an invitation again rather than a permanent tutorial. Dragging something onto it now says what will happen: an image goes to the agent, a file sends its location — and a file the agent is not allowed to open is marked as such the moment you attach it, instead of after a wasted turn.',
      'A tool run that has finished collapses to a single line instead of a full card. It takes the card back the moment it is worth looking at: still running, failed, expanded, or carrying images.',
      'The row of squares under a turn appears only when something is running or has failed. It used to draw one per step whatever its state, and a row that always looks the same tells you nothing.',
      'A long conversation now says when it has become the expensive way to work. Every turn resends the whole conversation, so cost climbs with length even when nothing is wrong — the same work split across a few sessions is usually far cheaper.'
    ],
    fixed: [
      'Being away from the machine no longer signs you out. A slow network, or the routine moment when your login is refreshed, could make a single check report no account at all — and the app believed it, throwing away the session on screen and demanding a login nobody needed.',
      'The agent count counts agents. Reading a file and checking on a background task were both counted too, so a session with one subagent could read as dozens.',
      'The app no longer disappears when something unexpected goes wrong out of sight. It stays up, your running agents keep going, and it tells you what happened.',
      'An agent that stops responding now gives up and explains itself, instead of leaving the app on a loading screen with no way out but a restart. A turn in progress is never cut off — it takes as long as the work takes.',
      'A conversation that cannot be written to disk says so. Before, everything kept working and the conversation was simply gone at the next launch.',
      'A project folder that was moved, renamed, or carried over from another computer now says so. It used to report that the Grok CLI was missing, sending you to reinstall something that was never broken.'
    ]
  },
  {
    version: '0.5.1',
    changed: [
      'Typing / in the message box now offers the commands this session accepts, and finishes them for you. The list comes from the agent itself, so it only ever shows commands that work here.',
      'Menu buttons use vertical dots. A long title that gets cut off ends in three dots of its own, which sat right beside the old horizontal menu dots and read as two buttons.',
      'The menus in the browse lists are the same control as everywhere else: reachable by keyboard, and dismissing one no longer opens whatever was underneath it.'
    ],
    fixed: [
      'Running out of Grok Build usage now says so, instead of looking like the app crashed and suggesting you try again — which never worked, because a spent balance does not clear by retrying.',
      'Deleting a session from the browse lists asks first, in place, instead of opening a dialog that froze the rest of the app.'
    ]
  },
  {
    version: '0.5.0',
    changed: [
      'Changing the model no longer starts a new conversation. Pick a different model mid-chat and the conversation carries on with it — before, it opened an empty session and left the old one behind.',
      'Settings has a Reasoning effort control. Grok 4.6 can think harder or faster on request, and the levels offered are the ones the model you picked actually has. It applies to new conversations, because the level is chosen when a conversation starts.',
      'Settings now says which model new conversations will use, and offers Follow grok. Following means a newer model reaches you on its own; picking one pins it until you change it back. The screen says which of the two you are on.',
      'The model menu under the message box changes only the conversation in front of you. What new conversations start with is set in Settings.',
      'The usage panel shows the context window of the model in use, as the app is told it.',
      'The list of models stays current while the app is open. When a model is added to or removed from your account, the menus follow without a restart.',
      'After an update, a short note appears once saying what changed. It does not come back until the next release.',
      'The app stops explaining itself once you have used it. The introductory text retires after your first completed conversation.'
    ],
    fixed: [
      'Running out of Grok usage now says so. It used to appear as though the app had failed, and the part of the reply that says how much you have used and when it resets was being dropped before it reached the screen.',
      'Choosing the model you are already using does nothing, instead of replacing the conversation with an empty one.'
    ],
    security: true
  },
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
