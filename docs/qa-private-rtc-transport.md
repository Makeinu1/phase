# Private preview RTC QA route

This opt-in route is for authorized, owner-only, same-origin two-tab QA. The
bootstrap reads `#phase-qa-rtc=<random-namespace>` before the app renders and
installs the private factory through the existing peer transport selector. With
no fragment, the production PeerJS factory remains selected. A bad opt-in fails
closed rather than falling back to PeerJS.

The two tabs use BroadcastChannel only for bounded JSON SDP and ICE signaling.
Each gameplay connection uses a real ordered RTCDataChannel with
`iceServers: []`; game bytes never go through BroadcastChannel, PeerJS
signaling, STUN, or TURN. Tab identities and the probe panel's host code use
fresh UUIDs; the game UI keeps its existing room-code flow. The room namespace
is a fresh random URL-safe value shared by the two tabs. The transport does not
persist route state; the namespace remains in the URL and may remain in browser
history. The tabs still share the same browser profile,
localStorage, and IndexedDB, so this is not a profile or persistence isolation
test.

## Transport bounds

- Each RTC channel message is at most 16,300 bytes, including a 16-byte private
  fragment header. Larger logical binary messages are ordered and reassembled
  up to 256 KiB. Non-binary, malformed, oversized, reordered, or incomplete
  messages fail the connection; no data is truncated.
- A send is rejected before sending if the estimated buffered data would exceed
  512 KiB. SCTP's negotiated `maxMessageSize` is honored when finite; an
  `Infinity` value is supported because this transport still applies its own
  16,300-byte channel-message limit.
- A connection setup and a partial message each time out after 30 seconds.
  Candidate queues and per-connection candidate sets are capped at 128.
  Recently closed connection IDs are retained up to 256 IDs and 60 seconds to
  reject stale offers; that is a bounded replay window, not durable replay
  protection.
- Signaling input is validated against the namespace, room, peer, and
  connection IDs and bounded before parsing. Snapshots expose connection/ICE
  states and byte/frame counters only, not SDP, ICE candidates, addresses, or
  game payloads.

These limits do not yet prove that the authorized game's setup frame fits in
256 KiB. The later game-UI check must demonstrate a real setup and the intended
interaction over this route before making that claim.

## Stage the private candidate

1. Review and build the candidate client from the exact local commit. Stage its
   web assets through the existing owner-only private Site workflow, keeping
   the current Site and asset location. Do not create a new service, account,
   tunnel, public endpoint, or fixture-data publication. No deployment was
   performed for this change.
2. Use the existing owner-only preview origin in two tabs. In a local terminal,
   generate a fresh value with
   `python3 -c 'import secrets; print(secrets.token_hex(16))'`. Put that same
   32-character value in each tab's URL fragment as
   `#phase-qa-rtc=<fresh-random-value>`. Generate a new value for every run.
   The fragment is local to the browser and is not sent in the HTTP request.
   Do not use the developer console.
3. The private probe panel should appear in both tabs. If it does not, stop.
   A browser API check in a restricted evaluator that returns `undefined` is
   not evidence that a real browser lacks the API; prove availability in the
   private preview itself. The panel stylesheet is part of the same-origin
   client assets; no CSP change is part of this integration.

The known preview snapshot is
`https://phase-private-qa-preview.kiue20002001.chatgpt.site/`, owner-only
11f43/WASM b381, with art, audio, and Draft assets absent. Treat that older
snapshot only as the existing private Site location, not as candidate or current
main-runtime proof.

## Click-through transport probe

1. In tab A, click **Create host**. The panel shows a fresh host code.
2. In tab B, click **Create guest**, enter tab A's host code, and click
   **Connect**. Wait for both panels to show ICE `connected` or `completed`, a
   connected peer, an open ordered data channel, one connection-open event, and
   zero configured ICE servers.
3. In tab B, click **Send 64 KiB binary probe**. The host echoes it in memory.
   Wait until the guest reports **Exact 64 KiB echo received**. Both panels'
   transport snapshots should show one logical frame and 65,536 bytes sent and
   received. No payload is displayed or logged. This verifies a real browser
   data-channel round trip only after it succeeds in the private preview; it
   does not prove game setup or gameplay.
4. Click **Reset** in both tabs. This closes the probe connections and peers.

## Separate game-UI check

Use the existing private preview's established host and direct-code guest flow
for the authorized two-seat fixture. Keep its existing same-origin disabled
lobby endpoint/direct-code routing, choosing the `brokerUrl: null` direct-code
path where that flow exposes it. This QA installer does not change lobby
routing, host setup, or connectivity diagnostics. Do not run the separate
connectivity diagnostics action: its existing code fetches TURN configuration
outside this RTC factory. If the existing UI would use a public broker or
public signaling service, stop instead of treating the probe panel as a
workaround.

After both game seats connect, use the panel's **Live transport connections**
summary to confirm the game connection is still ICE-connected with an open,
ordered channel and to observe bounded frame and byte counters. Separately
confirm the real game setup completed before attributing any in-game result to
the transport. Keep the authorized fixture at 20 life each, empty stack, A's
own Swamp and Thoughtseize, B's empty hand, and no replacement or trigger
modifiers. Use no AI, timers, auto-pass, reload/resume, or reconnect. Record
only pass/fail, browser and candidate identity, connection states, and counters;
do not publish fixture data, payloads, or screenshots containing private game
state.

The two tabs share one profile, localStorage, and IndexedDB. This test does not
prove profile isolation, persistence isolation, reconnect, NAT traversal, or
Internet peer reachability. The in-memory 64 KiB probe is a transport check,
not evidence that the game's setup payload fits the configured cap.

## Rollback

Remove the `#phase-qa-rtc=` fragment and reload to use the unchanged default
transport. To remove the opt-in candidate from the private Site, restore the
prior client assets through the same owner-only workflow. The source installer
does not alter default transport selection without the explicit fragment.
